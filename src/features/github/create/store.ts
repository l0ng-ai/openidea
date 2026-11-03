/**
 * State of the New Pull Request tab (IntelliJ's `GHPRCreateViewModel`), kept while the
 * tab is open (switching tabs keeps the form) and dropped when it closes:
 *
 * - the merge direction, its commits (`git log base..head`), the branches check and the
 *   changes of all commits (three-dot diff) or of the selected one, all computed locally;
 * - the title (the only commit's subject or the branch name until edited), the
 *   description (the repository's template) and the reviewers, assignees and labels;
 * - creation: push a local head first (asking for the remote branch name when it has
 *   none), `createPullRequest`, then the metadata; on success the pull request opens and
 *   the tab closes.
 */
import { create } from "zustand";
import { commitFileDiffData, type DiffData } from "@/features/vcs/diffInput";
import { lastRemoteFailure, runRemote } from "@/features/vcs/ops";
import { useVcs } from "@/features/vcs/store";
import type { Branch, ChangeKind, Commit } from "@/platform/ipc";
import { call, commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { tx } from "@/platform/i18n";
import { errorMessage } from "../api/client";
import * as api from "../api/requests";
import type { GHLabel, GHPullRequestRequestedReviewer, GHUser } from "../api/types";
import { isTeam } from "../data/model";
import { createPullRequest } from "../data/operations";
import { loadPullRequestTemplate, requireConnection, sameRepository, useGhRepository } from "../data/repository";
import type { GHRemote } from "../data/repository";
import { refreshCurrentBranchPullRequest } from "../reviewMode/state";
import { openPullRequest } from "../toolwindow/open";
import { closeTab, useGhTabs } from "../toolwindow/store";
import {
  checkBranches,
  cleanUpBranchName,
  commitsRange,
  defaultDirection,
  generateTitle,
  headBranchName,
  headRefName,
  needsPush,
  pushTarget,
  remoteBranchFullName,
  sameHead,
  sameRemoteBranch,
  searchHead,
  trackedHead,
  type BranchesCheckResult,
  type Direction,
  type HeadBranch,
  type RemoteBranchRef,
} from "./model";
import { remoteBranchNameDialog } from "./RemoteBranchDialog";

export type Loadable<T> = { state: "loading" } | { state: "error"; error: string } | { state: "ok"; value: T };

/** A changed file of the preview, with its diff. */
export interface CreateChange {
  /** Repository-relative path (after the change). */
  path: string;
  oldPath: string | null;
  kind: ChangeKind;
  diff: DiffData;
}

/** `CreationState` (CollectingData, Pushing, CallingAPI, SettingMetadata, Created, Error). */
export type CreationState =
  | { kind: "collecting" | "pushing" | "creating" | "metadata" | "created" }
  | { kind: "error"; error: string };

interface CreateState {
  /** Initialized (branches read, direction chosen). */
  ready: boolean;
  initError: string | null;
  /** Local and remote branches of the repository. */
  branches: Branch[];
  direction: Direction | null;
  /** `git log base..head`, newest first; null until base and head are chosen. */
  commits: Loadable<Commit[]> | null;
  check: Loadable<BranchesCheckResult> | null;
  /** The commit whose changes are shown; null: all commits. */
  selectedCommit: string | null;
  changes: Loadable<CreateChange[]> | null;
  title: string;
  /** The user typed a title: it no longer follows the commits. */
  titleEdited: boolean;
  description: string;
  descriptionEdited: boolean;
  templateLoading: boolean;
  reviewers: GHPullRequestRequestedReviewer[];
  assignees: GHUser[];
  labels: GHLabel[];
  creation: CreationState | null;
}

const initial: CreateState = {
  ready: false,
  initError: null,
  branches: [],
  direction: null,
  commits: null,
  check: null,
  selectedCommit: null,
  changes: null,
  title: "",
  titleEdited: false,
  description: "",
  descriptionEdited: false,
  templateLoading: false,
  reviewers: [],
  assignees: [],
  labels: [],
  creation: null,
};

export const useCreatePr = create<CreateState>(() => ({ ...initial }));

/** Bumped by every reset: late results for a dropped form are ignored. */
let generation = 0;
/** Bumped by every direction change and refresh: late results of older checks are dropped. */
let checkSeq = 0;
let changesSeq = 0;

/** The repository's root, which the preview's repository-relative paths are relative to. */
function repoRoot(): string | null {
  return useVcs.getState().roots[0] ?? useProject.getState().project?.root ?? null;
}

const ok = <T>(value: T): Loadable<T> => ({ state: "ok", value });
const failed = (e: unknown): Loadable<never> => ({ state: "error", error: errorMessage(e) });

const remoteNames = () => useGhRepository.getState().remotes.map((r) => r.remote);

/** The connected repository's GitHub remote (the base). */
function baseRemote(): GHRemote {
  const { coordinates } = requireConnection();
  const remotes = useGhRepository.getState().remotes;
  return remotes.find((r) => sameRepository(r, coordinates)) ?? { ...coordinates, remote: "origin", url: "" };
}

/** Reads the branches and picks the default direction; starts loading the template. */
export async function initCreate(): Promise<void> {
  if (useCreatePr.getState().ready) return;
  const e = ++generation;
  try {
    const { repository } = requireConnection();
    const [branches, info] = await Promise.all([
      call(commands.vcsBranches(null)),
      call(commands.vcsBranchInfo(null)).catch(() => null),
    ]);
    if (e !== generation) return;
    const direction = defaultDirection({
      baseRepo: baseRemote(),
      remotes: useGhRepository.getState().remotes,
      branches,
      currentBranch: info?.head ?? null,
      defaultBranch: repository.defaultBranchRef?.name,
    });
    useCreatePr.setState({ ready: true, initError: null, branches, direction, templateLoading: true });
    void loadPullRequestTemplate().then((template) => {
      if (e !== generation) return;
      const s = useCreatePr.getState();
      useCreatePr.setState({ templateLoading: false, ...(s.descriptionEdited ? {} : { description: template ?? "" }) });
    });
    reloadBranchesState();
  } catch (err) {
    if (e === generation) useCreatePr.setState({ initError: errorMessage(err) });
  }
}

/** Drops the form (the tab closed, another repository). */
export function resetCreate() {
  generation++;
  checkSeq++;
  changesSeq++;
  useCreatePr.setState({ ...initial });
}

export function setBaseBranch(branch: RemoteBranchRef) {
  const d = useCreatePr.getState().direction;
  if (!d || sameRemoteBranch(d.baseBranch, branch)) return;
  useCreatePr.setState({ direction: { ...d, baseBranch: branch } });
  reloadBranchesState();
}

export function setHead(repo: GHRemote, branch: HeadBranch) {
  const d = useCreatePr.getState().direction;
  if (!d || (d.headRepo && sameRepository(d.headRepo, repo) && sameHead(d.headBranch, branch))) return;
  useCreatePr.setState({ direction: { ...d, headRepo: repo, headBranch: branch } });
  reloadBranchesState();
}

/** The Refresh of a failed check: reads the branches again and checks them. */
export async function refreshBranchesState(): Promise<void> {
  const branches = await call(commands.vcsBranches(null)).catch(() => null);
  if (branches) useCreatePr.setState({ branches });
  reloadBranchesState();
}

const tip = (branches: readonly Branch[], name: string) => branches.find((b) => b.name === name)?.commit;

/** The repository changed: reloads the commits when the base or head moved (`infoStateIn`). */
export async function onRepositoryChanged(): Promise<void> {
  const s = useCreatePr.getState();
  if (!s.ready || !s.direction) return;
  const branches = await call(commands.vcsBranches(null)).catch(() => null);
  if (!branches) return;
  const { baseBranch, headBranch } = useCreatePr.getState().direction ?? {};
  const before = useCreatePr.getState().branches;
  useCreatePr.setState({ branches });
  const moved = (name: string) => tip(before, name) !== tip(branches, name);
  if (
    (baseBranch && moved(remoteBranchFullName(baseBranch))) ||
    (headBranch && moved(headBranchName(headBranch))) ||
    (headBranch?.kind === "local" &&
      before.find((b) => b.name === headBranch.name)?.upstream !==
        branches.find((b) => b.name === headBranch.name)?.upstream)
  )
    reloadBranchesState();
}

/** `BranchesStateWithProgress`: the commits, the open pull request of the head and the check. */
function reloadBranchesState() {
  const e = ++checkSeq;
  const { direction: d, branches } = useCreatePr.getState();
  const base = d?.baseBranch;
  const head = d?.headBranch;
  const headRepo = d?.headRepo;
  if (!base || !head || !headRepo) {
    useCreatePr.setState({ commits: null, check: null, changes: null, selectedCommit: null });
    return;
  }
  const tracked = trackedHead(head, branches, remoteNames());
  const trackingBase = sameRemoteBranch(base, tracked);
  useCreatePr.setState({
    commits: { state: "loading" },
    changes: { state: "loading" },
    selectedCommit: null,
    check: trackingBase
      ? ok(checkBranches({ base, head, tracked, commits: [], existing: null }))
      : { state: "loading" },
  });
  const existing = tracked
    ? api
        .findOpenPullRequestsByHead(searchHead(headRepo, tracked.name), base.name)
        .then((prs) => prs[0]?.number ?? null)
    : Promise.resolve(null);
  existing.catch(() => undefined);
  const commits = call(
    commands.vcsLog(null, {
      branch: null,
      path: null,
      author: null,
      text: null,
      range: commitsRange(base, head),
      skip: 0,
      limit: 10_000,
    }),
  );
  void commits.then(
    (list) => {
      if (e !== checkSeq) return;
      const s = useCreatePr.getState();
      useCreatePr.setState({ commits: ok(list), ...(s.titleEdited ? {} : { title: generateTitle(list, head) }) });
      void loadChanges();
    },
    (err) => {
      if (e === checkSeq) useCreatePr.setState({ commits: failed(err), changes: null });
    },
  );
  if (trackingBase) return;
  void Promise.all([commits, existing]).then(
    ([list, number]) => {
      if (e === checkSeq)
        useCreatePr.setState({ check: ok(checkBranches({ base, head, tracked, commits: list, existing: number })) });
    },
    (err) => {
      if (e === checkSeq) useCreatePr.setState({ check: failed(err) });
    },
  );
}

/** Shows the changes of commit `id` (null: all commits). */
export function selectCommit(id: string | null) {
  if (useCreatePr.getState().selectedCommit === id) return;
  useCreatePr.setState({ selectedCommit: id });
  void loadChanges();
}

/** Diff of a file of all commits: the merge base ↔ the head. */
function rangeDiffData(
  file: { path: string; oldPath: string | null; kind: ChangeKind },
  root: string | null,
  base: { rev: string; label: string },
  head: { rev: string; label: string },
): DiffData {
  const abs = (rel: string) => (root ? `${root}/${rel}` : rel);
  return {
    path: abs(file.path),
    left:
      file.kind === "added" || file.kind === "untracked"
        ? { type: "text", text: "", label: tx("(does not exist)") }
        : { type: "rev", rev: base.rev, path: file.oldPath ? abs(file.oldPath) : undefined, label: base.label },
    right: file.kind === "deleted" ? { type: "text", text: "", label: tx("(deleted)") } : { type: "rev", ...head },
  };
}

/** `getDiff`: the three-dot diff of all commits, or the selected commit's changes. */
async function loadChanges() {
  const seq = ++changesSeq;
  const s = useCreatePr.getState();
  const d = s.direction;
  if (s.commits?.state !== "ok" || !d?.baseBranch || !d.headBranch) return;
  const list = s.commits.value;
  if (!list.length) {
    useCreatePr.setState({ changes: null });
    return;
  }
  useCreatePr.setState({ changes: { state: "loading" } });
  const root = repoRoot();
  try {
    let changes: CreateChange[];
    const commit = s.selectedCommit ? list.find((c) => c.id === s.selectedCommit) : null;
    if (commit) {
      const files = await call(commands.vcsCommitFiles(null, commit.id));
      changes = files.map((f) => ({ ...f, diff: commitFileDiffData({ ...commit, repo: root }, f) }));
    } else {
      const head = list[0]!.id;
      const baseName = remoteBranchFullName(d.baseBranch);
      const mergeBase = await call(commands.vcsMergeBase(null, baseName, head));
      if (!mergeBase) throw new Error(tx`Unrelated branches ${baseName} ${headBranchName(d.headBranch)}`);
      const files = await call(commands.vcsDiffRevisions(null, mergeBase, head));
      const baseSide = { rev: mergeBase, label: `${d.baseBranch.name} (${mergeBase.slice(0, 8)})` };
      const headSide = { rev: head, label: `${headBranchName(d.headBranch)} (${head.slice(0, 8)})` };
      changes = files.map((f) => ({ ...f, diff: rangeDiffData(f, root, baseSide, headSide) }));
    }
    if (seq === changesSeq) useCreatePr.setState({ changes: ok(changes) });
  } catch (err) {
    if (seq === changesSeq) useCreatePr.setState({ changes: failed(err) });
  }
}

export function setTitle(title: string) {
  useCreatePr.setState({ title, titleEdited: true });
}

export function setDescription(description: string) {
  useCreatePr.setState({ description, descriptionEdited: true });
}

export function setReviewers(reviewers: GHPullRequestRequestedReviewer[]) {
  useCreatePr.setState({ reviewers });
}

export function setAssignees(assignees: GHUser[]) {
  useCreatePr.setState({ assignees });
}

export function setLabels(labels: GHLabel[]) {
  useCreatePr.setState({ labels });
}

/** Create is enabled when the check is OK and nothing runs (or the last attempt failed). */
export function canCreate(s: Pick<CreateState, "check" | "creation">): boolean {
  return s.check?.state === "ok" && s.check.value.kind === "ok" && (s.creation === null || s.creation.kind === "error");
}

/** Pushes a local head when needed; resolves with the remote branch name, null when cancelled. */
async function pushHead(head: Extract<HeadBranch, { kind: "local" }>, headRepo: GHRemote): Promise<string | null> {
  const branches = useCreatePr.getState().branches;
  let target = pushTarget(branches, head.name, headRepo.remote, remoteNames());
  if (!target) {
    const name = await remoteBranchNameDialog(head.name);
    if (name === null) return null;
    target = { remote: headRepo.remote, name: cleanUpBranchName(name) };
  }
  if (needsPush(branches, head.name, target)) {
    useCreatePr.setState({ creation: { kind: "pushing" } });
    const pushed = await runRemote(
      {
        op: "pushBranch",
        branch: head.name,
        revision: null,
        force_with_lease: false,
        target: target.name,
        remote: target.remote,
      },
      `${head.name} → ${remoteBranchFullName(target)}`,
      [null],
    );
    if (!pushed) {
      const error = lastRemoteFailure();
      // Cancelled: back to the form.
      if (!error) return null;
      throw new Error(tx`Push failed: ${error}`);
    }
    const after = await call(commands.vcsBranches(null)).catch(() => null);
    if (after) useCreatePr.setState({ branches: after });
  }
  return target.name;
}

/** "Create Pull Request" / "Create Draft Pull Request". */
export async function createFromForm(draft: boolean): Promise<void> {
  const s = useCreatePr.getState();
  const d = s.direction;
  if (!canCreate(s) || !d?.baseBranch || !d.headBranch || !d.headRepo) return;
  const { baseBranch, headBranch, headRepo } = d;
  const e = generation;
  useCreatePr.setState({ creation: { kind: "collecting" } });
  try {
    const remoteName = headBranch.kind === "remote" ? headBranch.name : await pushHead(headBranch, headRepo);
    if (remoteName === null) {
      useCreatePr.setState({ creation: null });
      return;
    }
    useCreatePr.setState({ creation: { kind: "creating" } });
    const { coordinates } = requireConnection();
    const pr = await createPullRequest({
      base: baseBranch.name,
      head: headRefName(coordinates, headRepo, remoteName),
      title: s.title,
      body: s.description,
      draft,
      reviewers: s.reviewers,
      assignees: s.assignees.map((u) => u.login),
      labels: s.labels.map((l) => l.name),
      onSettingMetadata: () => useCreatePr.setState({ creation: { kind: "metadata" } }),
    });
    useCreatePr.setState({ creation: { kind: "created" } });
    void refreshCurrentBranchPullRequest();
    await openPullRequest(pr.number);
    closeTab("create");
  } catch (err) {
    if (e === generation) useCreatePr.setState({ creation: { kind: "error", error: errorMessage(err) } });
  }
}

/** The reviewers one can pick: not the current user. */
export function selectableReviewers(items: readonly GHPullRequestRequestedReviewer[], me: GHUser | null | undefined) {
  return me ? items.filter((r) => isTeam(r) || r.id !== me.id) : [...items];
}

// The form lives as long as its tab.
useGhTabs.subscribe((t, prev) => {
  const open = t.tabs.some((x) => x.kind === "create");
  if (!open && prev.tabs.some((x) => x.kind === "create")) resetCreate();
});
