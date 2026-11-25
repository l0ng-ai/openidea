/**
 * Code › Code Cleanup… and Reformat Code on directories or several files (project
 * view): the language servers' fix-all, organize imports and reformat, one file
 * after another (opened, cleaned, saved; tabs opened only for the run are closed
 * again). Cancellable from the Background Tasks popup.
 */
import { attachDocument } from "@/editor/api";
import { cleanupFile, type CleanupOptions as FileCleanupOptions } from "@/editor/lsp/actions";
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

/** Files under `dir` (or only in it, unless `recursive`), skipping ignored, excluded and hidden entries and symlinks. */
export async function walkFiles(
  dir: string,
  readDir: (path: string) => Promise<FileEntry[]>,
  accept: (path: string) => boolean,
  { limit = 5000, recursive = true }: { limit?: number; recursive?: boolean } = {},
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
      if (e.kind === "dir") {
        if (recursive) queue.push(e.path);
      } else if (accept(e.path)) out.push(e.path);
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

/**
 * Saves the file just cleaned up, as it is: save actions (format on save) would redo the
 * whole file after a reformat of only its changed text. Other unsaved files are left alone.
 */
async function saveCleaned(path: string): Promise<void> {
  const document = await attachDocument(path).catch(() => null);
  if (!document) return;
  try {
    await document.save({ exact: true });
  } finally {
    document.release();
  }
}

interface RunSummary {
  /** Files processed before the end or a cancel. */
  done: number;
  /** Files the reformat changed. */
  formatted: number;
  /** Files no formatter handles. */
  noFormatter: string[];
  cancelled: boolean;
}

/**
 * Cleans `files` up one after another as one background task; `null` when another
 * run is going on or the user declined a large run.
 */
async function runOverFiles(
  files: readonly string[],
  task: { id: string; title: string; confirm: string; ok: string },
  options: FileCleanupOptions,
): Promise<RunSummary | null> {
  if (running) return null;
  if (files.length > CONFIRM_ABOVE && !(await confirm({ title: task.title, message: task.confirm, ok: task.ok })))
    return null;
  const editors = maybeEditorService();
  const wasOpen = new Set(editors?.openPaths?.() ?? []);
  const run: { cancelled: boolean } = { cancelled: false };
  running = run;
  const summary: RunSummary = { done: 0, formatted: 0, noFormatter: [], cancelled: false };
  try {
    for (const path of files) {
      if (run.cancelled) break;
      upsertTask({
        id: task.id,
        title: task.title,
        message: nameOf(path),
        fraction: summary.done / files.length,
        done: false,
        cancel: () => (run.cancelled = true),
      });
      const result = await cleanupFile(path, options);
      if (result?.applied) summary.formatted++;
      if (result?.noFormatter) summary.noFormatter.push(path);
      await saveCleaned(path);
      if (!wasOpen.has(path) && (await editors?.closePath?.(path)) === false) {
        run.cancelled = true;
        break;
      }
      summary.done++;
    }
  } finally {
    running = null;
    upsertTask({ id: task.id, title: task.title, message: null, fraction: 1, done: true });
    if (run.cancelled) removeTask(task.id);
  }
  summary.cancelled = run.cancelled;
  return summary;
}

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
  const summary = await runOverFiles(
    files,
    { id: "code.cleanup", title: "Code Cleanup", confirm: tx`Clean up ${files.length} files?`, ok: "Clean Up" },
    options,
  );
  if (!summary) return;
  const { done, cancelled } = summary;
  notifications().notify({
    group: "analysis",
    level: "info",
    title: cancelled
      ? `Code Cleanup cancelled after ${done} of ${files.length} files`
      : `Code Cleanup processed ${done} files`,
    key: "code.cleanup",
  });
}

// ---------------------------------------------------------------------------
// Reformat Code on directories or several files

export interface ReformatOptions {
  /** Include the files in subdirectories of the chosen directories. */
  recursive: boolean;
  optimizeImports: boolean;
  /** File name masks (`*.sh, *.py`; `!` excludes); empty for every file. */
  mask: string;
  /** Only the lines changed since the last commit, in files with uncommitted changes. */
  changedTextOnly: boolean;
}

export interface ReformatTarget {
  path: string;
  dir: boolean;
}

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

