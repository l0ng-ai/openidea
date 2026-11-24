/**
 * Running git operations: error reporting, console output, network ops with
 * progress / cancellation, and writing text back into working files.
 */
import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { BranchUpdate, FetchRemoteResult, GitOperation, RemoteOp, RequestId, RewrittenCommit } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { tx, txPart, txTemplate } from "@/platform/i18n";
import { AnsiStream, stripAnsi, type Span } from "@/ui/ansi";
import { call, commands, IpcError, isCancelled, nextRequestId } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { attachDocument, editorsFor } from "@/editor/api";
import {
  maybeEditorService,
  notifications,
  toolWindowService,
  type NotificationService,
} from "@/workbench/contributions";
import { cancelTask, upsertTaskSoon, useTasks } from "@/workbench/tasks";
import { progressFraction } from "./model";
import { saveDiffWindows } from "./diffWindowSave";
import { flushChangelists } from "./changelists";
import { pushHistoryRepo, rememberPushTarget } from "./pushHistory";
import { describePush, formatPushOutcomes, partialPushReport, pushedCommits, type RepoPushOutcome } from "./pushReport";
import { cancelIncomingCheck } from "./incomingRequest";
import { beginGitWork, conflictedFiles, currentRepo, refreshNow, repoName, repoOf, useVcs } from "./store";

// ---------------------------------------------------------------------------
// Console (Git tool window → Console tab)

export type ConsoleKind = "cmd" | "out" | "err" | "info";
export interface ConsoleLine {
  id: number;
  time: number;
  kind: ConsoleKind;
  /** The line without escape sequences (copying, searching). */
  text: string;
  /** Its coloured runs, when the output had SGR colours (hook output). */
  spans?: Span[];
}

interface ConsoleState {
  lines: ConsoleLine[];
}

const MAX_LINES = 5000;
let lineSeq = 0;
export const useVcsConsole = create<ConsoleState>(() => ({ lines: [] }));

export function logConsole(kind: ConsoleKind, text: string) {
  const time = Date.now();
  // One stream per output, so a colour set on one line carries to the next.
  const ansi = new AnsiStream();
  const add = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l, i, all) => l.length > 0 || (i > 0 && i < all.length - 1))
    .map((l): ConsoleLine => {
      if (!l.includes("\x1b")) return { id: ++lineSeq, time, kind, text: l };
      const spans = ansi.parse(l);
      return { id: ++lineSeq, time, kind, text: spans.map((s) => s.text).join(""), spans };
    });
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

/** Feedback for an explicit Git command stays visible when background VCS notifications are muted. */
function notify(n: Omit<Parameters<NotificationService["notify"]>[0], "group" | "userInitiated">) {
  // Hook output (linters, test runners) is often coloured; a balloon shows it as plain text.
  notifications().notify({
    ...n,
    body: typeof n.body === "string" ? stripAnsi(n.body) : n.body,
    group: "vcs",
    userInitiated: true,
  });
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
  onError?: (message: string, error: unknown) => boolean | Promise<boolean>;
}

/** Runs `fn`, logging to the console and reporting failures. `undefined` on error. */
export async function runOp<T>(title: string, fn: () => Promise<T>, opts: OpOptions<T> = {}): Promise<T | undefined> {
  logConsole("cmd", title);
  const endWork = beginGitWork();
  try {
    const value = await fn();
    const msg = typeof opts.success === "function" ? opts.success(value) : opts.success;
    if (msg) {
      logConsole("info", msg);
      notify({ level: "info", title: msg });
    }
    return value;
  } catch (e) {
    const message = errorMessage(e);
    logConsole("err", message);
    const handled = opts.onError ? await opts.onError(message, e) : false;
    if (!opts.quiet && !handled)
      notify({
        level: "error",
        title: tx`${txPart(title)} failed`,
        body: message,
        actions: opts.errorActions?.(message),
      });
    return undefined;
  } finally {
    endWork();
    if (opts.refresh !== false) void refreshNow();
  }
}

/** Saves all documents so git sees the editor contents. */
export async function saveAll() {
  try {
    await saveDiffWindows();
  } catch (error) {
    notifications().notify({
      group: "vcs",
      level: "error",
      title: tx("Could not save diff"),
      body: errorMessage(error),
    });
    throw error;
  }
  try {
    await maybeEditorService()?.saveAll();
  } catch {
    // Saving is best effort; git then works on what is on disk.
  }
  await flushChangelists();
}

