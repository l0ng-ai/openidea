/**
 * Running git operations: error reporting, console output, network ops with
 * progress / cancellation, and writing text back into working files.
 */
import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { GitOperation, RemoteOp } from "@/bindings";
import { tx } from "@/platform/i18n";
import { call, commands, isCancelled, nextRequestId } from "@/platform/ipc";
import { editorsFor } from "@/editor/api";
import { maybeEditorService, notifications } from "@/workbench/contributions";
import { cancelTask, upsertTaskSoon, useTasks } from "@/workbench/tasks";
import { progressFraction } from "./model";
import { currentRepo, refreshNow, repoName, useVcs } from "./store";

// ---------------------------------------------------------------------------
// Console (Git tool window → Console tab)

export type ConsoleKind = "cmd" | "out" | "err" | "info";
export interface ConsoleLine {
  id: number;
  time: number;
  kind: ConsoleKind;
  text: string;
}

interface ConsoleState {
  lines: ConsoleLine[];
}

const MAX_LINES = 5000;
let lineSeq = 0;
export const useVcsConsole = create<ConsoleState>(() => ({ lines: [] }));

export function logConsole(kind: ConsoleKind, text: string) {
  const time = Date.now();
  const add = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l, i, all) => l.length > 0 || (i > 0 && i < all.length - 1))
    .map((l) => ({ id: ++lineSeq, time, kind, text: l }));
  if (!add.length) return;
  useVcsConsole.setState((s) => {
    const lines = s.lines.concat(add);
    return { lines: lines.length > MAX_LINES ? lines.slice(lines.length - MAX_LINES) : lines };
  });
}

