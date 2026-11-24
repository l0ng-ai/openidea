/**
 * Repository state shared by all VCS views: working tree status, HEAD /
 * upstream info, branches and stashes. Refreshed (debounced) on `vcsChanged`
 * and `fsChanged` events and after every operation.
 *
 * A project may hold several repositories (IDEA's VCS roots: nested clones,
 * submodules). Status covers all of them; branch info, branches and stashes are
 * those of the selected repository (`repo`), which branch / log / remote
 * operations act on.
 */
import { onWorkflowSettingsChange, workflowSettings } from "@/platform/workflowSettings";
import { create } from "zustand";
import type { Branch, BranchInfo, FileStatus, Stash, TrackedTip, UnfetchedBranch } from "@/bindings";
import { call, commands, isTauri, onIdeEvent } from "@/platform/ipc";
import { setContext } from "@/platform/context";
import { useProject } from "@/platform/project";
import { setFileDecorations } from "@/workbench/contributions";
import { effectiveKind, repoLabel, rootOf, statusDecorations, stripSlash } from "./model";

export interface RepoHead {
  head: string | null;
  headCommit: string | null;
  shallow?: boolean;
  interactiveRebase?: boolean;
}

export interface VcsState {
  /** The open project is a git repository. */
  available: boolean;
  root: string | null;
  /** Repository roots, the project's own repository first. */
  roots: string[];
  /** Whether any repository has a configured remote, or null until known. */
  hasRemotes: boolean | null;
  unfetched: ReadonlyMap<string, ReadonlyMap<string, UnfetchedBranch>>;
  branchRoots: Record<string, string>;
  /** Root → merge / rebase / cherry-pick / revert in progress there. */
  operations: Record<string, string>;
  /** Root → its current branch (`head` null when detached) and HEAD commit. */
  heads: Record<string, RepoHead>;
  /** The selected repository's root (branch widget, log, push…). */
  repo: string | null;
  status: FileStatus[];
  /** Files whose Git conflict stages can be restored during the current operation. */
  resolvedConflicts: ReadonlySet<string>;
  /** `status` reflects the repository (false until the first refresh). */
  statusLoaded: boolean;
  /** Absolute path (no trailing slash) → status. */
  byPath: Map<string, FileStatus>;
  branch: BranchInfo | null;
  /** Repository that supplied `branch`; selection can change while a refresh is in flight. */
  branchRoot: string | null;
  branches: Branch[];
  branchesLoaded: boolean;
  stashes: Stash[];
  stashesLoaded: boolean;
  /** Bumped after each refresh; gutters re-query hunks when it changes. */
  version: number;
  loading: boolean;
  error: string | null;
  /** A network operation (fetch / pull / push) is running. */
  remoteBusy: string | null;
}

const initial: VcsState = {
  available: false,
  root: null,
  roots: [],
  hasRemotes: null,
  unfetched: new Map(),
  branchRoots: {},
  operations: {},
  heads: {},
  repo: null,
  status: [],
  resolvedConflicts: new Set(),
  statusLoaded: false,
  byPath: new Map(),
  branch: null,
  branchRoot: null,
  branches: [],
  branchesLoaded: false,
  stashes: [],
  stashesLoaded: false,
  version: 0,
  loading: false,
  error: null,
  remoteBusy: null,
};

export const useVcs = create<VcsState>(() => ({ ...initial }));

/** Root of the selected repository; `null` = the project's primary one. */
export function currentRepo(): string | null {
  return useVcs.getState().repo;
}

/** Root of the selected repository, which its log's and diffs' repository-relative paths are relative to. */
export function currentRepoRoot(): string | null {
  const s = useVcs.getState();
  return s.repo ?? s.roots[0] ?? s.root;
}

/** An observation stops applying as soon as the tracking configuration or local ref changes. */
export function unfetchedBranch(
  observations: VcsState["unfetched"],
  repo: string | null,
  branch: string | null | undefined,
  tip: TrackedTip | null | undefined,
): UnfetchedBranch | undefined {
  if (!repo || !branch || !tip) return undefined;
  const pending = observations.get(repo)?.get(branch);
  if (
    pending?.trackedTip.commit === tip.commit &&
    pending.trackedTip.tracking.remote === tip.tracking.remote &&
    pending.trackedTip.tracking.branch === tip.tracking.branch
  )
    return pending;
}