export function startShelfBatch(roots: readonly (string | null)[], enabled = true) {
  const id = enabled && roots.length > 1 ? crypto.randomUUID() : null;
  const project = useProject.getState().project;
  let finished: Promise<string | null> | undefined;
  async function restore(batch: string) {
    let error: string | null = null;
    await runOp("Restore shelved changes", () => call(commands.vcsFinishShelfBatch(batch, [...roots])), {
      refresh: false,
      onError: async (message) => {
        error = message;
        if (!(await stoppedOnConflicts())) return false;
        void executeAction("vcs.resolveConflicts");
        return true;
      },
    });
    return error;
  }
  return {
    id,
    finish: () => (finished ??= id && useProject.getState().project === project ? restore(id) : Promise.resolve(null)),
  };
}

// ---------------------------------------------------------------------------
// Network operations

const REMOTE_TITLE: Record<RemoteOp["op"], [string, string]> = {
  fetch: ["Fetching", "Fetch"],
  fetchRemote: ["Fetching", "Fetch"],
  fetchPushTarget: ["Fetching remote commits", "Fetch"],
  unshallow: ["Fetching full Git history", "Fetch Full History"],
  pull: ["Updating project", "Update"],
  updateProjectBranch: ["Updating project", "Update"],
  updateSubmodule: ["Updating project", "Update"],
  resetToUpstream: ["Updating project", "Update"],
  pullFrom: ["Pulling", "Pull"],
  push: ["Pushing", "Push"],
  pushSelected: ["Pushing", "Push"],
  forcePushRejected: ["Pushing", "Push"],
  deleteBranch: ["Deleting remote branch", "Delete remote branch"],
  pushBranch: ["Pushing", "Push"],
  pushTag: ["Pushing", "Push"],
  deleteRemoteTag: ["Deleting remote tag", "Delete remote tag"],
  deleteTagOnRemotes: ["Deleting remote tag", "Delete remote tag"],
};

let activeRemote: { taskId: string; cancel: () => void } | null = null;
/** Error message of the last failed remote operation (null after a success / cancel). */
let lastRemoteError: string | null = null;

export function lastRemoteFailure(): string | null {
  return lastRemoteError;
}

export function cancelRemote() {
  if (!activeRemote) return;
  const { taskId, cancel } = activeRemote;
  if (useTasks.getState().tasks.some((t) => t.id === taskId)) cancelTask(taskId);
  else cancel();
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
  /** Failures the caller reports itself (e.g. a rejected push it goes on to update). */
  handled?: (error: unknown) => boolean,
): Promise<boolean> {
  const failures = await runRemoteRound(
    repos.map((repo) => ({ repo, op })),
    detail,
    { handled: handled && ((failures) => failures.length === 1 && handled(failures[0]!.error)) },
  );
  return failures?.length === 0;
}

export interface RemoteTarget<Op extends RemoteOp> {
  repo: string | null;
  op: Op;
  detail?: string;
  /** A submodule depends on its parent repository's update when both are selected. */
  parent?: string | null;
  /** A branch-menu pull updates a checked-out local branch only. */
  requireCurrentBranch?: boolean;
}

export interface RemoteFailure<Op extends RemoteOp> {
  target: RemoteTarget<Op>;
  error: unknown;
}

interface RemoteRoundOptions<Op extends RemoteOp> {
  handled?: (failures: RemoteFailure<Op>[]) => boolean;
  onPushResult?: (result: RepoPushOutcome) => void;
}

function isPush(op: RemoteOp) {
  return ["push", "pushSelected", "pushBranch", "forcePushRejected", "pushTag"].includes(op.op);
}

export function notifyPushResults(outcomes: readonly RepoPushOutcome[], showRepo: boolean) {
  const lines = formatPushOutcomes(outcomes, showRepo);
  const title = showRepo ? tx("Push successful") : (lines.shift() ?? tx("Push successful"));
  notify({ level: "info", key: "vcs.remote", title, body: lines.join("\n") || undefined });
}

export function gitConsoleNotificationAction() {
  const project = useProject.getState().project;
  return {
    label: "Show Git Console",
    run: () => {
      if (useProject.getState().project === project) void executeAction("vcs.showConsole");
    },
  };
}