function maskRegExp(glob: string): RegExp {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${re}$`, "i");
}

/** Whether a file name matches the comma-separated `mask` (`*.sh, *.py`, `!*.min.js`); an empty mask matches every name. */
export function maskMatcher(mask: string): (name: string) => boolean {
  const globs = mask
    .split(/[,;]/)
    .map((g) => g.trim())
    .filter(Boolean);
  const include = globs.filter((g) => !g.startsWith("!")).map(maskRegExp);
  const exclude = globs.filter((g) => g.startsWith("!")).map((g) => maskRegExp(g.slice(1).trim()));
  return (name) => (!include.length || include.some((re) => re.test(name))) && !exclude.some((re) => re.test(name));
}

/**
 * Whether a file found in a directory is text the IDE knows: an extension or file
 * name of a language, or no extension at all (scripts recognised by their shebang).
 * Anything else (images, archives…) is skipped as binary or data.
 */
async function knownTextFile(): Promise<(path: string) => boolean> {
  const extensions = new Set<string>();
  const names: RegExp[] = [];
  for (const l of await commands.languages()) {
    for (const e of l.extensions) extensions.add(e.replace(/^\./, "").toLowerCase());
    for (const f of l.filenames ?? []) names.push(maskRegExp(f));
  }
  return (path) => {
    const ext = extOf(path);
    return !ext || extensions.has(ext) || names.some((re) => re.test(nameOf(path)));
  };
}

export interface ReformatSources {
  readDir: (path: string) => Promise<FileEntry[]>;
  /** Whether a file found in a directory is text to reformat (selected files always are). */
  isText: (path: string) => boolean;
  /** Files with uncommitted changes. */
  changedFiles: () => Promise<string[]>;
}

/** The files Reformat Code on `targets` (files and directories) touches, sorted. */
export async function reformatTargets(
  targets: readonly ReformatTarget[],
  options: Pick<ReformatOptions, "recursive" | "mask" | "changedTextOnly">,
  sources: ReformatSources,
): Promise<string[]> {
  const mask = maskMatcher(options.mask);
  const accept = (p: string) => sources.isText(p) && mask(nameOf(p));
  const found = new Set<string>();
  for (const t of targets) {
    if (!t.dir) {
      if (mask(nameOf(t.path))) found.add(t.path);
      continue;
    }
    for (const p of await walkFiles(t.path, sources.readDir, accept, { recursive: options.recursive })) found.add(p);
  }
  if (options.changedTextOnly) {
    const changed = new Set(await sources.changedFiles());
    for (const p of found) if (!changed.has(p)) found.delete(p);
  }
  return [...found].sort();
}

/** Reformat Code on directories or several files, as from the project view (⌥⌘L). */
export async function runReformat(targets: readonly ReformatTarget[], options: ReformatOptions): Promise<void> {
  if (!isTauri() || running) return;
  const key = "code.reformatFiles";
  let files: string[];
  try {
    files = await reformatTargets(targets, options, {
      readDir: (p) => call(commands.fsReadDir(p)),
      isText: await knownTextFile(),
      changedFiles,
    });
  } catch (e) {
    notifications().notify({
      group: "analysis",
      level: "warning",
      title: "Reformat Code",
      body: e instanceof Error ? e.message : String(e),
      key,
    });
    return;
  }
  if (!files.length) {
    notifications().notify({
      group: "analysis",
      level: "info",
      title: "Reformat Code",
      body: options.changedTextOnly ? "No changed files to reformat" : "No files to reformat",
      key,
    });
    return;
  }
  const summary = await runOverFiles(
    files,
    { id: key, title: "Reformat Code", confirm: tx`Reformat ${files.length} files?`, ok: "Reformat" },
    {
      fixAll: false,
      optimizeImports: options.optimizeImports,
      reformat: true,
      changedTextOnly: options.changedTextOnly,
    },
  );
  if (!summary) return;
  const { done, formatted, noFormatter, cancelled } = summary;
  const count = noFormatter.length;
  const names = noFormatter.slice(0, 5).map(nameOf).join(", ") + (count > 5 ? ", …" : "");
  notifications().notify({
    group: "analysis",
    level: "info",
    title: cancelled
      ? `Reformat Code cancelled after ${done} of ${files.length} files`
      : `Reformatted ${formatted} of ${files.length} files`,
    body: count ? tx`Skipped ${count} files without a formatter: ${names}` : undefined,
    key,
  });
}
