/**
 * Code › Code Cleanup…: the language servers' fix-all, organize imports and
 * reformat over a scope, one file after another (opened, cleaned, saved; tabs
 * opened only for the cleanup are closed again). Cancellable from the
 * Background Tasks popup.
 */
import { executeAction } from "@/platform/actions";
import { call, commands, isTauri, type FileEntry } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { maybeEditorService, notifications } from "@/workbench/contributions";
import { confirm } from "@/workbench/messages";
import { removeTask, upsertTask } from "@/workbench/tasks";
import { changedFiles, currentFile, type ScopeChoice } from "./scope";
import { tx } from "@/platform/i18n";

export interface CleanupOptions {
  fixAll: boolean;
  optimizeImports: boolean;
  reformat: boolean;
}

/** Above this many files the user confirms first. */
const CONFIRM_ABOVE = 100;

const extOf = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
};

/** Extensions of languages that have a language server (the only files a cleanup can change). */
async function serverExtensions(): Promise<Set<string>> {
  const out = new Set<string>();
  for (const l of await commands.languages())
    if (l.languageServers?.length) for (const e of l.extensions) out.add(e.replace(/^\./, "").toLowerCase());
  return out;
}

/** Files under `dir`, skipping ignored, excluded and hidden entries and symlinks. */
export async function walkFiles(
  dir: string,
  readDir: (path: string) => Promise<FileEntry[]>,
  accept: (path: string) => boolean,
  limit = 5000,
): Promise<string[]> {
  const out: string[] = [];
  const queue = [dir];
  while (queue.length && out.length < limit) {
    let entries: FileEntry[];
    try {
      entries = await readDir(queue.shift()!);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.ignored || e.excluded || e.hidden || e.kind === "symlink") continue;
      if (e.kind === "dir") queue.push(e.path);
      else if (accept(e.path)) out.push(e.path);
    }
  }
  return out.sort();
}

/** The files of `choice` a cleanup applies to, or a message why there are none. */
export async function cleanupFiles(choice: ScopeChoice): Promise<string[] | string> {
  const root = useProject.getState().project?.root;
  if (!root) return "No project is open";
  const exts = await serverExtensions();
  const accept = (p: string) => exts.has(extOf(p));
  const readDir = (p: string) => call(commands.fsReadDir(p));
  let files: string[];
  switch (choice.kind) {
    case "file": {
      const f = currentFile();
      files = f ? [f] : [];
      break;
    }
    case "changed":
      files = (await changedFiles()).filter(accept);
      break;
    case "directory":
      files = choice.directory.trim() ? await walkFiles(choice.directory.trim(), readDir, accept) : [];
      break;
    default:
      files = await walkFiles(root, readDir, accept);
  }
  return files.length ? files : "No files with a language server in this scope";
}

let running: { cancelled: boolean } | null = null;

export async function runCodeCleanup(choice: ScopeChoice, options: CleanupOptions): Promise<void> {
  if (!isTauri() || running) return;
  const files = await cleanupFiles(choice);
  if (typeof files === "string") {
    notifications().notify({
      group: "analysis",
      level: "warning",
      title: "Code Cleanup",
      body: files,
      key: "code.cleanup",
    });
    return;
  }
  if (
    files.length > CONFIRM_ABOVE &&
    !(await confirm({ title: "Code Cleanup", message: tx`Clean up ${files.length} files?`, ok: "Clean Up" }))
  )
    return;
  const editors = maybeEditorService();
  const wasOpen = new Set(editors?.openPaths?.() ?? []);
  const run: { cancelled: boolean } = { cancelled: false };
  running = run;
  const id = "code.cleanup";
  let done = 0;
  try {
    for (const path of files) {
      if (run.cancelled) break;
      upsertTask({
        id,
        title: "Code Cleanup",
        message: path.slice(path.lastIndexOf("/") + 1),
        fraction: done / files.length,
        done: false,
        cancel: () => (run.cancelled = true),
      });
      await executeAction("code.cleanupFile", { path, ...options });
      await editors?.saveAll();
      if (!wasOpen.has(path) && (await editors?.closePath?.(path)) === false) {
        run.cancelled = true;
        break;
      }
      done++;
    }
  } finally {
    running = null;
    upsertTask({ id, title: "Code Cleanup", message: null, fraction: 1, done: true });
    if (run.cancelled) removeTask(id);
  }
  notifications().notify({
    group: "analysis",
    level: "info",
    title: run.cancelled
      ? `Code Cleanup cancelled after ${done} of ${files.length} files`
      : `Code Cleanup processed ${done} files`,
    key: "code.cleanup",
  });
}
