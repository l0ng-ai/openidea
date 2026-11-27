import { activeEditor, editorsFor } from "@/editor/api";
import { setContext } from "@/platform/context";
import { call, commands } from "@/platform/ipc";
import { editorService, notifications, toolWindowService } from "@/workbench/contributions";
import { isUncommitted } from "./blame";
import { revealCommit } from "./logStore";
import { repoOf, statusOf, useVcs } from "./store";
import { repositoryPath } from "./repositoryPaths";

const historyFiles = new Map<string, { head: string | null; files: Set<string> }>();
let availabilityVersion = 0;

/** Status omits ignored files, so only files in HEAD can offer committed history. */
export function trackFileHistory(): () => void {
  let alive = true;
  const refresh = () => {
    const { roots, heads, statusLoaded } = useVcs.getState();
    for (const root of historyFiles.keys()) if (!roots.includes(root)) historyFiles.delete(root);
    if (!statusLoaded) return;
    for (const root of roots) {
      const head = heads[root]?.headCommit ?? null;
      if (historyFiles.get(root)?.head === head) continue;
      const entry = { head, files: new Set<string>() };
      historyFiles.set(root, entry);
      void call(commands.vcsRevisionFiles(root, head ?? "HEAD"))
        .then((files) => {
          if (!alive || historyFiles.get(root) !== entry) return;
          entry.files = new Set(files.map((path) => repositoryPath(root, path)));
          setContext("vcsFileHistoryVersion", ++availabilityVersion);
        })
        .catch(() => undefined);
    }
  };
  const unsubscribe = useVcs.subscribe(refresh);
  refresh();
  return () => {
    alive = false;
    unsubscribe();
    historyFiles.clear();
  };
}

export function hasFileHistory(path: string | null | undefined): boolean {
  if (!path || !useVcs.getState().statusLoaded) return false;
  const repo = repoOf(path);
  if (!repo || !historyFiles.get(repo)?.files.has(path)) return false;
  const status = statusOf(path);
  return ![status?.staged, status?.unstaged].some(
    (kind) => kind === "untracked" || kind === "ignored" || kind === "added" || kind === "deleted",
  );
}

export async function showCurrentRevision(path: string | null | undefined) {
  if (!path || !hasFileHistory(path)) return;
  let handle = activeEditor();
  if (handle?.ctx.path !== path) {
    await editorService().openFile(path, { focus: true });
    handle = editorsFor(path)[0] ?? null;
  }
  const cursor = handle ? null : editorService().activeCursor();
  if (!handle && cursor?.path !== path) return;
  const repo = repoOf(path);
  const state = handle?.view.state;
  const line = state ? state.doc.lineAt(state.selection.main.head).number - 1 : cursor!.line;
  let lines;
  try {
    const text = state ? state.doc.toString() : (await call(commands.docSnapshot(cursor!.doc))).text;
    lines = await call(commands.vcsBlame(path, text, null));
  } catch (e) {
    notifications().notify({
      group: "vcs",
      level: "error",
      title: "Cannot show current revision",
      body: e instanceof Error ? e.message : String(e),
    });
    return;
  }
  if (repoOf(path) !== repo) return;
  const blame = lines[line];
  if (!blame || isUncommitted(blame)) {
    notifications().notify({ group: "vcs", level: "info", title: "The current line has no committed revision" });
    return;
  }
  toolWindowService().show("git", true);
  await revealCommit(blame.commit, repo);
}
