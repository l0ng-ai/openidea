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
import type { Branch, BranchInfo, FileStatus, Stash } from "@/bindings";
import { call, commands, isTauri, onIdeEvent } from "@/platform/ipc";
import { setContext } from "@/platform/context";
import { useProject } from "@/platform/project";
import { setFileDecorations } from "@/workbench/contributions";
import { effectiveKind, repoLabel, rootOf, statusDecorations, stripSlash } from "./model";

export interface RepoHead {
  head: string | null;
  headCommit: string | null;
}

export interface VcsState {
  /** The open project is a git repository. */
  available: boolean;
  root: string | null;
  /** Repository roots, the project's own repository first. */
  roots: string[];
  /** Root → merge / rebase / cherry-pick / revert in progress there. */
  operations: Record<string, string>;
  /** Root → its current branch (`head` null when detached) and HEAD commit. */
  heads: Record<string, RepoHead>;
  /** The selected repository's root (branch widget, log, push…). */
  repo: string | null;
  status: FileStatus[];
  /** `status` reflects the repository (false until the first refresh). */
  statusLoaded: boolean;
  /** Absolute path (no trailing slash) → status. */
  byPath: Map<string, FileStatus>;
  branch: BranchInfo | null;
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
  operations: {},
  heads: {},
  repo: null,
  status: [],
  statusLoaded: false,
  byPath: new Map(),
  branch: null,
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

export function conflictedFiles(status: readonly FileStatus[] = useVcs.getState().status): FileStatus[] {
  return status.filter((f) => effectiveKind(f) === "conflicted");
}

let timer: ReturnType<typeof setTimeout> | undefined;
let inflight: Promise<void> | null = null;
/** The refresh queued behind `inflight` (it may have started before the caller's change). */
let followUp: Promise<void> | null = null;
let conflictListener: ((files: FileStatus[]) => void) | null = null;
let conflictsClearedListener: (() => void) | null = null;

/** Called when the set of conflicted files becomes non-empty. */
export function onConflictsAppeared(fn: (files: FileStatus[]) => void) {
  conflictListener = fn;
}

/** Called when the last conflicted file is resolved (or the merge is aborted). */
export function onConflictsCleared(fn: () => void) {
  conflictsClearedListener = fn;
}

export function scheduleRefresh(delay = 200) {
  if (!useVcs.getState().available) return;
  clearTimeout(timer);
  timer = setTimeout(() => void refreshNow(), delay);
}

/**
 * Refreshes status + branch info now. Concurrent calls coalesce; the returned
 * promise always settles after a refresh that started after this call, so callers
 * that await it read the state their operation produced.
 */
export function refreshNow(): Promise<void> {
  if (!useVcs.getState().available) return Promise.resolve();
  if (inflight) {
    followUp ??= inflight.then(() => {
      followUp = null;
      return refreshNow();
    });
    return followUp;
  }
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
        call(commands.vcsStatus()),
        scoped,
      ]);
      const roots = vcsRoots.map((r) => r.root);
      if ("error" in selected) {
        // The selected repository is gone (removed since the last scan): fall back to the primary one.
        if (!s.repo || roots.includes(s.repo)) throw selected.error;
        useVcs.setState({ roots, repo: null, branchesLoaded: false, stashesLoaded: false });
        void refreshNow();
        return;
      }
      const [branch, branches, stashes] = selected.values;
      const operations = Object.fromEntries(vcsRoots.filter((r) => r.operation).map((r) => [r.root, r.operation!]));
      // `null` (before the first refresh) is the primary repository, listed first.
      const shown = s.repo && roots.includes(s.repo) ? s.repo : (roots[0] ?? null);
      const repo = attentionRepo(shown, s.operations, operations) ?? shown;
      const heads = Object.fromEntries(vcsRoots.map((r) => [r.root, { head: r.head, headCommit: r.headCommit }]));
      useVcs.setState({ operations, heads });
      if (repo !== s.repo || roots.join("\n") !== s.roots.join("\n")) useVcs.setState({ roots, repo });
      applyStatus(status, branch);
      useVcs.setState({ branches, stashes, error: null });
      // Branch info and branches above are of another repository: load the selected one's.
      if (repo !== shown || (s.repo && repo !== s.repo)) {
        useVcs.setState({ branchesLoaded: false, stashesLoaded: false });
        void refreshNow();
      }
    } catch (e) {
      useVcs.setState({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      useVcs.setState((st) => ({ loading: false, version: st.version + 1 }));
      inflight = null;
    }
  })();
  return inflight;
}

export function applyStatus(status: FileStatus[], branch: BranchInfo | null) {
  const before = conflictedFiles().length;
  const byPath = new Map(status.map((f) => [stripSlash(f.path), f]));
  useVcs.setState({ status, byPath, branch, statusLoaded: true });
  setFileDecorations("vcs", statusDecorations(status, workflowSettings().vcs.showDirtyDirectories));
  const conflicts = conflictedFiles(status);
  if (before === 0 && conflicts.length > 0) conflictListener?.(conflicts);
  else if (before > 0 && conflicts.length === 0) conflictsClearedListener?.();
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
async function discoverRoots() {
  const root = useVcs.getState().root;
  if (!root || !isTauri()) return;
  const roots = await call(commands.vcsRoots()).catch(() => []);
  if (!roots.length || useVcs.getState().root !== root || useVcs.getState().available) return;
  useVcs.setState({ available: true });
  setContext("vcsAvailable", true);
  void refreshNow();
}

/** Tracks the open project and backend events. Returns a disposer. */
export function installVcsStore(): () => void {
  const onProject = () => {
    const project = useProject.getState().project;
    const available = !!project?.isGit;
    const root = project?.root ?? null;
    if (useVcs.getState().root === root && useVcs.getState().available === available) return;
    clearTimeout(timer);
    useVcs.setState({ ...initial, available, root, version: useVcs.getState().version + 1 });
    setContext("vcsAvailable", available);
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
  const offFs = onIdeEvent("fsChanged", () => scheduleRefresh(250));
  const offSettings = onWorkflowSettingsChange(
    (s) => s.vcs.showDirtyDirectories,
    (show) => {
      if (useVcs.getState().available) setFileDecorations("vcs", statusDecorations(useVcs.getState().status, show));
    },
  );
  return () => {
    offSettings();
    clearTimeout(timer);
    unsubProject();
    offVcs();
    offFs();
    setContext("vcsAvailable", false);
    setFileDecorations("vcs", new Map());
  };
}
