import { create } from "zustand";
import { attachDocument } from "@/editor/api";
import { executeAction, registerActions } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { editorService, notifications, registerEditorBanner } from "@/workbench/contributions";
import { errorMessage } from "./ops";

const SETTINGS = [".openidea/settings.toml", ".openidea/run.toml", ".openidea/run.local.toml"];

function missingSettings(text: string) {
  const patterns = new Set(text.split(/\r?\n/).map((line) => line.replace(/^\//, "")));
  return SETTINGS.filter((pattern) => !patterns.has(pattern));
}

function settingsSection(patterns: readonly string[]) {
  return [tx("# OpenIDEA project settings and run configurations"), ...patterns, ""].join("\n");
}

export function worktreeIncludeTemplate() {
  return [
    tx("# Files to copy into new worktrees, one Git ignore pattern per line."),
    ".worktreeinclude",
    ".env",
    ".env.local",
    ".env.*.local",
    "local.properties",
    "docker-compose.override.yml",
    "docker-compose.override.yaml",
    "",
    settingsSection(SETTINGS),
  ].join("\n");
}

interface EditSession {
  path: string;
  resume(): void;
  appendSettings(): void;
  cancel(): void;
}

const useIncludeEditor = create<{ session: EditSession | null; canAddSettings: boolean }>(() => ({
  session: null,
  canAddSettings: false,
}));

export function cancelWorktreeIncludeEdit() {
  useIncludeEditor.getState().session?.cancel();
}

/** Routes the editor's return and tab-close events back to the suspended form. */
export function trackWorktreeIncludeEdit(path: string, text: string, reopen: () => void, abort: () => void) {
  cancelWorktreeIncludeEdit();
  const editor = editorService();
  const project = useProject.getState().project;
  const active = () => useIncludeEditor.getState().session === session;
  let working = false;
  const withDocument = async (update: (document: Awaited<ReturnType<typeof attachDocument>>) => Promise<void>) => {
    if (!active() || working) return;
    working = true;
    try {
      const document = await attachDocument(path);
      try {
        if (active()) await update(document);
      } finally {
        document.release();
      }
    } catch (e) {
      if (active())
        notifications().notify({
          group: "vcs",
          level: "error",
          title: "Could not update .worktreeinclude",
          body: errorMessage(e),
        });
    } finally {
      working = false;
    }
  };
  const session: EditSession = {
    path,
    cancel: () => {
      dispose();
      abort();
    },
    resume: () =>
      void withDocument(async (document) => {
        if (document.dirty()) await document.save({ exact: true });
        if (!active()) return;
        dispose();
        reopen();
      }),
    appendSettings: () =>
      void withDocument(async (document) => {
        if (document.readOnly) throw new Error(tx("File is read-only"));
        const content = document.text();
        const patterns = missingSettings(content);
        if (patterns.length) {
          const separator = content ? (content.endsWith("\n") ? "\n" : "\n\n") : "";
          document.edit({ from: content.length, insert: separator + settingsSection(patterns) });
        }
        useIncludeEditor.setState({ canAddSettings: false });
      }),
  };
  const offTabs = editor.onOpenTabsChange?.(() => {
    if (editor.openPaths && !editor.openPaths().includes(path)) session.cancel();
  });
  const offProject = useProject.subscribe((state) => {
    if (state.project !== project) session.cancel();
  });
  const dispose = () => {
    offTabs?.();
    offProject();
    if (active()) useIncludeEditor.setState({ session: null, canAddSettings: false });
  };
  useIncludeEditor.setState({ session, canAddSettings: missingSettings(text).length > 0 });
  return dispose;
}

export function registerWorktreeIncludeEditor() {
  const offActions = registerActions([
    {
      id: "vcs.worktree.returnToDialog",
      title: "Return to New Worktree",
      category: "Git",
      hidden: true,
      run: () => useIncludeEditor.getState().session?.resume(),
    },
    {
      id: "vcs.worktree.addOpenIdeaSettings",
      title: "Add OpenIDEA Settings",
      category: "Git",
      hidden: true,
      run: () => useIncludeEditor.getState().session?.appendSettings(),
    },
  ]);
  const offBanner = registerEditorBanner({
    id: "vcs.worktree.include",
    useBanner(path) {
      const waiting = useIncludeEditor((s) => s.session?.path === path);
      const canAddSettings = useIncludeEditor((s) => s.canAddSettings);
      if (!waiting) return null;
      return {
        text: "Edit the files to copy, then return to New Worktree.",
        actions: [
          ...(canAddSettings
            ? [{ label: "Add OpenIDEA Settings", run: () => void executeAction("vcs.worktree.addOpenIdeaSettings") }]
            : []),
          { label: "Return to New Worktree", run: () => void executeAction("vcs.worktree.returnToDialog") },
        ],
      };
    },
  });
  return () => {
    cancelWorktreeIncludeEdit();
    offBanner();
    offActions();
  };
}
