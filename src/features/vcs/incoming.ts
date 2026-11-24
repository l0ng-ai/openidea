import { isCancelled, isTauri } from "@/platform/ipc";
import { useRemote } from "@/platform/remote";
import { onWorkflowSettingsChange, workflowSettings } from "@/platform/workflowSettings";
import { cancelIncomingCheck, fetchIncomingRemotes, inspectIncomingRefs } from "./incomingRequest";
import { errorMessage, logConsole } from "./ops";
import { refreshNow, useVcs } from "./store";

const FIRST_DELAY = 20_000;

const intervalMs = () => workflowSettings().vcs.git.incomingCheckInterval * 60_000;

/** Null represents a repository-wide failure, including on hosts without fetch reports. */
type DeferredRemotes = Map<string, Set<string | null>>;

export async function fetchIncoming(
  roots: readonly string[],
  deferred: DeferredRemotes,
  stale: () => boolean = () => false,
): Promise<boolean> {
  let fetched = false;
  const interrupted = () => stale() || !!useVcs.getState().remoteBusy;
  for (const root of roots) {
    if (interrupted()) break;
    const skipped = deferred.get(root);
    if (skipped?.has(null)) {
      deferred.delete(root);
      continue;
    }
    try {
      const report = await fetchIncomingRemotes(
        root,
        [...(skipped ?? [])].filter((remote) => remote !== null),
      );
      if (interrupted()) break;
      deferred.delete(root);
      if (!report) {
        fetched = true;
        continue;
      }
      const failures = new Set<string | null>();
      for (const { remote, error, pruned } of report.remotes) {
        if (!error || pruned.length) fetched = true;
        if (error) {
          failures.add(remote);
          logConsole("info", `Checking for incoming commits in ${root} (${remote}) failed: ${error.message}`);
        }
      }
      if (failures.size) deferred.set(root, failures);
    } catch (e) {
      if (isCancelled(e) || interrupted()) break;
      deferred.set(root, new Set([null]));
      logConsole("info", `Checking for incoming commits in ${root} failed: ${errorMessage(e)}`);
    }
  }
  return fetched;
}

async function checkIncoming(roots: readonly string[], stale: () => boolean) {
  const remote = useRemote.getState().session;
  if (remote && !remote.commands.includes("vcs_check_incoming")) return;
  const interrupted = () => stale() || !!useVcs.getState().remoteBusy;
  for (const root of roots) {
    if (interrupted()) break;
    try {
      const report = await inspectIncomingRefs(root);
      if (interrupted()) break;
      useVcs.setState((state) => {
        const unfetched = new Map(state.unfetched);
        if (report.branches.length)
          unfetched.set(root, new Map(report.branches.map((branch) => [branch.branch, branch])));
        else if (!unfetched.delete(root)) return state;
        return { unfetched };
      });
      for (const { remote, error } of report.errors) {
        logConsole("info", `Checking for incoming commits in ${root} (${remote}) failed: ${error.message}`);
      }
    } catch (e) {
      if (isCancelled(e) || interrupted()) break;
      useVcs.setState((state) => {
        const unfetched = new Map(state.unfetched);
        return unfetched.delete(root) ? { unfetched } : state;
      });
      logConsole("info", `Checking for incoming commits in ${root} failed: ${errorMessage(e)}`);
    }
  }
}

export function installIncomingCheck(): () => void {
  if (!isTauri()) return () => undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deferred: DeferredRemotes = new Map();
  let generation = 0;
  let running = false;
  let disposed = false;

  const schedule = (delay: number) => {
    clearTimeout(timer);
    const { available, hasRemotes } = useVcs.getState();
    if (!disposed && available && hasRemotes !== false && workflowSettings().vcs.git.incomingCheck !== "never") {
      timer = setTimeout(() => void check(), delay);
    }
  };

  const check = async () => {
    if (running) return;
    running = true;
    const started = generation;
    const stale = () => disposed || generation !== started;
    try {
      const s = useVcs.getState();
      if (!s.available) return;
      const mode = workflowSettings().vcs.git.incomingCheck;
      const roots = s.roots.length ? s.roots : s.root ? [s.root] : [];
      if (mode === "check") await checkIncoming(roots, stale);
      else if ((await fetchIncoming(roots, mode === "always" ? new Map() : deferred, stale)) && !stale())
        await refreshNow();
    } finally {
      running = false;
      schedule(stale() ? FIRST_DELAY : intervalMs());
    }
  };

  const restart = () => {
    generation++;
    deferred = new Map();
    if (useVcs.getState().unfetched.size) useVcs.setState({ unfetched: new Map() });
    void cancelIncomingCheck();
    schedule(FIRST_DELAY);
  };

  const unsubVcs = useVcs.subscribe((s, prev) => {
    if (s.root !== prev.root || s.roots !== prev.roots || s.available !== prev.available) restart();
    else if (s.hasRemotes !== prev.hasRemotes && (s.hasRemotes === false || prev.hasRemotes === false)) restart();
  });
  const unsubMode = onWorkflowSettingsChange((w) => w.vcs.git.incomingCheck, restart);
  const unsubInterval = onWorkflowSettingsChange(
    (w) => w.vcs.git.incomingCheckInterval,
    () => {
      if (!running) schedule(intervalMs());
    },
  );
  schedule(FIRST_DELAY);
  return () => {
    disposed = true;
    clearTimeout(timer);
    if (useVcs.getState().unfetched.size) useVcs.setState({ unfetched: new Map() });
    void cancelIncomingCheck();
    unsubVcs();
    unsubMode();
    unsubInterval();
  };
}