/** Root of the innermost repository containing `path`. */
export function repoOf(path: string, roots: readonly string[] = useVcs.getState().roots): string | null {
  return rootOf(path, roots);
}

/** Repository name for display. */
export function repoName(root: string): string {
  return repoLabel(root, useVcs.getState().root);
}

/**
 * A repository that just stopped in a merge / rebase / cherry-pick / revert (e.g. on
 * conflicts after Update Project) while `shown` has none in progress: it is selected so
 * the banner, the branch widget and Continue / Abort act on it.
 */
export function attentionRepo(
  shown: string | null,
  before: Record<string, string>,
  now: Record<string, string>,
): string | null {
  if (shown && now[shown]) return null;
  return Object.keys(now).find((root) => !before[root]) ?? null;
}

let gitWork = 0;

/** Marks a git command as running until the returned function is called. */
export function beginGitWork(): () => void {
  gitWork++;
  let ended = false;
  return () => {
    if (!ended) gitWork--;
    ended = true;
  };
}

/**
 * A git command is running or an operation is stopped in some repository: local
 * changes may be put aside for the time being (merge, rebase, update), so files that
 * look unchanged now may come back.
 */
export function localChangesMayBeAside(): boolean {
  const s = useVcs.getState();
  return gitWork > 0 || !!s.remoteBusy || Object.keys(s.operations).length > 0 || !!s.branch?.operation;
}

/** Selects the repository branch / log / remote operations act on. */
export function selectRepo(root: string): Promise<void> {
  if (useVcs.getState().repo === root) return Promise.resolve();
  useVcs.setState({ repo: root, branches: [], branchesLoaded: false, stashes: [], stashesLoaded: false });
  return refreshNow();
}

/** Selects `root` and loads its branches, so branch operations act on it. */
export async function focusRepo(root: string): Promise<void> {
  await selectRepo(root);
  if (!useVcs.getState().branchesLoaded) await loadBranches();
}

/** Whether the changed file still exists in the working tree (not deleted there). */
export const existsOnDisk = (f: FileStatus) => f.unstaged !== "deleted" && !(f.staged === "deleted" && !f.unstaged);

export function conflictedFiles(status: readonly FileStatus[] = useVcs.getState().status): FileStatus[] {
  return status.filter((f) => effectiveKind(f) === "conflicted");
}

// Reopening the same root starts a new lifetime.
let projectGeneration = 0;

let timer: ReturnType<typeof setTimeout> | undefined;
/** A full refresh is queued; it answers for every path an incremental one would. */
let pendingFull = false;
/** Paths of watcher batches waiting for an incremental refresh. */
const pendingPaths = new Set<string>();
/** Above this many paths one full read is cheaper than a pathspec that big. */
const PATH_BATCH_LIMIT = 200;
let inflight: Promise<void> | null = null;
/** The refresh queued behind `inflight` (it may have started before the caller's change). */
let followUp: Promise<void> | null = null;
let conflictListener: ((files: FileStatus[]) => void) | null = null;
let conflictsClearedListener: ((files: FileStatus[]) => void) | null = null;

/** Called when a changed set of conflicted files remains non-empty. */
export function onConflictsChanged(fn: (files: FileStatus[]) => void) {
  conflictListener = fn;
}

/** Reports the last unresolved files when all conflicts are resolved or the operation ends. */
export function onConflictsCleared(fn: (files: FileStatus[]) => void) {
  conflictsClearedListener = fn;
}

export function scheduleRefresh(delay = 200) {
  if (!useVcs.getState().available) return;
  pendingFull = true;
  pendingPaths.clear();
  clearTimeout(timer);
  timer = setTimeout(() => void runScheduled(), delay);
}

/**
 * Queues `paths` for an incremental refresh: a watcher batch names a few files, and asking git
 * about those only keeps the work proportional to the batch. Nothing is queued behind a full
 * refresh, which answers for them anyway.
 */
export function schedulePathsRefresh(paths: readonly string[], delay = 250) {
  if (!useVcs.getState().available || pendingFull) return;
  for (const path of paths) pendingPaths.add(path);
  clearTimeout(timer);
  timer = setTimeout(() => void runScheduled(), delay);
}

async function runScheduled(): Promise<void> {
  const full = pendingFull;
  pendingFull = false;
  if (full || pendingPaths.size === 0) return refreshNow();
  const paths = [...pendingPaths];
  pendingPaths.clear();
  return refreshPathsNow(paths);
}