function pushedBranch(op: RemoteOp) {
  if (op.op === "forcePushRejected") {
    const { source, remote, target } = op.divergence;
    return { source, remote, target };
  }
  if (op.op === "pushSelected" && op.selection.branch && !op.selection.specialRef) {
    const { branch: source, remote, target } = op.selection;
    return { source, remote, target };
  }
  return null;
}

/** Runs one group under the same progress and cancellation, retaining each failed repository's error. */
export async function runRemoteRound<Op extends RemoteOp>(
  targets: readonly RemoteTarget<Op>[],
  detail?: string,
  options: RemoteRoundOptions<Op> = {},
): Promise<RemoteFailure<Op>[] | null> {
  const first = targets[0]?.op;
  if (!first) return [];
  if (useVcs.getState().remoteBusy) {
    notify({ level: "warning", title: "Another remote operation is in progress" });
    return null;
  }
  const [progressText, doneTitle] = REMOTE_TITLE[first.op];
  const isFetch = first.op === "fetch" || first.op === "fetchRemote";
  const project = useProject.getState().project;
  const state = useVcs.getState();
  const primary = state.roots[0] ?? state.root;
  const progressTitle = tx(progressText);
  const request = nextRequestId();
  const taskId = `vcs:${request}`;
  let cancelRequested = false;
  const cancel = () => {
    cancelRequested = true;
    void commands.cancelRequest(request);
  };
  activeRemote = { taskId, cancel };
  useVcs.setState({ remoteBusy: progressTitle });
  const task = (message: string | null, fraction: number | null, done: boolean) =>
    upsertTaskSoon({ id: taskId, title: progressTitle, message, fraction, done, cancel });
  task(detail ?? null, null, false);
  notify({
    level: "info",
    key: "vcs.remote",
    title: `${progressTitle}…`,
    body: detail,
    sticky: true,
    actions: [{ label: "Cancel", run: cancelRemote }],
  });
  const channel = new Channel<string>();
  let lastLine = "";
  channel.onmessage = (line) => {
    logConsole("out", line);
    const text = line.trim();
    if (text && text !== "Done") lastLine = text;
    task(text || null, progressFraction(text), false);
  };
  const shelfBatch = startShelfBatch(
    targets.map((target) => target.repo),
    isUpdate(first),
  );
  try {
    const incoming = cancelIncomingCheck();
    if (incoming) await incoming;
    // Every repository is tried; the failures are reported together. A pull skips the
    // repositories that have nothing to pull from (detached HEAD, e.g. submodules; no upstream).
    const failures: RemoteFailure<Op>[] = [];
    const updated: UpdatedRange[] = [];
    const pushed: RepoPushOutcome[] = [];
    const fetched: Array<FetchRemoteResult & { destination: string }> = [];
    let hasFetchReport = false;
    const recordPush = (repo: string | null, lines: string[]) => {
      const outcome = { repo, lines };
      pushed.push(outcome);
      options.onPushResult?.(outcome);
    };
    let detached = 0;
    const blocked = new Set<string>();
    for (const target of targets) {
      if (cancelRequested || useProject.getState().project !== project) break;
      const { repo, op } = target;
      const root = repo ?? primary;
      if (target.parent && blocked.has(target.parent)) {
        if (root) blocked.add(root);
        logConsole("info", tx`Skipped ${repoName(root ?? target.parent)} because its parent repository did not update`);
        continue;
      }
      const pushedTarget = root ? pushedBranch(op) : null;
      const historyRepo = pushedTarget && root ? pushHistoryRepo(root) : null;
      const rememberTarget = async () => {
        if (!pushedTarget || !historyRepo || !root || useProject.getState().project !== project) return;
        // Setting the upstream can make this destination the default during the push.
        await call(commands.vcsDefaultPushTarget(root, pushedTarget.source))
          .then((destination) => {
            const selection = destination?.selection;
            if (
              useProject.getState().project === project &&
              pushHistoryRepo(root) === historyRepo &&
              (selection?.remote !== pushedTarget.remote || selection.target !== pushedTarget.target)
            ) {
              rememberPushTarget(historyRepo, pushedTarget);
            }
          })
          .catch(() => undefined);
      };
      const name = targets.length > 1 && repo ? repoName(repo) : null;
      const command =
        op.op === "unshallow"
          ? "fetch --unshallow"
          : op.op === "forcePushRejected"
            ? "push --force-with-lease"
            : op.op === "pushBranch" || op.op === "pushSelected"
              ? "push"
              : op.op === "fetchPushTarget" || op.op === "fetchRemote"
                ? "fetch"
                : op.op === "pullFrom" || op.op === "updateProjectBranch"
                  ? "pull"
                  : op.op === "updateSubmodule"
                    ? "submodule update"
                    : op.op;
      const description = target.detail ?? name ?? detail;
      logConsole("cmd", `git ${command}${description ? ` (${description})` : ""}`);
      if ((op.op === "updateProjectBranch" || (op.op === "pull" && !op.expectedBranch)) && targets.length > 1) {
        const info = await call(commands.vcsBranchInfo(repo)).catch(() => null);
        if (info && (!info.head || !info.upstream)) {
          logConsole("info", info.head ? "No upstream branch, skipped" : "Detached HEAD, skipped");
          continue;
        }
      }
      try {
        if (target.requireCurrentBranch) {
          const info = await call(commands.vcsBranchInfo(repo));
          if (!info.head) {
            detached++;
            logConsole("info", "Detached HEAD, skipped");
            continue;
          }
        }
        const before = isUpdate(op) ? await publishedTip(repo, op) : null;
        // Older remote hosts return no push report. Only compare with a known upstream.
        let legacyPush: string | null = null;
        if (
          op.op === "push" ||
          op.op === "pushSelected" ||
          op.op === "forcePushRejected" ||
          (op.op === "pushBranch" && !op.target && !op.remote)
        ) {
          const info = await call(commands.vcsBranchInfo(repo)).catch(() => null);
          const selection = op.op === "pushSelected" ? op.selection : null;
          const same =
            !selection ||
            (selection.revision === null &&
              selection.branch === info?.head &&
              `${selection.remote}/${selection.target}` === info.upstream);
          if (same && info?.upstream && info.ahead > 0) legacyPush = pushedCommits(info.ahead, info.upstream);
        }
        if (cancelRequested || useProject.getState().project !== project) break;
        const remoteOp =
          op.op === "fetchRemote" || (op.op === "fetch" && !op.background) ? { ...op, report: true } : op;
        const report = await call(commands.vcsRemote(repo, request, remoteOp, channel, shelfBatch.id));
        if (report && "remotes" in report) {
          hasFetchReport = true;
          const errors = report.remotes.flatMap((result) => {
            const { remote, error } = result;
            fetched.push({ ...result, destination: name ? `${name} / ${remote}` : remote });
            return error ? [{ ...error, message: `${remote}: ${error.message}` }] : [];
          });
          const firstError = errors[0];
          if (firstError)
            throw new IpcError({ ...firstError, message: errors.map(({ message }) => message).join("\n") });
        } else if (report) recordPush(root, describePush(report));
        else if (isPush(op)) {
          const fallback = op.op === "pushTag" ? tx`Pushed tag ${op.tag} to ${op.remote}` : tx("Push successful");
          recordPush(root, [legacyPush ?? fallback]);
        }
        if (pushedTarget) await rememberTarget();
        const after = before ? await publishedTip(repo, op) : null;
        if (before && after && before !== after) updated.push({ repo, from: before, to: after });
      } catch (e) {
        if (isCancelled(e)) throw e;
        const partial = partialPushReport(e);
        const message = errorMessage(e);
        if (partial) {
          recordPush(root, describePush(partial));
          // A conflicting tag can fail the command even when Git accepted the branch.
          const refused = message.split(/\r?\n/).filter((line) => line.startsWith("!\t"));
          if (
            pushedTarget &&
            refused.length > 0 &&
            refused.every((line) => /^!\t[^\t]*:refs\/tags\//.test(line)) &&
            partial.refs.some(
              (ref) => ref.reference === `refs/heads/${pushedTarget.target}` && ref.status !== "deleted",
            )
          ) {
            await rememberTarget();
          }
        }
        logConsole("err", message);
        if (root) blocked.add(root);
        failures.push({ target, error: e });
      }
    }
    const restoreError = await shelfBatch.finish();
    if (cancelRequested || useProject.getState().project !== project)
      throw new IpcError({ kind: "cancelled", message: "cancelled" });
    const pruned = fetched.flatMap(({ destination, pruned }) => {
      const refs = pruned.join(", ");
      return refs ? [tx`Pruned from ${destination}: ${refs}`] : [];
    });
    if (failures.length) {
      const describeFailures = (items: readonly RemoteFailure<Op>[]) =>
        items
          .map(({ target: { repo, op }, error }) => {
            const message =
              (op.op === "pull" && op.expectedBranch) || op.op === "updateSubmodule"
                ? txTemplate(errorMessage(error))
                : errorMessage(error);
            return targets.length > 1 && repo ? `${repoName(repo)}: ${message}` : message;
          })
          .join("\n");
      lastRemoteError = describeFailures(failures);
      const reported = options.handled?.(failures);
      if (!reported && isUpdate(first)) await refreshNow();
      if (useProject.getState().project !== project) throw new IpcError({ kind: "cancelled", message: "cancelled" });
      const conflictedRoots = new Set(!reported && isUpdate(first) ? conflictedFiles().map((f) => repoOf(f.path)) : []);
      const conflictRepos = new Set<string>();
      const remaining = failures.filter(({ target }) => {
        const root = target.repo ?? primary;
        if (!root || !conflictedRoots.has(root)) return true;
        conflictRepos.add(root);
        return false;
      });
      if (conflictRepos.size) void executeAction("vcs.resolveConflicts", { repositories: [...conflictRepos] });
      if (reported || !remaining.length) {
        notifications().expire?.("vcs.remote");
      } else {
        const partial = remaining.some(({ error }) => !!partialPushReport(error));
        const message =
          partial && targets.length === 1
            ? tx("Git reported an error after publishing these changes.")
            : describeFailures(remaining);
        const successes = isFetch
          ? fetched.filter(({ error }) => !error).map(({ destination }) => tx`Fetched from ${destination}`)
          : formatPushOutcomes(pushed, targets.length > 1);
        const title = isFetch
          ? tx(successes.length ? "Fetch partially failed" : "Fetch failed")
          : successes.length
            ? tx("Push partially failed")
            : first.op === "unshallow"
              ? tx("Could not fetch full Git history")
              : `${doneTitle} failed`;
        notify({
          level: "error",
          key: "vcs.remote",
          title,
          body: successes
            .concat(
              first.op === "unshallow" || first.op === "forcePushRejected" || first.op === "fetchPushTarget"
                ? tx(message)
                : message,
            )
            .concat(pruned)
            .join("\n"),
          actions: partial || isFetch ? [gitConsoleNotificationAction()] : undefined,
        });
      }
      if (!reported && isUpdate(first) && updated.length) await notifyUpdated(updated, "vcs.remote.updated");
      return failures;
    }
    if (restoreError !== null) {
      lastRemoteError = restoreError;
      notifications().expire?.("vcs.remote");
      return null;
    }
    lastRemoteError = null;
    if (detached === targets.length) notify({ level: "info", key: "vcs.remote", title: "Nothing to update" });
    else if (isUpdate(first)) await notifyUpdated(updated);
    else if (pushed.length) {
      if (options.onPushResult) notifications().expire?.("vcs.remote");
      else notifyPushResults(pushed, targets.length > 1);
    } else {
      notify({
        level: "info",
        key: "vcs.remote",
        title: isFetch
          ? tx("Fetch successful")
          : first.op === "unshallow"
            ? tx("Full Git history fetched")
            : `${doneTitle} successful`,
        body: hasFetchReport ? pruned.join("\n") || undefined : lastLine && !/%/.test(lastLine) ? lastLine : undefined,
      });
    }
    return [];
  } catch (e) {
    const cancelled = isCancelled(e);
    const message = errorMessage(e);
    lastRemoteError = cancelled ? null : message;
    logConsole(cancelled ? "info" : "err", cancelled ? `${doneTitle} cancelled` : message);
    // The user asked for it: the progress balloon just goes away.
    if (cancelled) notifications().expire?.("vcs.remote");
    else
      notify({
        level: "error",
        key: "vcs.remote",
        title: `${doneTitle} failed`,
        body: message,
      });
    return null;
  } finally {
    await shelfBatch.finish();
    task(null, 1, true);
    if (activeRemote?.taskId === taskId) {
      activeRemote = null;
      useVcs.setState({ remoteBusy: null });
      void refreshNow();
    }
  }
}

export type RepoBranchUpdate = BranchUpdate & {
  repo: string | null;
};

/**
 * Branches › Update Selected: fast-forwards `branches` of each repository (one fetch per
 * remote), with progress like `runRemote`. Null when it failed or was cancelled (a failure
 * is reported here); otherwise what happened to each branch, for the caller to report.
 */
export async function runBranchUpdates(
  branches: ReadonlyMap<string | null, readonly string[]>,
): Promise<RepoBranchUpdate[] | null> {
  if (useVcs.getState().remoteBusy) {
    notify({ level: "warning", title: "Another remote operation is in progress" });
    return null;
  }
  const progressTitle = tx("Updating branches");
  const project = useProject.getState().project;
  const key = "vcs.branch-update";
  const request = nextRequestId();
  const taskId = `vcs:${request}`;
  useVcs.setState({ remoteBusy: progressTitle });
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    void commands.cancelRequest(request);
  };
  activeRemote = { taskId, cancel };
  const task = (message: string | null, done: boolean) =>
    upsertTaskSoon({ id: taskId, title: progressTitle, message, fraction: done ? 1 : null, done, cancel });
  task(null, false);
  notify({
    level: "info",
    key,
    title: `${progressTitle}…`,
    sticky: true,
    actions: [{ label: "Cancel", run: cancelRemote }],
  });
  const channel = new Channel<string>();
  channel.onmessage = (line) => {
    logConsole("out", line);
    task(line.trim() || null, false);
  };
  const results: RepoBranchUpdate[] = [];
  try {
    const incoming = cancelIncomingCheck();
    if (incoming) await incoming;
    for (const [repo, names] of branches) {
      if (cancelled || useProject.getState().project !== project) break;
      logConsole("cmd", `git update ${names.join(" ")}${repo && branches.size > 1 ? ` (${repoName(repo)})` : ""}`);
      try {
        const updates = await call(commands.vcsUpdateBranches(repo, request, [...names], channel, null));
        results.push(...updates.map((u) => ({ ...u, repo })));
      } catch (error) {
        if (isCancelled(error)) throw error;
        const message = errorMessage(error);
        logConsole("err", message);
        results.push(...names.map((branch) => ({ repo, branch, status: "failed" as const, message })));
      }
    }
    if (cancelled || useProject.getState().project !== project)
      throw new IpcError({ kind: "cancelled", message: "cancelled" });
    lastRemoteError = null;
    return results;
  } catch (e) {
    const cancelled = isCancelled(e);
    lastRemoteError = cancelled ? null : errorMessage(e);
    logConsole(cancelled ? "info" : "err", cancelled ? "Update cancelled" : errorMessage(e));
    if (cancelled) notifications().expire?.(key);
    else notify({ level: "error", key, title: "Update failed", body: errorMessage(e) });
    return null;
  } finally {
    task(null, true);
    if (activeRemote?.taskId === taskId) {
      activeRemote = null;
      useVcs.setState({ remoteBusy: null });
      void refreshNow();
    }
  }
}