export function clearConsole() {
  useVcsConsole.setState({ lines: [] });
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Local operations

export interface OpOptions<T> {
  /** Success balloon text. */
  success?: string | ((value: T) => string);
  /** Refresh status afterwards (default true). */
  refresh?: boolean;
  /** Extra actions on the error balloon. */
  errorActions?: (message: string) => Array<{ label: string; run: () => void }>;
  /** Don't show an error balloon (the caller handles it). */
  quiet?: boolean;
  /** Called with the failure message; returning true suppresses the error balloon. */
  onError?: (message: string) => boolean | Promise<boolean>;
}

/** Runs `fn`, logging to the console and reporting failures. `undefined` on error. */
export async function runOp<T>(title: string, fn: () => Promise<T>, opts: OpOptions<T> = {}): Promise<T | undefined> {
  logConsole("cmd", title);
  try {
    const value = await fn();
    const msg = typeof opts.success === "function" ? opts.success(value) : opts.success;
    if (msg) {
      logConsole("info", msg);
      notifications().notify({ group: "vcs", level: "info", title: msg });
    }
    return value;
  } catch (e) {
    const message = errorMessage(e);
    logConsole("err", message);
    const handled = opts.onError ? await opts.onError(message) : false;
    if (!opts.quiet && !handled)
      notifications().notify({
        group: "vcs",
        level: "error",
        title: `${title} failed`,
        body: message,
        actions: opts.errorActions?.(message),
      });
    return undefined;
  } finally {
    if (opts.refresh !== false) void refreshNow();
  }
}

/** Saves all documents so git sees the editor contents. */
export async function saveAll() {
  try {
    await maybeEditorService()?.saveAll();
  } catch {
    // Saving is best effort; git then works on what is on disk.
  }
}

// ---------------------------------------------------------------------------
// Network operations

const REMOTE_TITLE: Record<RemoteOp["op"], [string, string]> = {
  fetch: ["Fetching", "Fetch"],
  pull: ["Updating project", "Update"],
  pullFrom: ["Pulling", "Pull"],
  push: ["Pushing", "Push"],
  deleteBranch: ["Deleting remote branch", "Delete remote branch"],
  pushBranch: ["Pushing", "Push"],
  updateBranch: ["Updating branch", "Update"],
};

let activeRemote: number | null = null;
/** Error message of the last failed remote operation (null after a success / cancel). */
let lastRemoteError: string | null = null;

export function lastRemoteFailure(): string | null {
  return lastRemoteError;
}

export function cancelRemote() {
  if (activeRemote === null) return;
  const taskId = `vcs:${activeRemote}`;
  if (useTasks.getState().tasks.some((t) => t.id === taskId)) cancelTask(taskId);
  else void commands.cancelRequest(activeRemote);
}

/** Every repository of the project (Fetch and Update Project act on all of them, as in IDEA). */
export function allRepos(): Array<string | null> {
  const roots = useVcs.getState().roots;
  return roots.length ? roots : [null];
}

/**
 * Runs fetch / pull / push with progress in the status bar and output in the console,
 * in each of `repos` (default: the selected repository) in turn.
 */
export async function runRemote(
  op: RemoteOp,
  detail?: string,
  repos: ReadonlyArray<string | null> = [currentRepo()],
): Promise<boolean> {
  if (useVcs.getState().remoteBusy) {
    notifications().notify({ group: "vcs", level: "warning", title: "Another remote operation is in progress" });
    return false;
  }
  const [progressText, doneTitle] = REMOTE_TITLE[op.op];
  const progressTitle = tx(progressText);
  const request = nextRequestId();
  const taskId = `vcs:${request}`;
  activeRemote = request;
  useVcs.setState({ remoteBusy: progressTitle });
  const cancel = () => void commands.cancelRequest(request);
  const task = (message: string | null, fraction: number | null, done: boolean) =>
    upsertTaskSoon({ id: taskId, title: progressTitle, message, fraction, done, cancel });
  task(detail ?? null, null, false);
  notifications().notify({
    group: "vcs",
    level: "info",
    key: "vcs.remote",
    title: `${progressTitle}…`,
    body: detail,
    sticky: true,
    actions: [{ label: "Cancel", run: cancelRemote }],
  });
  logConsole("cmd", `git ${op.op}${detail ? ` (${detail})` : ""}`);
  const channel = new Channel<string>();
  let lastLine = "";
  channel.onmessage = (line) => {
    logConsole("out", line);
    const text = line.trim();
    if (text) lastLine = text;
    task(text || null, progressFraction(text), false);
  };
  try {
    // Every repository is tried; the failures are reported together. A pull skips the
    // repositories that have nothing to pull from (detached HEAD, e.g. submodules; no upstream).
    const failures: string[] = [];
    const updated: UpdatedRange[] = [];
    for (const repo of repos) {
      const name = repos.length > 1 && repo ? repoName(repo) : null;
      if (name) logConsole("info", name);
      if (op.op === "pull" && repos.length > 1) {
        const info = await call(commands.vcsBranchInfo(repo)).catch(() => null);
        if (info && (!info.head || !info.upstream)) {
          logConsole("info", info.head ? "No upstream branch, skipped" : "Detached HEAD, skipped");
          continue;
        }
      }
      try {
        const before = op.op === "pull" || op.op === "pullFrom" ? await headCommit(repo) : null;
        await call(commands.vcsRemote(repo, request, op, channel));
        const after = before ? await headCommit(repo) : null;
        if (before && after && before !== after) updated.push({ repo, from: before, to: after });
      } catch (e) {
        if (isCancelled(e) || !name) throw e;
        logConsole("err", errorMessage(e));
        failures.push(`${name}: ${errorMessage(e)}`);
      }
    }
    if (failures.length) throw new Error(failures.join("\n"));
    lastRemoteError = null;
    if (op.op === "pull" || op.op === "pullFrom") await notifyUpdated(updated);
    else
      notifications().notify({
        group: "vcs",
        level: "info",
        key: "vcs.remote",
        title: `${doneTitle} successful`,
        body: lastLine && !/%/.test(lastLine) ? lastLine : undefined,
      });
    return true;
  } catch (e) {
    const cancelled = isCancelled(e);
    lastRemoteError = cancelled ? null : errorMessage(e);
    logConsole(cancelled ? "info" : "err", cancelled ? `${doneTitle} cancelled` : errorMessage(e));
    // The user asked for it: the progress balloon just goes away.
    if (cancelled) notifications().expire?.("vcs.remote");
    else
      notifications().notify({
        group: "vcs",
        level: "error",
        key: "vcs.remote",
        title: `${doneTitle} failed`,
        body: errorMessage(e),
      });
    return false;
  } finally {
    task(null, 1, true);
    activeRemote = null;
    useVcs.setState({ remoteBusy: null });
    void refreshNow();
  }
}

interface UpdatedRange {
  repo: string | null;
  from: string;
  to: string;
}

const headCommit = (repo: string | null) =>
  call(commands.vcsBranchInfo(repo)).then(
    (i) => i.headCommit,
    () => null,
  );

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** IDEA's Update Project result: "N files updated in M commits" with View Commits. */
async function notifyUpdated(updated: readonly UpdatedRange[]) {
  if (!updated.length) {
    notifications().notify({ group: "vcs", level: "info", key: "vcs.remote", title: "All files are up-to-date" });
    return;
  }
  let files = 0;
  let commits = 0;
  await Promise.all(
    updated.map(async ({ repo, from, to }) => {
      const [changed, log] = await Promise.all([
        call(commands.vcsDiffRevisions(repo, from, to)).catch(() => []),
        call(
          commands.vcsLog(repo, {
            branch: null,
            path: null,
            author: null,
            text: null,
            range: `${from}..${to}`,
            skip: 0,
            limit: 0,
          }),
        ).catch(() => []),
      ]);
      files += changed.length;
      commits += log.length;
    }),
  );
  notifications().notify({
    group: "vcs",
    level: "info",
    key: "vcs.remote",
    title: `${plural(files, "file")} updated in ${plural(commits, "commit")}`,
    actions: [
      {
        label: "View Commits",
        run: () => {
          const { repo, from, to } = updated.find((u) => u.repo === currentRepo()) ?? updated[0]!;
          void import("./CompareBranches").then((m) => m.showCommitRange("Update Info", from, to, repo));
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Local history operations (continue / abort / cherry-pick / revert / reset)

export interface GitOperationOptions {
  /** Status bar / balloon text while running, e.g. "Cherry-picking". */
  progress: string;
  /** Past-tense balloon on success, e.g. "Cherry-picked abc123"; a function is called after the status refreshed. */
  success: string | (() => string);
  /** Title of the error balloon, e.g. "Cherry-pick failed". */
  failure: string;
  /** Called with the failure message; returning true suppresses the error balloon. */
  onError?: (message: string) => boolean | Promise<boolean>;
}

/**
 * Runs a long local git operation like `runRemote`: progress in the status bar,
 * output in the Git console, a sticky balloon with Cancel.
 */
export async function runGitOperation(
  op: GitOperation,
  opts: GitOperationOptions,
  repo = currentRepo(),
): Promise<boolean> {
  if (useVcs.getState().remoteBusy) {
    notifications().notify({ group: "vcs", level: "warning", title: "Another Git operation is in progress" });
    return false;
  }
  await saveAll();
  const request = nextRequestId();
  const taskId = `vcs:${request}`;
  activeRemote = request;
  const progress = tx(opts.progress);
  useVcs.setState({ remoteBusy: progress });
  const cancel = () => void commands.cancelRequest(request);
  const task = (message: string | null, done: boolean) =>
    upsertTaskSoon({ id: taskId, title: progress, message, fraction: done ? 1 : null, done, cancel });
  task(null, false);
  notifications().notify({
    group: "vcs",
    level: "info",
    key: "vcs.operation",
    title: `${progress}…`,
    sticky: true,
    actions: [{ label: "Cancel", run: cancelRemote }],
  });
  logConsole("cmd", `git ${describeOperation(op)}`);
  const channel = new Channel<string>();
  channel.onmessage = (line) => {
    logConsole("out", line);
    task(line.trim() || null, false);
  };
  try {
    await call(commands.vcsOperation(repo, request, op, channel));
    let success = opts.success;
    if (typeof success === "function") {
      await refreshNow();
      success = success();
    }
    logConsole("info", success);
    notifications().notify({ group: "vcs", level: "info", key: "vcs.operation", title: success });
    return true;
  } catch (e) {
    const cancelled = isCancelled(e);
    const message = errorMessage(e);
    logConsole(cancelled ? "info" : "err", cancelled ? `${opts.failure}: cancelled` : message);
    notifications().expire?.("vcs.operation");
    await refreshNow();
    const handled = cancelled || (opts.onError ? await opts.onError(message) : false);
    if (!handled)
      notifications().notify({
        group: "vcs",
        level: "error",
        key: "vcs.operation",
        title: opts.failure,
        body: message,
      });
    return false;
  } finally {
    task(null, true);
    activeRemote = null;
    useVcs.setState({ remoteBusy: null });
    void refreshNow();
  }
}

export function describeOperation(op: GitOperation): string {
  switch (op.op) {
    case "continue":
    case "abort":
    case "skip":
      return `${useVcs.getState().branch?.operation ?? ""} --${op.op}`.trim();
    case "cherryPick":
      return `cherry-pick ${op.commits.map((c) => c.slice(0, 8)).join(" ")}`;
    case "revert":
      return `revert ${op.commits.map((c) => c.slice(0, 8)).join(" ")}`;
    case "reset":
      return `reset --${op.mode} ${op.commit.slice(0, 8)}`;
    case "interactiveRebase":
      return `rebase --interactive ${op.base ? op.base.slice(0, 8) : "--root"}`;
  }
}

// ---------------------------------------------------------------------------
// Working file text

export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

/** Current text of a working file: the open editor's buffer, else the file (read-only). */
export async function readWorkingText(path: string): Promise<string | null> {
  const editor = editorsFor(path)[0];
  if (editor) return editor.view.state.doc.toString();
  try {
    return await call(commands.fsReadText(path));
  } catch {
    return null;
  }
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Applies edits (in the coordinates of `readWorkingText(path)`) to a working
 * file: through the open editor (one undoable transaction) or, when the file
 * isn't open, through a transient backend document that is saved.
 */
export async function applyFileEdits(path: string, edits: TextEdit[], opts: { save?: boolean } = {}) {
  const editor = editorsFor(path)[0];
  if (editor) {
    editor.view.dispatch({ changes: edits, userEvent: "input.vcs", scrollIntoView: true });
    if (opts.save) {
      // Let editor/core sync the change to the backend before saving.
      await tick(60);
      await maybeEditorService()?.saveAll();
    }
    return;
  }
  const info = await call(commands.docOpen(path));
  try {
    await call(commands.docEdit(info.id, info.version, { changes: [...edits].sort((a, b) => a.from - b.from) }));
    await call(commands.docSave(info.id));
  } finally {
    void commands.docClose(info.id);
  }
}

/** Replaces the whole content of a working file. */
export async function writeFileText(path: string, text: string, opts: { save?: boolean } = {}) {
  const current = (await readWorkingText(path)) ?? "";
  if (current === text) {
    if (opts.save) await saveAll();
    return;
  }
  await applyFileEdits(path, [{ from: 0, to: current.length, insert: text }], opts);
}
