/**
 * Settings › Git › "Explicitly check for incoming commits on remotes": a quiet
 * background fetch (on project open, then every `incomingCheckInterval` minutes)
 * so the branch widget, the Branches popup and the Project view show incoming
 * commits. Every repository whose branch has an upstream is fetched, one after
 * another. `auto` stops checking a repository for the session after its first
 * failure (credentials needed, offline); `never` disables it.
 */
import { Channel } from "@tauri-apps/api/core";
import { call, commands, isTauri, nextRequestId } from "@/platform/ipc";
import { onWorkflowSettingsChange, workflowSettings } from "@/platform/workflowSettings";
import { logConsole } from "./ops";
import { loadBranches, refreshNow, useVcs } from "./store";

const FIRST_DELAY = 20_000;

const intervalMs = () => workflowSettings().vcs.git.incomingCheckInterval * 60_000;

/**
 * Fetches each of `roots` whose branch has an upstream, one at a time, skipping those in
 * `failed` (a repository that fails is added). Stops when `stale()` turns true or a fetch /
 * pull / push of the user's runs. Returns whether anything was fetched.
 */
export async function fetchIncoming(
  roots: readonly string[],
  failed: Set<string>,
  stale: () => boolean = () => false,
): Promise<boolean> {
  let fetched = false;
  for (const root of roots) {
    if (stale() || useVcs.getState().remoteBusy) break;
    if (failed.has(root)) continue;
    const info = await call(commands.vcsBranchInfo(root)).catch(() => null);
    if (!info?.upstream || stale() || useVcs.getState().remoteBusy) continue;
    const channel = new Channel<string>();
    channel.onmessage = () => undefined;
    try {
      await call(commands.vcsRemote(root, nextRequestId(), { op: "fetch" }, channel));
      fetched = true;
    } catch (e) {
      failed.add(root);
      logConsole(
        "info",
        `Checking for incoming commits in ${root} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return fetched;
}

export function installIncomingCheck(): () => void {
  if (!isTauri()) return () => undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Repositories whose check failed; `auto` leaves them alone for the session. */
  let failed = new Set<string>();
  let root: string | null = null;
  /** Bumped when the project or the setting changes; a check started before stops. */
  let generation = 0;
  let running = false;
  let disposed = false;

  const schedule = (delay: number) => {
    clearTimeout(timer);
    if (disposed) return;
    const mode = workflowSettings().vcs.git.incomingCheck;
    if (mode === "never" || !useVcs.getState().available) return;
    timer = setTimeout(() => void check(), delay);
  };

  const check = async () => {
    // The check already running schedules the next one when it ends.
    if (running) return;
    running = true;
    const started = generation;
    try {
      const s = useVcs.getState();
      if (!s.available) return;
      // `always` retries failed repositories on every check.
      const skip = workflowSettings().vcs.git.incomingCheck === "always" ? new Set<string>() : failed;
      const roots = s.roots.length ? s.roots : s.root ? [s.root] : [];
      const fetched = await fetchIncoming(roots, skip, () => disposed || generation !== started);
      if (fetched && !disposed) {
        await refreshNow();
        if (useVcs.getState().branchesLoaded) void loadBranches().catch(() => undefined);
      }
    } finally {
      running = false;
      schedule(generation === started ? intervalMs() : FIRST_DELAY);
    }
  };

  const restart = () => {
    generation++;
    failed = new Set();
    schedule(FIRST_DELAY);
  };

  const unsubVcs = useVcs.subscribe((s, prev) => {
    if (s.root === root && s.available === prev.available) return;
    root = s.root;
    restart();
  });
  const unsubMode = onWorkflowSettingsChange((w) => w.vcs.git.incomingCheck, restart);
  const unsubInterval = onWorkflowSettingsChange(
    (w) => w.vcs.git.incomingCheckInterval,
    () => {
      if (!running) schedule(intervalMs());
    },
  );
  root = useVcs.getState().root;
  schedule(FIRST_DELAY);
  return () => {
    disposed = true;
    clearTimeout(timer);
    unsubVcs();
    unsubMode();
    unsubInterval();
  };
}