interface UpdatedRange {
  repo: string | null;
  from: string;
  to: string;
}

/** Update Project and the operations that bring the branch up to date like it. */
const isUpdate = (op: RemoteOp) =>
  op.op === "pull" ||
  op.op === "pullFrom" ||
  op.op === "resetToUpstream" ||
  op.op === "updateProjectBranch" ||
  op.op === "updateSubmodule";

async function stoppedOnConflicts(): Promise<boolean> {
  await refreshNow();
  return conflictedFiles().length > 0;
}

const headCommit = (repo: string | null) =>
  call(commands.vcsBranchInfo(repo)).then(
    (i) => i.headCommit,
    () => null,
  );

/**
 * Where the branch meets the branch it updates from (their merge base), the start and
 * end of what an update brought in: the incoming commits only, not the local ones a
 * rebase rewrites or the merge commit. HEAD when that branch can't be resolved.
 */
async function publishedTip(repo: string | null, op: RemoteOp): Promise<string | null> {
  const tracked =
    op.op === "pull" ||
    op.op === "updateProjectBranch" ||
    op.op === "resetToUpstream" ||
    (op.op === "pullFrom" && !op.branches.length)
      ? "@{u}"
      : op.op === "pullFrom" && op.branches.length === 1
        ? `refs/remotes/${op.remote}/${op.branches[0]}`
        : null;
  const base = tracked ? await call(commands.vcsMergeBase(repo, "HEAD", tracked)).catch(() => null) : null;
  return base ?? headCommit(repo);
}

