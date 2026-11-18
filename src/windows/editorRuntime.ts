import type { EditorInput } from "@/workbench/contributions";
import {
  registerExternalFileOpenHandler,
  registerFileEditorProvider,
  resolveFileEditor,
  useContributions,
  provideEditorRuntime,
} from "@/workbench/contributions";
import { preloadComponent } from "@/ui/lazy";
import { call, commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { openWithSystemApp } from "@/platform/fileManager";
import { associatedApplication, isImagePath, isMarkdownPath, wantsHexView } from "@/features/viewers/fileKinds";
import { tx } from "@/platform/i18n";

type Stop = () => void;
type Feature = { activate(): void | Stop | Promise<void | Stop> };
const VCS = new Set(["diff", "git-revision", "git-log", "git-merge-diff", "merge", "localHistory", "selectionHistory"]);

/** One capability loader per window. Project-wide workers stay in their project owner. */
export function createEditorRuntime() {
  const loaded = new Map<string, Promise<void>>();
  const stops: Stop[] = [];
  let disposed = false;
  const once = (id: string, load: () => Promise<Feature>) => {
    if (disposed) return Promise.resolve();
    let pending = loaded.get(id);
    if (!pending) {
      pending = load()
        .then(async (feature) => {
          if (disposed) return;
          const stop = await feature.activate();
          if (stop) {
            if (disposed) stop();
            else stops.push(stop);
          }
        })
        .catch((error) => {
          if (loaded.get(id) === pending) loaded.delete(id);
          throw error;
        });
      loaded.set(id, pending);
    }
    return pending;
  };
  const vcs = (input: EditorInput) =>
    once("vcs", async () => {
      const feature = await import("@/features/vcs");
      return { activate: () => feature.activateEditorRuntime(input) };
    });
  const prepare = async (input: EditorInput): Promise<void> => {
    const kind = input.kind;
    const text = kind === "file" || kind === "virtual";
    if (text || kind === "notebook" || kind === "diff" || kind === "merge") {
      await once("editor-lsp", () => import("@/editor/lsp"));
      await once("templates", () => import("@/features/templates"));
      await once("vim", () => import("@/features/vim"));
      await once("code-insight", () => import("@/features/code-insight"));
    }
    if (text || VCS.has(kind)) await vcs(input);
    if (kind === "git-log")
      await once("git-log-model", async () => {
        const feature = await import("@/features/vcs/logStore");
        return { activate: () => feature.installGitLog({ persistSession: false }) };
      });
    if (kind === "image" || kind === "binary" || (text && isMarkdownPath(input.path ?? "")))
      await once("viewers", () => import("@/features/viewers"));
    if (kind === "notebook") await once("notebook", () => import("@/features/notebook"));
    if (text && /\.sql$/i.test(input.path ?? "")) await once("database", () => import("@/features/database"));
    if (kind === "pluginEditor") await once("plugins", () => import("@/features/plugins"));
    const editor = useContributions.getState().editorKinds.get(kind);
    if (!editor && !text) throw new Error(tx("This editor is not available in this window"));
    if (editor) await preloadComponent(editor.component);
  };
  stops.push(provideEditorRuntime(prepare));
  // The ordinary file-open pipeline can discover additional editor kinds later.
  stops.push(
    registerFileEditorProvider({
      id: "editorRuntime.capabilities",
      order: -100,
      resolve: async (path, context) => {
        if (/\.ipynb$/i.test(path)) await prepare({ kind: "notebook", key: `notebook:${path}`, path });
        else if (isImagePath(path) || isMarkdownPath(path) || wantsHexView(await call(commands.fsProbe(path))))
          await once("viewers", () => import("@/features/viewers"));
        else return null;
        const result = await resolveFileEditor(path, "editorRuntime.capabilities");
        if (result) context.onAdmission(result.admit, result.rollback);
        return result?.input ?? null;
      },
    }),
    registerExternalFileOpenHandler({
      id: "editorRuntime.associatedApps",
      order: 0,
      matches: (path) =>
        associatedApplication(path, useProject.getState().settings?.files?.associatedApplications ?? []),
      open: openWithSystemApp,
    }),
  );
  return {
    prepare,
    dispose() {
      if (disposed) return;
      disposed = true;
      stops
        .splice(0)
        .reverse()
        .forEach((stop) => stop());
      loaded.clear();
    },
  };
}