/**
 * Refreshes status + branch info now. Concurrent calls coalesce; the returned
 * promise always settles after a refresh that started after this call, so callers
 * that await it read the state their operation produced.
 */
export function refreshNow(): Promise<void> {
  if (!useVcs.getState().available) return Promise.resolve();
  if (inflight) {
    // A full refresh answers for every path: queue it as one, drained after the running read, so a
    // pending batch of paths cannot swallow it (and the caller still reads the state it produced).
    pendingFull = true;
    followUp ??= inflight.then(() => {
      followUp = null;
      return runScheduled();
    });
    return followUp;
  }
  const generation = projectGeneration;
  inflight = (async () => {
    useVcs.setState({ loading: true });
    try {
      const s = useVcs.getState();
      const scoped = Promise.all([
        call(commands.vcsBranchInfo(s.repo)),
        s.branchesLoaded ? call(commands.vcsBranches(s.repo)) : Promise.resolve(s.branches),
        s.stashesLoaded ? call(commands.vcsStashes(s.repo)) : Promise.resolve(s.stashes),
      ]).then(
        (values) => ({ values }),
        (error: unknown) => ({ error }),
      );
      const [vcsRoots, status, selected] = await Promise.all([
        call(commands.vcsRoots()),
        call(commands.vcsStatus()).then(
          (files) => ({ files }),
          (error: unknown) => ({ error }),
        ),
        scoped,
      ]);
      if (generation !== projectGeneration) return;
      const roots = vcsRoots.map((r) => r.root);
      if (!roots.length) {
        useVcs.setState({ ...initial, root: s.root, version: s.version });
        setContext("vcsAvailable", false);
        setContext("vcsShallowRepositories", "");
        setFileDecorations("vcs", new Map());
        return;
      }
      if ("error" in status) throw status.error;
      const hasRemotes = vcsRoots.some((r) => r.hasRemotes === true)
        ? true
        : vcsRoots.every((r) => r.hasRemotes === false)
          ? false
          : null;
      useVcs.setState({ hasRemotes });
      if (s.repo && !roots.includes(s.repo)) {
        // Keep the loaded flags so the retry also reads the new repository's branch and stash lists.
        useVcs.setState({ repo: roots[0]!, branch: null, branches: [], stashes: [] });
        void refreshNow();
        return;
      }
      if ("error" in selected) throw selected.error;
      const [branch, branches, stashes] = selected.values;
      const operations = Object.fromEntries(vcsRoots.filter((r) => r.operation).map((r) => [r.root, r.operation!]));
      // `null` (before the first refresh) is the primary repository, listed first.
      const shown = s.repo && roots.includes(s.repo) ? s.repo : (roots[0] ?? null);
      const repo = attentionRepo(shown, s.operations, operations) ?? shown;
      const heads = Object.fromEntries(
        vcsRoots.map((r) => [
          r.root,
          { head: r.head, headCommit: r.headCommit, shallow: !!r.shallow, interactiveRebase: r.interactiveRebase },
        ]),
      );
      const resolvedConflicts = new Set(vcsRoots.flatMap((r) => r.resolvedConflicts ?? []));
      const sameRoots = roots.join("\n") === s.roots.join("\n");
      const branchRoots = Object.fromEntries(vcsRoots.map((r) => [r.root, r.branchRoot]));
      const sameBranchRoots = sameRoots && roots.every((root) => branchRoots[root] === s.branchRoots[root]);
      useVcs.setState({
        operations,
        heads,
        resolvedConflicts,
        branchRoots: sameBranchRoots ? s.branchRoots : branchRoots,
      });
      if (repo !== s.repo || !sameRoots) useVcs.setState({ roots: sameRoots ? s.roots : roots, repo });
      setContext(
        "vcsShallowRepositories",
        vcsRoots
          .filter((r) => r.shallow)
          .map((r) => r.root)
          .join("\n"),
      );
      applyStatus(status.files, branch, s.repo ?? roots[0] ?? null);
      useVcs.setState({ branches, stashes, error: null });
      // Branch info and branches above are of another repository: load the selected one's.
      if (repo !== shown || (s.repo && repo !== s.repo)) {
        useVcs.setState({ branchesLoaded: false, stashesLoaded: false });
        void refreshNow();
      }
    } catch (e) {
      if (generation === projectGeneration) {
        useVcs.setState({ error: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      if (generation === projectGeneration) {
        useVcs.setState((st) => ({ loading: false, version: st.version + 1 }));
      }
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Refreshes the status of `paths` only and merges it into the loaded one. Anything that makes a
 * scoped answer unreliable — nothing loaded yet, a large batch, a full refresh in flight — falls
 * back to the full refresh, which is always correct.
 */
export function refreshPathsNow(paths: readonly string[]): Promise<void> {
  const state = useVcs.getState();
  if (!state.available || !state.statusLoaded || paths.length === 0 || paths.length > PATH_BATCH_LIMIT) {
    return refreshNow();
  }
  if (inflight) {
    // Coalesce with the running refresh: the queued run drains every path that arrived meanwhile,
    // so a second batch is not answered with the first one's list.
    for (const path of paths) pendingPaths.add(path);
    followUp ??= inflight.then(() => {
      followUp = null;
      return runScheduled();
    });
    return followUp;
  }
  const generation = projectGeneration;
  const run = (async () => {
    try {
      const fresh = await call(commands.vcsStatusPaths([...paths]));
      if (generation !== projectGeneration) return false;
      const current = useVcs.getState();
      if (!current.statusLoaded || pairsRenames(current.status, paths, fresh)) return false;
      applyStatus(mergeStatus(current.status, paths, fresh), current.branch);
      useVcs.setState((st) => ({ version: st.version + 1 }));
      return true;
    } catch {
      return false;
    }
  })();
  const done = run.then((ok) => {
    inflight = null;
    return ok || generation !== projectGeneration ? undefined : refreshNow();
  });
  inflight = done;
  return done;
}

/**
 * `base` with the entries of `changed` replaced by `fresh`: a path that is no longer changed drops
 * out of the list, a directory that went away drops everything below it, and new entries land in
 * path order. Only whole path segments match, so `src/a.txt` never absorbs `src/a.txt.bak`.
 */
export function mergeStatus(
  base: readonly FileStatus[],
  changed: readonly string[],
  fresh: readonly FileStatus[],
): FileStatus[] {
  const inBatch = coveredBy(changed);
  // A path the read answered for replaces its old entry even when the batch did not name it.
  const answered = new Set(fresh.map((f) => stripSlash(f.path)));
  const keep = (f: FileStatus) => !inBatch(f.path) && !answered.has(stripSlash(f.path));
  // Byte order, as the backend sorts a full status: a locale-aware compare would reorder it.
  return [...base.filter(keep), ...fresh].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
}

/** Whether `path` is one of `changed` or lies below one of them (whole segments only). */
function coveredBy(changed: readonly string[]): (path: string) => boolean {
  const exact = new Set(changed.map(stripSlash));
  const dirs = [...exact].map((path) => `${path}/`);
  return (path) => {
    const p = stripSlash(path);
    return exact.has(p) || dirs.some((dir) => p.startsWith(dir));
  };
}

/**
 * Whether a scoped read of `changed` may have split or missed a rename. Git pairs a deletion with an
 * addition across the whole index, and a pathspec read sees only one side: a staged `a → b` read for
 * `b` alone comes back as "added b" with the deletion of `a` gone. Such a batch takes the full status.
 */
export function pairsRenames(
  base: readonly FileStatus[],
  changed: readonly string[],
  fresh: readonly FileStatus[],
): boolean {
  if (fresh.some((f) => f.renamedFrom)) return true;
  const inBatch = coveredBy(changed);
  const renamedFrom = (f: FileStatus) => {
    const path = stripSlash(f.path);
    return f.renamedFrom && path.endsWith(f.relPath)
      ? path.slice(0, path.length - f.relPath.length) + f.renamedFrom
      : "";
  };
  if (base.some((f) => f.renamedFrom && (inBatch(f.path) || inBatch(renamedFrom(f))))) return true;
  // An addition and a deletion on either side of the batch may now pair up into a rename.
  const outside = base.filter((f) => !inBatch(f.path));
  const has = (list: readonly FileStatus[], kind: "added" | "deleted") =>
    list.some((f) => f.staged === kind || f.unstaged === kind);
  return (has(fresh, "added") && has(outside, "deleted")) || (has(fresh, "deleted") && has(outside, "added"));
}

export function applyStatus(
  status: FileStatus[],
  branch: BranchInfo | null,
  branchRoot = useVcs.getState().branchRoot,
) {
  const before = conflictedFiles();
  const byPath = new Map(status.map((f) => [stripSlash(f.path), f]));
  useVcs.setState({ status, byPath, branch, branchRoot, statusLoaded: true });
  setFileDecorations("vcs", statusDecorations(status, workflowSettings().vcs.showDirtyDirectories));
  const conflicts = conflictedFiles(status);
  if (conflicts.length === 0) {
    if (before.length > 0) conflictsClearedListener?.(before);
  } else if (before.length !== conflicts.length || before.some((f, i) => f.path !== conflicts[i]?.path)) {
    conflictListener?.(conflicts);
  }
}

export async function loadBranches(): Promise<Branch[]> {
  const repo = currentRepo();
  const branches = await call(commands.vcsBranches(repo));
  if (repo === currentRepo()) useVcs.setState({ branches, branchesLoaded: true });
  return branches;
}

export async function loadStashes(): Promise<Stash[]> {
  const repo = currentRepo();
  const stashes = await call(commands.vcsStashes(repo));
  if (repo === currentRepo()) useVcs.setState({ stashes, stashesLoaded: true });
  return stashes;
}

export function statusOf(path: string): FileStatus | undefined {
  return useVcs.getState().byPath.get(stripSlash(path));
}

/** Repositories found below a project that is not itself under git (scanned in the background). */
export async function discoverRoots() {
  if (!useVcs.getState().root || !isTauri()) return;
  const generation = projectGeneration;
  const roots = await call(commands.vcsRoots()).catch(() => []);
  if (!roots.length || generation !== projectGeneration || useVcs.getState().available) return;
  useVcs.setState({ available: true });
  setContext("vcsAvailable", true);
  void refreshNow();
}

/** Tracks the open project and backend events. Returns a disposer. */
export function installVcsStore(): () => void {
  const syncFetchContext = ({ hasRemotes, remoteBusy }: VcsState) =>
    setContext("vcsFetchDisabled", hasRemotes === false || !!remoteBusy);
  syncFetchContext(useVcs.getState());
  const offFetchContext = useVcs.subscribe((s, prev) => {
    if (s.hasRemotes !== prev.hasRemotes || s.remoteBusy !== prev.remoteBusy) syncFetchContext(s);
  });
  const onProject = () => {
    const project = useProject.getState().project;
    const available = !!project?.isGit;
    const root = project?.root ?? null;
    if (useVcs.getState().root === root && useVcs.getState().available === available) return;
    projectGeneration++;
    clearTimeout(timer);
    pendingPaths.clear();
    useVcs.setState({ ...initial, available, root, version: useVcs.getState().version + 1 });
    setContext("vcsAvailable", available);
    setContext("vcsShallowRepositories", "");
    setFileDecorations("vcs", new Map());
    if (available && isTauri()) void refreshNow();
    else if (project) void discoverRoots();
  };
  onProject();
  const unsubProject = useProject.subscribe((s, prev) => {
    if (s.project !== prev.project) onProject();
  });
  const offVcs = onIdeEvent("vcsChanged", () => {
    if (useVcs.getState().available) scheduleRefresh(200);
    else void discoverRoots();
  });
  // `.git/**` internals show up through other watchers too; refreshing status
  // on those alone rewrites `.git/index` and re-triggers this handler.
  const offFs = onIdeEvent("fsChanged", (e) => {
    // Ignore-rule changes re-filter every path: only a full status answers for them.
    if (e.ignoreRules?.length) {
      scheduleRefresh(250);
      return;
    }
    const changed = [...e.created, ...e.modified, ...e.removed].filter((p) => !/(^|[/\\])\.git([/\\]|$)/.test(p));
    if (changed.length) schedulePathsRefresh(changed, 250);
  });
  const offSettings = onWorkflowSettingsChange(
    (s) => s.vcs.showDirtyDirectories,
    (show) => {
      if (useVcs.getState().available) setFileDecorations("vcs", statusDecorations(useVcs.getState().status, show));
    },
  );
  return () => {
    offFetchContext();
    offSettings();
    clearTimeout(timer);
    unsubProject();
    offVcs();
    offFs();
    setContext("vcsAvailable", false);
    setContext("vcsFetchDisabled", false);
    setContext("vcsShallowRepositories", "");
    setFileDecorations("vcs", new Map());
  };
}