/** Counts for a translated sentence: each variant is its own source text, as "{count} files". */
const filesText = (n: number) => (n === 1 ? tx`${n} file` : tx`${n} files`);
const commitsText = (n: number) => (n === 1 ? tx`${n} commit` : tx`${n} commits`);

/**
 * View Commits: an Update Info tab in the Git tool window, the Log of each updated repository
 * limited to the commits the update brought in. Each update opens a tab of its own.
 */
async function openUpdateInfo(updated: readonly UpdatedRange[]) {
  const project = useProject.getState().project;
  const { roots, root } = useVcs.getState();
  const repoRanges = Object.fromEntries(
    updated.flatMap(({ repo, from, to }) => {
      const r = repo ?? roots[0] ?? root;
      return r ? [[r, `${from}..${to}`]] : [];
    }),
  );
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const { openLogTab } = await import("./logStore");
  if (useProject.getState().project !== project) return;
  openLogTab("update", time, "toolWindow", Object.keys(repoRanges), { repoRanges });
  toolWindowService().show("git", true);
}

/** IDEA's Update Project result: "N files updated in M commits" with View Commits. */
export async function notifyUpdated(updated: readonly UpdatedRange[], key = "vcs.remote") {
  const project = useProject.getState().project;
  if (!updated.length) {
    notify({ level: "info", key, title: "All files are up-to-date" });
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
  if (useProject.getState().project !== project) return;
  notify({
    level: "info",
    key,
    title: `${filesText(files)} updated in ${commitsText(commits)}`,
    actions: [
      {
        label: "View Commits",
        run: () => {
          if (useProject.getState().project === project) void openUpdateInfo(updated);
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
  /** Past-tense balloon on success, or null when the caller reports completion. */
  success: string | (() => string) | null;
  successBody?: () => string | undefined;
  /** Title of the error balloon, e.g. "Cherry-pick failed". */
  failure: string;
  /** Called with the failure message; returning true suppresses the error balloon. */
  onError?: (message: string) => boolean | Promise<boolean>;
  /** Links of the success balloon (e.g. Undo), worked out after the status refreshed. */
  successActions?: (rewrite: RewrittenCommit | null) => Promise<{ label: string; run: () => void }[]>;
  /** Links of the error balloon, worked out after the status refreshed. */
  errorActions?: (message: string) => Array<{ label: string; run: () => void }>;
  /** After refresh, report a pause in place of success, or when cancellation leaves work in progress. */
  reportPause?: (cancelled: boolean) => boolean;
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
  let feedback: string | undefined;
  return runGitOperationWith(
    describeOperation(op, repo),
    { ...opts, successBody: () => feedback ?? opts.successBody?.() },
    async ({ request, output }) => {
      const result = await call(commands.vcsOperation(repo, request, op, output()));
      if (result && "emptyCherryPicks" in result && result.emptyCherryPicks !== undefined) {
        const count = result.emptyCherryPicks;
        feedback = result.action === "skip" ? emptyCherryPickFeedback(count, 0) : emptyCherryPickFeedback(0, count);
        return null;
      }
      return result && "head" in result ? result : null;
    },
  );
}

export function emptyCherryPickFeedback(skipped: number, created: number): string | undefined {
  const empty = [];
  if (skipped === 1) empty.push(tx("Skipped one empty commit"));
  else if (skipped > 1) empty.push(tx`Skipped ${skipped} empty commits`);
  if (created === 1) empty.push(tx("Created one empty commit"));
  else if (created > 1) empty.push(tx`Created ${created} empty commits`);
  return empty.join("\n") || undefined;
}

interface GitOperationContext {
  request: RequestId;
  output: () => Channel<string>;
  cancelled: () => boolean;
}

export async function runGitOperationWith(
  description: string | null,
  opts: GitOperationOptions,
  invoke: (context: GitOperationContext) => Promise<RewrittenCommit | null>,
): Promise<boolean> {
  if (!useVcs.getState().remoteBusy) await saveAll();
  if (useVcs.getState().remoteBusy) {
    notify({ level: "warning", title: "Another Git operation is in progress" });
    return false;
  }
  const request = nextRequestId();
  const taskId = `vcs:${request}`;
  const progress = tx(opts.progress);
  const project = useProject.getState().project;
  useVcs.setState({ remoteBusy: progress });
  let cancelRequested = false;
  const cancel = () => {
    cancelRequested = true;
    void commands.cancelRequest(request);
  };
  activeRemote = { taskId, cancel };
  const task = (message: string | null, done: boolean) =>
    upsertTaskSoon({ id: taskId, title: progress, message, fraction: done ? 1 : null, done, cancel });
  task(null, false);
  notify({
    level: "info",
    key: "vcs.operation",
    title: `${progress}…`,
    sticky: true,
    actions: [
      {
        label: "Cancel",
        run: () => {
          if (activeRemote?.taskId === taskId) cancelRemote();
        },
      },
    ],
  });
  if (description) logConsole("cmd", `git ${description}`);
  const output = () =>
    new Channel<string>((line) => {
      logConsole("out", line);
      task(line.trim() || null, false);
    });
  try {
    const incoming = cancelIncomingCheck();
    if (incoming) await incoming;
    if (cancelRequested || useProject.getState().project !== project)
      throw new IpcError({ kind: "cancelled", message: "cancelled" });
    const rewrite = await invoke({ request, output, cancelled: () => cancelRequested });
    let success = opts.success;
    if (opts.reportPause || typeof success === "function") await refreshNow();
    if (opts.reportPause?.(false) || success === null) {
      notifications().expire?.("vcs.operation");
      return true;
    }
    if (typeof success === "function") success = success();
    logConsole("info", success);
    const actions = opts.successActions ? await opts.successActions(rewrite) : undefined;
    notify({ level: "info", key: "vcs.operation", title: success, body: opts.successBody?.(), actions });
    return true;
  } catch (e) {
    const cancelled = isCancelled(e);
    const message = errorMessage(e);
    logConsole(cancelled ? "info" : "err", cancelled ? `${opts.failure}: cancelled` : message);
    notifications().expire?.("vcs.operation");
    await refreshNow();
    if (cancelled) opts.reportPause?.(true);
    const handled = cancelled || (opts.onError ? await opts.onError(message) : false);
    if (!handled)
      notify({
        level: "error",
        key: "vcs.operation",
        title: opts.failure,
        body: tx(message),
        actions: opts.errorActions?.(message),
      });
    return false;
  } finally {
    task(null, true);
    activeRemote = null;
    useVcs.setState({ remoteBusy: null });
    void refreshNow();
  }
}

export function describeOperation(op: GitOperation, repo = currentRepo()): string {
  const operation = repo ? useVcs.getState().operations[repo] : useVcs.getState().branch?.operation;
  switch (op.op) {
    case "finishMerge":
      return "merge --continue";
    case "continue":
    case "abort":
    case "skip":
      return `${operation ?? ""} --${op.op}`.trim();
    case "continueReviewedApply":
      return `${operation ?? ""} --continue`.trim();
    case "stageAndContinue":
      return `add -u && ${operation ?? ""} --continue`.trim();
    case "cherryPick":
      return `cherry-pick ${op.commits.map((c) => c.slice(0, 8)).join(" ")}`;
    case "revert":
      return `revert ${op.commits.map((c) => c.slice(0, 8)).join(" ")}`;
    case "reset":
      return `reset --${op.mode} ${op.commit.slice(0, 8)}`;
    case "interactiveRebase":
      return `rebase --interactive ${op.base ? op.base.slice(0, 8) : "--root"}`;
    case "checkoutRebase":
      return `rebase ${op.plan.base.commit.slice(0, 8)} ${op.plan.branch}`;
    case "rebaseBranch":
      return `rebase ${op.plan.target}`;
    case "dropCommitChanges":
      return `rebase --interactive (drop selected changes from ${op.commit.slice(0, 8)})`;
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
export async function applyFileEdits(path: string, edits: TextEdit[], opts: { save?: boolean; exact?: boolean } = {}) {
  const editor = editorsFor(path)[0];
  if (editor) {
    editor.view.dispatch({ changes: edits, userEvent: "input.vcs", scrollIntoView: true });
    if (opts.save) {
      if (opts.exact) await saveExactText(path);
      else {
        // Let editor/core sync the change to the backend before saving.
        await tick(60);
        await maybeEditorService()?.saveAll();
      }
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
export async function writeFileText(path: string, text: string, opts: { save?: boolean; exact?: boolean } = {}) {
  const current = (await readWorkingText(path)) ?? "";
  if (current === text) {
    if (opts.save) {
      if (opts.exact) await saveExactText(path);
      else await saveAll();
    }
    return;
  }
  await applyFileEdits(path, [{ from: 0, to: current.length, insert: text }], opts);
}

/** Merge results keep their text even when the file is also shown in an editor tab. */
async function saveExactText(path: string) {
  const document = await attachDocument(path);
  try {
    await document.save({ exact: true });
  } finally {
    document.release();
  }
}
