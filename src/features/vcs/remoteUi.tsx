/** Update Project and Push dialogs. */
import { useEffect, useMemo, useState } from "react";
import type {
  Branch,
  BranchInfo,
  Commit,
  DefaultPushTarget,
  PushDivergence,
  PushInspection,
  PushSelection,
  PushTags,
  PushTargetChoices,
  RemoteOp,
} from "@/bindings";
import { executeAction } from "@/platform/actions";
import { call, commands, IpcError, nextRequestId } from "@/platform/ipc";
import { tx, txPart } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { workflowSettings, type UpdateMethod } from "@/platform/workflowSettings";
import { notifications } from "@/workbench/contributions";
import { Button, Checkbox, Dialog, List, Radio, Select, Spinner, T, Tree } from "@/ui";
import { ask } from "@/workbench/messages";
import { isProtectedBranch } from "./branches";
import { validateBranchName } from "./branchOps";
import { openDialog } from "./dialogs";
import { useBranches } from "./gitMenuDialogs";
import { saveVcsSetting } from "./settingsUi";
import { formatTime } from "./model";
import {
  allRepos,
  errorMessage,
  gitConsoleNotificationAction,
  notifyPushResults,
  runOp,
  runRemote,
  runRemoteRound,
  saveAll,
  type RemoteFailure,
  type RemoteTarget,
} from "./ops";
import { PushChanges, pushChangesKey } from "./PushChanges";
import { PushCheckStatus } from "./PushCheckStatus";
import { PushTagOptions, usePushTagOptions } from "./PushTagOptions";
import { PushReview, usePushDiff } from "./PushDiff";
import {
  PushInspectionBanner,
  pushesCurrentUpstream,
  selectedPushOperation,
  showInspectedCommits,
  usePushInspection,
  type InspectionTarget,
} from "./pushInspection";
import { splitTracked, type PushOp } from "./pushTarget";
import { formatPushOutcomes, partialPushReport, type RepoPushOutcome } from "./pushReport";
import { currentRepo, currentRepoRoot, refreshNow, repoName, useVcs } from "./store";
import { stripRemotePrefix, TargetBranchInput } from "./TargetBranchInput";
import styles from "./common.module.css";
import { useRowHeight } from "@/ui/density";

/** Update Project… scope: one repository (`null`: the selected one), else every repository. */
export interface UpdateTarget {
  repo?: string | null;
}

export function updateRepos(target: UpdateTarget): Array<string | null> {
  return target.repo === undefined ? allRepos() : [target.repo];
}

/** Update Project…: the options dialog, or (Confirmation › Show options before Update off) the default method right away. */
export function showUpdateDialog(target: UpdateTarget = {}) {
  const { vcs } = workflowSettings();
  const repos = target.repo === undefined ? [] : updateRepos(target);
  if (!vcs.confirmation.showUpdateOptions) return void updateProject(vcs.git.updateMethod === "rebase", repos);
  openDialog((close) => <UpdateDialog repos={repos} onClose={close} />);
}

async function updateProject(rebase: boolean, repos: Array<string | null>) {
  const project = useProject.getState().project;
  await saveAll();
  if (project !== useProject.getState().project) return;
  const branch = useVcs.getState().branch;
  const plan = await runOp(tx("Updating project"), () => call(commands.vcsProjectUpdatePlan(repos)), {
    refresh: false,
  });
  if (!plan || project !== useProject.getState().project) return;
  const detail =
    plan.length > 1
      ? tx`${plan.length} repositories`
      : branch?.upstream
        ? `${branch.head} ← ${branch.upstream}`
        : undefined;
  const targets = plan.map(({ root, parent, detachedSubmodule }): RemoteTarget<RemoteOp> => ({
    repo: root,
    parent,
    op: detachedSubmodule && parent ? { op: "updateSubmodule", parent } : { op: "updateProjectBranch", rebase },
  }));
  await runRemoteRound(targets, detail);
}

/** Reset to the Remote Branch: after confirming, drops local commits and takes the tracked branch. */
async function resetToRemoteBranch() {
  const branch = useVcs.getState().branch;
  if (branch?.head && branch.upstream) {
    const local = branch.head;
    const remote = branch.upstream;
    const r = await ask({
      title: "Reset to the Remote Branch",
      body: tx`Do you want to reset local branch ${local} to ${remote}? Local commits will be dropped`,
      icon: "warning",
      buttons: [
        { id: "ok", label: "OK", primary: true },
        { id: "cancel", label: "Cancel" },
      ],
    });
    if (r.button !== "ok") return;
  }
  await saveAll();
  await runRemote({ op: "resetToUpstream" }, branch?.upstream ? `${branch.head} ← ${branch.upstream}` : undefined);
}

interface UpdateDialogProps {
  repos: Array<string | null>;
  onClose: () => void;
}

function UpdateDialog({ repos, onClose }: UpdateDialogProps) {
  const branch = useVcs((s) => s.branch);
  const single = useVcs((s) => s.roots.length <= 1);
  // Default from Settings › Version Control › Git › Update method; the choice is kept there.
  const [rebase, setRebase] = useState(() => workflowSettings().vcs.git.updateMethod === "rebase");
  const [hide, setHide] = useState(false);
  const run = async () => {
    onClose();
    const method = rebase ? "rebase" : "merge";
    if (method !== workflowSettings().vcs.git.updateMethod) await saveVcsSetting("vcs.git.updateMethod", method);
    if (hide) await saveVcsSetting("vcs.confirmation.showUpdateOptions", false);
    await updateProject(rebase, repos);
  };
  return (
    <Dialog
      open
      title="Update Project"
      onClose={onClose}
      width={single ? 540 : 420}
      footerStart={
        <div className={styles.updateActions}>
          {single && (
            <Button
              className={styles.updateReset}
              onClick={() => {
                onClose();
                void resetToRemoteBranch();
              }}
            >
              <T>Reset to the Remote Branch</T>
            </Button>
          )}
          <Checkbox checked={hide} onChange={setHide} label="Don't show again" />
        </div>
      }
      buttons={[
        { label: "OK", role: "default", autoFocus: true, onClick: () => void run() },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={`${styles.form} ${styles.updateForm}`}>
        <div className={styles.hint}>
          {branch?.upstream
            ? `Update ${branch.head ?? "HEAD"} from ${branch.upstream}${branch.behind ? ` (${branch.behind} incoming)` : ""}`
            : tx("The current branch has no tracked branch; git pull may fail.")}
        </div>
        <fieldset className={styles.updateOptions} aria-label={tx("Update type")}>
          <legend>
            <T>Update type:</T>
          </legend>
          <Radio
            className={styles.updateRadio}
            name="update"
            checked={!rebase}
            onChange={() => setRebase(false)}
            label={
              <span className={styles.radioText}>
                <T>Merge incoming changes into the current branch</T>
                <code className={styles.updateCommand}>
                  <T>git pull --no-rebase --ff</T>
                </code>
              </span>
            }
          />
          <Radio
            className={styles.updateRadio}
            name="update"
            checked={rebase}
            onChange={() => setRebase(true)}
            label={
              <span className={styles.radioText}>
                <T>Rebase the current branch on top of incoming changes</T>
                <code className={styles.updateCommand}>
                  <T>git pull --rebase</T>
                </code>
              </span>
            }
          />
        </fieldset>
        <div className={styles.hint}>
          {workflowSettings().vcs.git.saveChangesPolicy === "shelve" ? (
            <T>Uncommitted changes are shelved before the update and restored afterwards.</T>
          ) : (
            <T>Uncommitted changes are stashed before the update and restored afterwards.</T>
          )}
        </div>
      </div>
    </Dialog>
  );
}

const logOf = (branch: string, limit: number, range: string | null = null, repo = currentRepo()) =>
  call(commands.vcsLog(repo, { branch, path: null, author: null, text: null, range, skip: 0, limit }));

type PushSource = Pick<BranchInfo, "head" | "headCommit" | "upstream" | "outgoing">;

/** Outgoing commits of the current branch: `@{u}..HEAD`, or recent HEAD history without an upstream. */
export function outgoingQuery(upstream: string | null): { branch: string; range: string | null; limit: number } {
  return upstream ? { branch: "HEAD", range: "@{u}..HEAD", limit: 1000 } : { branch: "HEAD", range: null, limit: 50 };
}

/**
 * Outgoing commits of one repository in the multi-repository Push dialog. `@{u}` no
 * longer resolves once the upstream branch was deleted on the remote (the tracking
 * config remains, `upstream_of` still reports it): the commits no remote branch has
 * are listed instead, so the repository stays in the list, pushable.
 */
export async function pushRepoCommits(root: string, branch: PushSource): Promise<Commit[]> {
  if (!branch.head) return branch.headCommit ? unpushedCommits(root, branch.headCommit) : [];
  if (branch.outgoing) {
    const tip = `refs/heads/${branch.head}`;
    return logOf(tip, OUTGOING_LIMIT, `${branch.outgoing.reference}..${tip}`, root).catch(() =>
      unpushedCommits(root, tip),
    );
  }
  if (branch.outgoing === null || !branch.upstream) return unpushedCommits(root);
  const q = outgoingQuery(branch.upstream);
  return logOf(q.branch, q.limit, q.range, root).catch(() => unpushedCommits(root));
}

const RECENT_HISTORY_LIMIT = 50;
const OUTGOING_LIMIT = 1000;

function pushRemote(remotes: readonly string[], ...preferred: (string | null | undefined)[]): string | null {
  return (
    preferred.find((name) => name && remotes.includes(name)) ??
    (remotes.includes("origin") ? "origin" : (remotes[0] ?? null))
  );
}

function definePushRemote(repo: string | null, onAdded: () => void) {
  void executeAction("vcs.defineRemote", { repo, onAdded });
}

function targetOnRemote(choices: PushTargetChoices | null | undefined, remote: string | null) {
  return (
    choices?.destinations.find(({ selection }) => selection.remote === remote) ??
    (choices?.destination?.selection.remote === remote ? choices?.destination : null)
  );
}

interface TargetEdit {
  text: string;
  remote: string | null;
}

function editedTarget(edit: TargetEdit) {
  return stripRemotePrefix(edit.text.trim(), edit.remote);
}

function targetField(edit: TargetEdit | undefined | null, remote: string | null, initial: string) {
  if (!edit) return initial;
  return edit.remote === remote ? edit.text : editedTarget(edit);
}

async function unpushedCommits(root: string | null, tip = "HEAD"): Promise<Commit[]> {
  const branches = await call(commands.vcsBranches(root)).catch(() => []);
  const remotes = branches.filter((b) => b.remote).map((b) => `^refs/remotes/${b.name}`);
  if (!remotes.length) return logOf(tip, RECENT_HISTORY_LIMIT, null, root);
  return logOf(tip, OUTGOING_LIMIT, [tip, ...remotes].join(" "), root);
}

export interface PushTarget {
  repo?: string | null;
  /** Local branch to push (default: the current one). */
  branch?: string;
  /** Repositories represented by a branch selection. */
  repositories?: readonly string[];
  /** Push the selected commit (Push All up to Here). */
  revision?: Commit;
  /** Repositories selected in the preceding commit. */
  selected?: readonly (string | null)[];
  /** The exact sources and destinations that Git rejected. */
  review?: readonly PushReviewTarget[];
}

export interface PushReviewTarget extends InspectionTarget {
  repo: string;
}

export async function showPushDialog(target: PushTarget = {}) {
  const project = useProject.getState().project;
  const roots = target.review?.map(({ repo }) => repo) ?? target.repositories;
  const repositories = roots ? [...new Set(roots)] : undefined;
  if (repositories?.length === 0) return;
  const only = repositories?.length === 1 ? repositories[0] : target.repo;
  const repo = only === undefined ? undefined : (only ?? currentRepoRoot() ?? undefined);
  await refreshNow();
  if (useProject.getState().project !== project) return;
  const multi = repositories
    ? repositories.length > 1
    : useVcs.getState().roots.length > 1 && !target.branch && !target.revision;
  openDialog((close) =>
    multi ? (
      <MultiPushDialog
        only={target.review ? undefined : repo}
        repositories={repositories}
        branch={target.branch}
        selected={target.selected}
        review={target.review}
        onClose={close}
      />
    ) : (
      <PushDialog target={{ ...target, repo }} reviewed={target.review?.[0]?.selection} onClose={close} />
    ),
  );
}

/** Whether any of `roots` has a pre-push hook: the Push dialog then offers Run Git hooks. */
function usePrePushHook(roots: ReadonlyArray<string | null>): boolean {
  const [found, setFound] = useState(false);
  useEffect(() => {
    let alive = true;
    void Promise.all(roots.map((r) => call(commands.vcsHasHook(r, "pre-push")).catch(() => false))).then(
      (has) => alive && setFound(has.some(Boolean)),
    );
    return () => {
      alive = false;
    };
  }, [roots]);
  return found;
}

/** A repository in the multi-repository Push dialog. */
export interface RepoPush {
  root: string;
  branch: PushSource;
  commits: Commit[];
  choices?: PushTargetChoices | null;
  review?: PushSelection;
}

export function pushCandidates(repos: readonly RepoPush[]): RepoPush[] {
  return repos.filter((r) => r.branch.head || r.branch.headCommit);
}

const hasNothingToPush = (r: RepoPush) => !!r.branch.upstream && !r.commits.length;
const sourceLabel = (branch: PushSource) => branch.head ?? branch.headCommit?.slice(0, 8);
const detachedTitle = (revision: string | null) => (revision ? tx`Detached HEAD at ${revision}` : undefined);

/** One node of the multi-repository Push tree: a repo group with its outgoing commits. */
interface PushNode {
  key: string;
  repo: RepoPush;
  commit?: Commit;
  children?: PushNode[];
}

const PUSH_DIALOG_MAX_HEIGHT = 720;
const PUSH_DIALOG_WIDTH = 800;
const PUSH_DIALOG_MIN_WIDTH = 420;
const EMPTY_PUSH_COMMITS: Commit[] = [];

function PushCommitSubject({ commit }: { commit: Commit }) {
  const metadata = [commit.shortId, commit.author, formatTime(commit.timeMs)].filter(Boolean).join(" · ");
  return (
    <span className={styles.commitSubject} title={`${metadata}\n${commit.message.trimEnd() || commit.summary}`}>
      {commit.summary}
    </span>
  );
}

interface MultiPushDialogProps {
  only?: string;
  repositories?: readonly string[];
  branch?: string;
  selected?: readonly (string | null)[];
  review?: readonly PushReviewTarget[];
  onClose: () => void;
}

async function namedPushSource(root: string, name: string): Promise<PushSource> {
  const branches = await call(commands.vcsBranches(root));
  const branch = branches.find((b) => !b.remote && b.name === name);
  if (!branch) throw new Error(tx`Branch '${name}' is no longer available`);
  return { head: branch.name, headCommit: branch.commit || null, upstream: branch.upstream, outgoing: branch.outgoing };
}

function knownPushRef(outgoing: PushSource["outgoing"], remote: string | null, target: string | null): string | null {
  return outgoing && outgoing.remote === remote && outgoing.branch === target ? outgoing.reference : null;
}

async function namedPushCommits(root: string, name: string, branch: PushSource, destination: DefaultPushTarget | null) {
  const tip = `refs/heads/${name}`;
  const target = destination?.selection;
  const tracking = target ? (target.specialRef ? null : `${target.remote}/${target.target}`) : branch.upstream;
  const reference = target ? knownPushRef(branch.outgoing, target.remote, target.target) : branch.outgoing?.reference;
  const unpushed = () => unpushedCommits(root, tip);
  const base = reference ?? (tracking ? `refs/remotes/${tracking}` : null);
  return base ? logOf(tip, OUTGOING_LIMIT, `${base}..${tip}`, root).catch(unpushed) : unpushed();
}

async function reviewedPushCommits(repo: string, selection: PushSelection): Promise<Commit[]> {
  const tip = selection.revision ?? (selection.branch ? `refs/heads/${selection.branch}` : null);
  if (!tip) return [];
  const tracking = `refs/remotes/${selection.remote}/${selection.target}`;
  return logOf(tip, OUTGOING_LIMIT, `${tracking}..${tip}`, repo).catch(() => unpushedCommits(repo, tip));
}

function hasReviewedRemoteTip(inspection: PushInspection | undefined) {
  return !!inspection?.remoteChecked && inspection.remoteTip !== null && inspection.state !== "fetchRequired";
}

function MultiPushDialog({
  only,
  repositories,
  branch: selectedBranch,
  selected,
  review,
  onClose,
}: MultiPushDialogProps) {
  const rowHeight = useRowHeight(22);
  const allRoots = useVcs((s) => s.roots);
  const roots = useMemo(
    () => repositories ?? (only === undefined ? allRoots : allRoots.filter((r) => r === only)),
    [repositories, allRoots, only],
  );
  const [repos, setRepos] = useState<RepoPush[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(repositories ?? (only === undefined ? [] : [only])),
  );
  // The selected row: a repository shows all its outgoing changes, a commit its own.
  const [shown, setShown] = useState<PushNode | null>(null);
  const [loadErrors, setLoadErrors] = useState<Array<{ root: string; message: string }>>([]);
  const [project] = useState(() => useProject.getState().project);
  const [force, setForce] = useState(false);
  const tagOptions = usePushTagOptions();
  const hasHook = usePrePushHook(roots);
  const [runHooks, setRunHooks] = useState(true);
  const [remotesOf, setRemotesOf] = useState<Record<string, string[]>>({});
  const [edits, setEdits] = useState<Record<string, { remote?: string; target?: TargetEdit }>>(() =>
    Object.fromEntries(
      (review ?? []).map(({ repo, selection }) => [
        repo,
        { remote: selection.remote, target: { text: selection.target, remote: null } },
      ]),
    ),
  );
  const edit = (root: string, change: { remote?: string; target?: TargetEdit }) =>
    setEdits((prev) => ({ ...prev, [root]: { ...prev[root], ...change } }));

  useEffect(() => {
    let alive = true;
    const requests = roots.map(() => nextRequestId());
    // A repository whose branch info cannot be read is left out; a deleted upstream
    // branch falls back to recent history (pushRepoCommits) and stays pushable.
    Promise.allSettled(
      roots.map(async (root, index) => {
        const remotes = call(commands.vcsRemotes(root));
        const reviewed = review?.find((target) => target.repo === root)?.selection;
        const source = reviewed?.branch ?? selectedBranch ?? null;
        const revision = reviewed?.revision ?? null;
        const pushChoices = call(
          commands.vcsPushTargetChoices(root, requests[index]!, source, source ? null : revision),
        );
        const [branch, choices, remoteNames] = await Promise.all([
          revision
            ? { head: source, headCommit: revision, upstream: null }
            : source
              ? namedPushSource(root, source)
              : call(commands.vcsBranchInfo(root)),
          selectedBranch ? pushChoices : pushChoices.catch(() => null),
          (selectedBranch || reviewed ? remotes : remotes.catch(() => [])).then((list) => list.map((r) => r.name)),
        ]);
        const commits = reviewed
          ? await reviewedPushCommits(root, reviewed)
          : source
            ? await namedPushCommits(root, source, branch, choices?.destination ?? null)
            : await pushRepoCommits(root, branch);
        return { repo: { root, branch, commits, choices, review: reviewed }, remotes: remoteNames };
      }),
    ).then((results) => {
      if (!alive) return;
      const fulfilled = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      const loaded = fulfilled.map((r) => r.repo);
      setRemotesOf(Object.fromEntries(fulfilled.map((r) => [r.repo.root, r.remotes])));
      setLoadErrors(
        selectedBranch || review || !loaded.length
          ? results.flatMap((r, index) =>
              r.status === "rejected" ? [{ root: roots[index]!, message: errorMessage(r.reason) }] : [],
            )
          : [],
      );
      const list = pushCandidates(loaded);
      setRepos(list);
      // Push all checks what has outgoing commits, plus a new branch of the current repository;
      // Push… from one repository checks it unless it is up to date.
      const current = currentRepo();
      setChecked(
        new Set(
          list
            .filter((r) => {
              if (repositories) return true;
              if (selected) return selected.includes(r.root) || (selected.includes(null) && r.root === current);
              if (only !== undefined) return !hasNothingToPush(r);
              const destination = r.choices?.destination?.selection;
              const other = destination && `${destination.remote}/${destination.target}` !== r.branch.upstream;
              return r.branch.upstream ? r.commits.length > 0 || other : r.root === current;
            })
            .map((r) => r.root),
        ),
      );
    });
    return () => {
      alive = false;
      for (const request of requests) void commands.cancelRequest(request).catch(() => undefined);
    };
  }, [roots, only, repositories, selected, selectedBranch, review]);

  const toggle = (root: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (!next.delete(root)) next.add(root);
      return next;
    });
  const trackedOf = (r: RepoPush) => {
    const remotes = remotesOf[r.root] ?? [];
    const tracking = r.branch.upstream ? splitTracked(r.branch.upstream, remotes) : null;
    return tracking && remotes.includes(tracking.remote) ? tracking : null;
  };
  const defaultRemoteOf = (r: RepoPush) =>
    pushRemote(remotesOf[r.root] ?? [], r.choices?.destination?.selection.remote, trackedOf(r)?.remote);
  const shownRemoteOf = (r: RepoPush) => {
    const chosen = edits[r.root]?.remote;
    return chosen ? ((remotesOf[r.root] ?? []).includes(chosen) ? chosen : null) : defaultRemoteOf(r);
  };
  const destinationOf = (r: RepoPush) => targetOnRemote(r.choices, shownRemoteOf(r));
  const targetOf = (r: RepoPush) =>
    destinationOf(r)?.selection.target ??
    (trackedOf(r)?.remote === shownRemoteOf(r) ? trackedOf(r)?.branch : null) ??
    r.branch.head ??
    "detached";
  const targetNameOf = (r: RepoPush) => {
    const target = edits[r.root]?.target;
    return target ? editedTarget(target) : targetOf(r);
  };
  const specialTarget = (r: RepoPush) => {
    const reviewed = r.review;
    if (reviewed && reviewed.remote === shownRemoteOf(r) && reviewed.target === targetNameOf(r)) {
      return reviewed.specialRef;
    }
    return targetNameOf(r) === targetOf(r) && destinationOf(r)?.selection.specialRef;
  };
  const targetError = (r: RepoPush) =>
    shownRemoteOf(r) && !specialTarget(r) ? validateBranchName(targetNameOf(r), true, []) : null;
  const reloadDestination = async (r: RepoPush) => {
    if (useProject.getState().project !== project) return;
    try {
      const [remotes, choices] = await Promise.all([
        call(commands.vcsRemotes(r.root)),
        call(commands.vcsPushTargetChoices(r.root, nextRequestId(), r.branch.head, null)),
      ]);
      if (useProject.getState().project !== project) return;
      setRemotesOf((old) => ({ ...old, [r.root]: remotes.map(({ name }) => name) }));
      setRepos((old) => old?.map((repo) => (repo.root === r.root ? { ...repo, choices } : repo)) ?? old);
      setLoadErrors((old) => old.filter(({ root }) => root !== r.root));
    } catch (e) {
      if (useProject.getState().project !== project) return;
      setLoadErrors((old) => [
        ...old.filter(({ root }) => root !== r.root),
        { root: r.root, message: errorMessage(e) },
      ]);
    }
  };
  const optionsOf = (r: RepoPush, tags: PushTags | null) => ({
    forceWithLease: force && !isProtectedBranch(targetNameOf(r)) && !specialTarget(r),
    setUpstream:
      !!r.branch.head &&
      (targetNameOf(r) === targetOf(r) ? (destinationOf(r)?.setUpstream ?? !r.branch.upstream) : !r.branch.upstream),
    tags,
    noVerify: hasHook && !runHooks,
  });
  const retargetedRepo = (r: RepoPush) => shownRemoteOf(r) !== defaultRemoteOf(r) || targetNameOf(r) !== targetOf(r);
  // Push… from one repository always pushes it, like the single-repository dialog: an up-to-date
  // branch may still go to another target or carry tags.
  const picked = only === undefined ? (repos ?? []).filter((r) => checked.has(r.root)) : (repos ?? []);
  const selectionOf = (r: RepoPush): InspectionTarget | null => {
    const remote = shownRemoteOf(r);
    const target = targetNameOf(r);
    const specialRef = specialTarget(r);
    const { head: branch, headCommit } = r.branch;
    return remote && target && !targetError(r) && (branch || headCommit)
      ? {
          repo: r.root,
          selection: {
            branch,
            revision: r.review ? r.review.revision : branch ? null : headCommit,
            remote,
            target,
            ...(specialRef ? { specialRef } : {}),
          },
        }
      : null;
  };
  const canPush = picked.length > 0 && picked.every((r) => selectionOf(r));
  const inspection = usePushInspection(picked.map(selectionOf).filter((selection) => selection !== null));
  const outgoingKey = JSON.stringify(
    picked.flatMap((r) => {
      const target = selectionOf(r);
      if (!target) return [];
      const checked = inspection.resultOf(target);
      const remoteTip = checked?.state === "fetchRequired" ? null : checked?.remoteTip;
      if (remoteTip == null && !retargetedRepo(r)) return [];
      const { selection } = target;
      const tip = checked?.localTip ?? (selection.branch ? `refs/heads/${selection.branch}` : selection.revision);
      if (!tip) return [];
      const tracking = selection.specialRef
        ? null
        : (knownPushRef(r.branch.outgoing, selection.remote, selection.target) ??
          `refs/remotes/${selection.remote}/${selection.target}`);
      return [{ root: r.root, tip, base: remoteTip ?? tracking }];
    }),
  );
  const [outgoing, setOutgoing] = useState<{ key: string; commits: Record<string, Commit[]> } | null>(null);
  useEffect(() => {
    const reviews = JSON.parse(outgoingKey) as Array<{ root: string; tip: string; base: string | null }>;
    let active = true;
    void Promise.allSettled(
      reviews.map(
        async ({ root, tip, base }) =>
          [
            root,
            base
              ? await logOf(tip, OUTGOING_LIMIT, `${base}..${tip}`, root).catch(() => unpushedCommits(root, tip))
              : await unpushedCommits(root, tip),
          ] as const,
      ),
    ).then((results) => {
      if (active)
        setOutgoing({
          key: outgoingKey,
          commits: Object.fromEntries(results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []))),
        });
    });
    return () => {
      active = false;
    };
  }, [outgoingKey]);
  const outgoingOf = (r: RepoPush) =>
    (outgoing?.key === outgoingKey ? outgoing.commits[r.root] : undefined) ??
    ((only !== undefined || checked.has(r.root)) && retargetedRepo(r) ? EMPTY_PUSH_COMMITS : r.commits);
  const reviewReady = picked.every((r) => !r.review || hasReviewedRemoteTip(inspection.resultOf(selectionOf(r))));
  const forceAvailable = canPush && reviewReady && !inspection.missing.length && picked.some((r) => !specialTarget(r));
  const push = async () => {
    if (!canPush || inspection.fetching || useProject.getState().project !== project) return;
    if (inspection.needsFetch) return inspection.fetch();
    // Like the single-repository dialog: each forced target is confirmed first (once, when several
    // repositories push to the same one), and declining one pushes nothing.
    const forced = new Set<string>();
    for (const r of force && forceAvailable ? picked : []) {
      const target = targetNameOf(r);
      const remote = shownRemoteOf(r);
      if (!isProtectedBranch(target) && !specialTarget(r)) forced.add(remote ? `${remote}/${target}` : target);
    }
    for (const target of forced) if (!(await confirmForcePush(target))) return;
    if (useProject.getState().project !== project) return;
    const tags = tagOptions.rememberForPush();
    onClose();
    await pushTargets(
      picked.flatMap((r) => {
        const options = optionsOf(r, tags);
        options.forceWithLease &&= forceAvailable;
        const selection = selectionOf(r);
        if (!selection) return [];
        const op = selectedPushOperation(
          selection,
          options,
          options.forceWithLease || !selection.selection.branch ? inspection.resultOf(selection) : undefined,
        );
        const { remote, target } = selection.selection;
        const source = r.review?.revision?.slice(0, 8) ?? sourceLabel(r.branch);
        return [{ repo: r.root, op, detail: `${repoName(r.root)}: ${source} → ${remote}/${target}` }];
      }),
    );
  };
  const nodes: PushNode[] = (repos ?? []).map((repo) => ({
    key: repo.root,
    repo,
    children: outgoingOf(repo).map((commit) => ({ key: `${repo.root}:${commit.id}`, repo, commit })),
  }));

  const shownRepo = shown?.repo ?? (only !== undefined ? (repos?.[0] ?? null) : null);
  const repoCommits = shownRepo ? outgoingOf(shownRepo) : EMPTY_PUSH_COMMITS;
  const shownCommits = useMemo(
    () =>
      shown?.commit && repoCommits.some((commit) => commit.id === shown.commit?.id) ? [shown.commit] : repoCommits,
    [shown, repoCommits],
  );
  const {
    diff,
    show: showDiff,
    close: closeDiff,
  } = usePushDiff(shownRepo ? pushChangesKey(shownRepo.root, shownCommits) : "");

  return (
    <Dialog
      open
      title={only === undefined ? "Push Commits" : tx`Push Commits to ${repoName(only)}`}
      onClose={onClose}
      width={PUSH_DIALOG_WIDTH}
      minWidth={PUSH_DIALOG_MIN_WIDTH}
      minHeight={340}
      maxHeight={PUSH_DIALOG_MAX_HEIGHT}
      className={styles.pushDialog}
      resizable="both"
      footerStart={
        <div className={styles.pushOptions}>
          <Checkbox
            checked={force && forceAvailable}
            disabled={!forceAvailable || inspection.fetching}
            onChange={setForce}
            label="Force (with lease)"
          />
          {hasHook && <Checkbox checked={runHooks} onChange={setRunHooks} label="Run Git hooks" />}
          <PushTagOptions {...tagOptions} />
        </div>
      }
      buttons={[
        {
          label: inspection.needsFetch ? "Fetch" : force && forceAvailable ? "Force Push" : "Push",
          role: "default",
          autoFocus: true,
          disabled: !canPush || inspection.fetching,
          onClick: () => void push(),
        },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <PushInspectionBanner
        inspection={inspection}
        forceAllowed={inspection.incoming.every(({ selection }) => !isProtectedBranch(selection.target))}
        onUpdate={() => {
          onClose();
          showUpdateDialog();
        }}
        onShowLog={() => {
          onClose();
          void showInspectedCommits(inspection.incoming);
        }}
      />
      <PushCheckStatus
        outgoing={picked.map((repo) => ({ repo: repo.root, commits: outgoingOf(repo) }))}
        onReview={onClose}
      />
      <PushReview
        diff={diff}
        onClose={closeDiff}
        commits={
          <div className={styles.pushTreeWrap}>
            {loadErrors.map(({ root, message }) => (
              <div key={root} className={styles.error} role="alert">
                <strong>{repoName(root)}</strong> {message}
              </div>
            ))}
            {picked.flatMap((repo) => {
              const message = targetError(repo);
              return message
                ? [
                    <div key={repo.root} className={styles.error} role="alert">
                      <strong>{repoName(repo.root)}</strong> {tx(message)}
                    </div>,
                  ]
                : [];
            })}
            {!repos ? (
              <div className={styles.empty}>
                <Spinner size={14} />
              </div>
            ) : repos.length || !loadErrors.length ? (
              <Tree<PushNode>
                roots={nodes}
                getKey={(n) => n.key}
                getLabel={(n) => (n.commit ? n.commit.summary : repoName(n.repo.root))}
                getChildren={(n) => n.children}
                isExpandable={(n) => !!n.children?.length}
                expanded={expanded}
                onExpandedChange={(_next, node, open) =>
                  setExpanded((e) => {
                    const s = new Set(e);
                    if (open) s.add(node.key);
                    else s.delete(node.key);
                    return s;
                  })
                }
                selected={new Set(shown ? [shown.key] : [])}
                multiSelect={false}
                onSelectionChange={(_sel, lead) => setShown(lead)}
                rowHeight={rowHeight}
                aria-label="Outgoing commits"
                className={styles.boxList}
                empty={
                  <span>
                    <T>Everything is up to date</T>
                  </span>
                }
                renderNode={(n) =>
                  n.commit ? (
                    <PushCommitSubject commit={n.commit} />
                  ) : (
                    <span
                      className={styles.pushRepoRow}
                      data-idle={(!!n.repo.branch.upstream && !n.children?.length) || undefined}
                      // A row click toggles the checkbox, like before; only the chevron collapses.
                      onClick={(e) => {
                        if (only === undefined && !(e.target as HTMLElement | null)?.closest?.("label"))
                          toggle(n.repo.root);
                      }}
                    >
                      {only === undefined ? (
                        <Checkbox
                          checked={checked.has(n.repo.root)}
                          onChange={() => toggle(n.repo.root)}
                          className={styles.pushRepoName}
                          label={
                            <span className={styles.pushRepoLabel} title={repoName(n.repo.root)}>
                              {repoName(n.repo.root)}
                            </span>
                          }
                        />
                      ) : (
                        <span className={styles.pushRepoLabel} title={repoName(n.repo.root)}>
                          {repoName(n.repo.root)}
                        </span>
                      )}
                      <span
                        className={styles.pushSourceBranch}
                        title={n.repo.review?.revision ?? n.repo.branch.head ?? detachedTitle(n.repo.branch.headCommit)}
                      >
                        {n.repo.review?.revision?.slice(0, 8) ?? sourceLabel(n.repo.branch)}
                      </span>
                      <span className={styles.pushRowSeparator} aria-hidden>
                        →
                      </span>
                      <PushRowTarget
                        repo={n.repo.root}
                        source={n.repo.review ? n.repo.review.branch : n.repo.branch.head}
                        name={repoName(n.repo.root)}
                        remotes={remotesOf[n.repo.root] ?? []}
                        remote={shownRemoteOf(n.repo)}
                        onRemote={(remote) => edit(n.repo.root, { remote })}
                        target={targetField(edits[n.repo.root]?.target, shownRemoteOf(n.repo), targetOf(n.repo))}
                        onTarget={(text) => edit(n.repo.root, { target: { text, remote: shownRemoteOf(n.repo) } })}
                        changed={retargetedRepo(n.repo)}
                        error={targetError(n.repo)}
                        onDefine={() =>
                          definePushRemote(n.repo.root, () => {
                            const remote = shownRemoteOf(n.repo);
                            if (remote) edit(n.repo.root, { remote });
                            void reloadDestination(n.repo);
                          })
                        }
                        onEnter={() => {
                          if (canPush) void push();
                        }}
                      />
                      {shownRemoteOf(n.repo) && !n.repo.branch.upstream && (
                        <span className={styles.pushSourceBranch} title={tx("new remote branch")}>
                          {tx("new remote branch")}
                        </span>
                      )}
                    </span>
                  )
                }
              />
            ) : null}
          </div>
        }
        changes={
          shownRepo && (
            <PushChanges
              key={pushChangesKey(shownRepo.root, shownCommits)}
              repo={shownRepo.root}
              commits={shownCommits}
              onSelectFile={showDiff}
            />
          )
        }
      />
    </Dialog>
  );
}

function PushRemotePicker({
  remotes,
  remote,
  label,
  defineLabel,
  onRemote,
  onDefine,
}: {
  remotes: readonly string[];
  remote: string | null;
  label: string;
  defineLabel?: string;
  onRemote: (remote: string) => void;
  onDefine: () => void;
}) {
  if (!remote && !remotes.length) {
    return (
      <button type="button" className={styles.linkButton} aria-label={defineLabel} onClick={onDefine}>
        {tx("Define Remote…")}
      </button>
    );
  }
  return (
    <Select<string>
      variant="ghost"
      value={remote}
      placeholder="Remote"
      aria-label={label}
      onChange={(name) => (name ? onRemote(name) : onDefine())}
      options={[
        ...remotes.map((name) => ({ value: name, label: name, verbatim: true })),
        { value: "", label: "Define Remote…", icon: "plus" },
      ]}
    />
  );
}

/** Names on the chosen remote without its prefix (`origin/topic` → `topic`). */
function remoteTargetNames(branches: readonly Branch[], remote: string | null): string[] {
  if (!remote) return [];
  const prefix = `${remote}/`;
  return branches.filter((b) => b.remote && b.name.startsWith(prefix)).map((b) => b.name.slice(prefix.length));
}

/** The remote and target branch of one repository's row in the multi-repository Push tree. */
function PushRowTarget(props: {
  repo: string;
  source: string | null;
  name: string;
  remotes: string[];
  remote: string | null;
  onRemote: (remote: string) => void;
  target: string;
  onTarget: (target: string) => void;
  /** Pushed elsewhere than to the upstream: the field is marked so the difference is not missed. */
  changed: boolean;
  error: string | null;
  onDefine: () => void;
  onEnter: () => void;
}) {
  const branches = useBranches(props.repo, !!props.remote);
  const names = useMemo(() => remoteTargetNames(branches, props.remote), [branches, props.remote]);
  return (
    <span
      className={styles.pushRowTarget}
      // The tree would take typed keys for speed search and navigation, and a click for toggling the row.
      onKeyDown={(e) => {
        if (e.key !== "Escape" && e.key !== "Tab") e.stopPropagation();
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <PushRemotePicker
        remotes={props.remotes}
        remote={props.remote}
        label={tx`Remote of ${props.name}`}
        defineLabel={tx`Define Remote in ${props.name}`}
        onRemote={props.onRemote}
        onDefine={props.onDefine}
      />
      {props.remote && (
        <>
          <span className={styles.pushRowSeparator}>/</span>
          <TargetBranchInput
            label={tx`Target branch of ${props.name}`}
            value={props.target}
            branches={names}
            remote={props.remote}
            repo={props.repo}
            source={props.source}
            error={props.error}
            changed={props.changed}
            // Mono, so `ch` is exact: the field follows the branch name instead of a fixed width.
            style={{ width: `${Math.min(32, Math.max(10, props.target.length + 3))}ch` }}
            onChange={props.onTarget}
            onSubmit={props.onEnter}
            className={styles.pushRowInput}
          />
        </>
      )}
    </span>
  );
}

function PushDialog({
  target: pushTarget,
  reviewed,
  onClose,
}: {
  target: PushTarget;
  reviewed?: PushSelection;
  onClose: () => void;
}) {
  const rowHeight = useRowHeight(22);
  const [project] = useState(() => useProject.getState().project);
  const [repo] = useState(() => pushTarget.repo ?? currentRepo());
  const [root] = useState(() => repo ?? currentRepoRoot());
  const [branch] = useState(() => {
    const vcs = useVcs.getState();
    return root && root !== currentRepoRoot() ? vcs.heads[root] : vcs.branch;
  });
  // Branches the chosen remote already has, for the target branch field's suggestions.
  const liveBranches = useVcs((s) =>
    s.branchesLoaded && root === (s.repo ?? s.roots[0] ?? s.root) ? s.branches : null,
  );
  const scopedBranches = useBranches(repo, !liveBranches);
  const branches = liveBranches ?? scopedBranches;
  const [commits, setCommits] = useState<Commit[] | null>(null);
  // The commit whose changes are shown; -1: all outgoing commits.
  const [shownCommit, setShownCommit] = useState(-1);
  const shownCommits = useMemo(
    () => (commits && shownCommit >= 0 && commits[shownCommit] ? [commits[shownCommit]] : (commits ?? [])),
    [commits, shownCommit],
  );
  const { diff, show: showDiff, close: closeDiff } = usePushDiff(pushChangesKey(repo, shownCommits));
  const [error, setError] = useState<string | null>(null);
  const [force, setForce] = useState(false);
  const [remoteVersion, reloadRemote] = useState(0);
  const current = branch?.head ?? null;
  const requestedHead = reviewed ? reviewed.branch : (pushTarget.branch ?? current);
  const commitRevision = reviewed?.revision ?? pushTarget.revision?.id;
  const revision = reviewed
    ? reviewed.revision
    : (commitRevision ?? (requestedHead ? null : (branch?.headCommit ?? null)));
  const sourceKey = revision ?? requestedHead;
  const resolveRevision = reviewed?.branch ? null : (commitRevision ?? null);
  const [resolved, setResolved] = useState<{
    source: string;
    remoteVersion: number;
    target: PushTargetChoices | null;
    remotes: string[];
    error?: string;
  } | null>(null);
  useEffect(() => {
    if (!sourceKey) return;
    let active = true;
    const request = nextRequestId();
    const resolve = call(commands.vcsPushTargetChoices(repo, request, requestedHead, resolveRevision));
    void Promise.all([resolve, call(commands.vcsRemotes(repo))]).then(
      ([target, remotes]) => {
        if (active) setResolved({ source: sourceKey, remoteVersion, target, remotes: remotes.map(({ name }) => name) });
      },
      (failure) => {
        if (active)
          setResolved({ source: sourceKey, remoteVersion, target: null, remotes: [], error: errorMessage(failure) });
      },
    );
    return () => {
      active = false;
      void commands.cancelRequest(request).catch(() => undefined);
    };
  }, [repo, requestedHead, resolveRevision, sourceKey, remoteVersion]);
  const resolution = resolved?.source === sourceKey && resolved.remoteVersion === remoteVersion ? resolved : null;
  const remotes = resolution?.remotes ?? [];
  const defaultDestination = resolution?.target?.destination ?? null;
  const resolvingDestination = !!sourceKey && !resolution;
  const waitingForCommit = !!commitRevision && !resolution?.target;
  const head = reviewed ? reviewed.branch : commitRevision ? (resolution?.target?.branch ?? null) : requestedHead;
  const namedBranch = reviewed?.branch ?? pushTarget.branch;
  const sourceUnavailable =
    !!reviewed && !!head && !revision && !!resolution?.target && resolution.target.branch !== head;
  // Another branch, or a partial push: `git push <remote> <src>:<dst>` instead of the plain push.
  const explicit = !!head && (head !== current || !!commitRevision);
  const tracked =
    head && !explicit && branch && "upstream" in branch
      ? branch.upstream
      : (branches.find((b) => !b.remote && b.name === head)?.upstream ?? null);
  const source = head ?? revision?.slice(0, 8) ?? null;
  const parsedTracking = tracked ? splitTracked(tracked, remotes) : null;
  const tracking = parsedTracking && remotes.includes(parsedTracking.remote) ? parsedTracking : null;
  const trackedRemote = tracking?.remote ?? null;
  const trackedBranch = tracking?.branch ?? null;
  // The picked remote (Git › Push can target any configured remote, like IDEA).
  const [remoteOverride, setRemote] = useState<string | null>(reviewed?.remote ?? null);
  const defaultRemote = pushRemote(remotes, defaultDestination?.selection.remote, trackedRemote);
  const remote = remoteOverride ? (remotes.includes(remoteOverride) ? remoteOverride : null) : defaultRemote;
  const remoteDestination = targetOnRemote(resolution?.target, remote);
  const [upstreamOverride, setSetUpstream] = useState<boolean | null>(null);
  const tagOptions = usePushTagOptions();
  const hookRoots = useMemo(() => [repo], [repo]);
  const hasHook = usePrePushHook(hookRoots);
  const [runHooks, setRunHooks] = useState(true);
  const upstream = remote === trackedRemote ? tracked : null;
  const defaultTarget =
    remoteDestination?.selection.target ??
    (remote === trackedRemote ? trackedBranch : null) ??
    head ??
    (revision ? "detached" : null);
  const [targetOverride, setTargetName] = useState<TargetEdit | null>(
    reviewed ? { text: reviewed.target, remote: null } : null,
  );
  const targetName = targetField(targetOverride, remote, defaultTarget ?? "");
  const target = targetOverride ? editedTarget(targetOverride) : defaultTarget;
  const retarget = targetOverride !== null && target !== defaultTarget;
  const sameReview = reviewed && remote === reviewed.remote && target === reviewed.target;
  const specialRef = sameReview ? !!reviewed.specialRef : !retarget && !!remoteDestination?.selection.specialRef;
  const targetError = remote && target !== null && !specialRef ? validateBranchName(target, true, []) : null;
  const setUpstream =
    !!head &&
    !revision &&
    !specialRef &&
    (upstreamOverride ?? (!retarget ? remoteDestination?.setUpstream : undefined) ?? !tracked);
  const selection: InspectionTarget | null =
    source && remote && target && !targetError && !resolvingDestination && !resolution?.error && !sourceUnavailable
      ? {
          repo: root,
          selection: { branch: head, revision, remote, target, ...(specialRef ? { specialRef } : {}) },
        }
      : null;
  const inspection = usePushInspection(selection ? [selection] : []);
  const checked = inspection.resultOf(selection);
  const inspectedTip = checked?.state === "fetchRequired" ? null : checked?.remoteTip;

  const remoteBranchNames = useMemo(() => remoteTargetNames(branches, remote), [branches, remote]);
  const isTrackedTarget = remote === trackedRemote && target === trackedBranch;
  const sourceOutgoing =
    branch && "outgoing" in branch && branch.head === head
      ? branch.outgoing
      : branches.find((b) => !b.remote && b.name === head)?.outgoing;
  const configuredTrackingRef = specialRef ? null : knownPushRef(sourceOutgoing, remote, target);
  const hasTrackingRef = !!configuredTrackingRef || (!!target && remoteBranchNames.includes(target));

  useEffect(() => {
    if (waitingForCommit) return;
    let alive = true;
    (async () => {
      const tip = revision ?? (namedBranch && head ? `refs/heads/${head}` : head);
      if (!tip) return [];
      if (inspectedTip === "") return unpushedCommits(repo, tip);
      if (inspectedTip) return logOf(tip, OUTGOING_LIMIT, `${inspectedTip}..${tip}`, repo);
      if (configuredTrackingRef)
        return logOf(tip, OUTGOING_LIMIT, `${configuredTrackingRef}..${tip}`, repo).catch(() =>
          unpushedCommits(repo, tip),
        );
      if (head && !namedBranch && !explicit && isTrackedTarget) {
        // The tracked upstream: `@{u}` resolves it even when the name is ambiguous.
        return tracked
          ? logOf("HEAD", OUTGOING_LIMIT, "@{u}..HEAD", repo).catch(() => unpushedCommits(repo))
          : unpushedCommits(repo);
      }
      const chosen =
        remote && target && hasTrackingRef ? `refs/remotes/${remote}/${target}` : isTrackedTarget ? tracked : null;
      return chosen
        ? logOf(tip, OUTGOING_LIMIT, `${chosen}..${tip}`, repo).catch(() => unpushedCommits(repo, tip))
        : unpushedCommits(repo, revision ?? (namedBranch || explicit ? tip : "HEAD"));
    })()
      .then((c) => {
        if (alive) {
          setError(null);
          setCommits(c);
        }
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [
    head,
    namedBranch,
    upstream,
    explicit,
    revision,
    tracked,
    repo,
    isTrackedTarget,
    remote,
    target,
    inspectedTip,
    configuredTrackingRef,
    hasTrackingRef,
    waitingForCommit,
  ]);

  const targetLabel = remote && target ? `${remote}/${target}` : (upstream ?? tx("new remote branch"));
  const protectedTarget = !!target && isProtectedBranch(target);
  const forceAvailable =
    !!selection &&
    !protectedTarget &&
    !specialRef &&
    !inspection.missing.length &&
    (!reviewed || hasReviewedRemoteTip(checked));
  const push = async () => {
    if (!selection || inspection.fetching || useProject.getState().project !== project) return;
    if (inspection.needsFetch) return inspection.fetch();
    if (force && forceAvailable && !(await confirmForcePush(remote ? `${remote}/${target}` : (target ?? "")))) return;
    if (useProject.getState().project !== project) return;
    const options = {
      forceWithLease: force && forceAvailable,
      setUpstream,
      tags: tagOptions.rememberForPush(),
      noVerify: hasHook && !runHooks,
    };
    onClose();
    const op = selectedPushOperation(selection, options, options.forceWithLease || !head ? checked : undefined);
    await pushTargets([
      { repo, op, detail: `${head && revision ? `${head} up to ${revision.slice(0, 8)}` : source} → ${targetLabel}` },
    ]);
  };

  const commitList = (
    <div className={styles.pushListWrap}>
      {resolution?.error || error || sourceUnavailable ? (
        <div className={styles.error}>{resolution?.error ?? error ?? tx`Branch '${head}' is no longer available`}</div>
      ) : !commits ? (
        <div className={styles.empty}>
          <Spinner size={14} />
        </div>
      ) : (
        <List
          items={commits}
          getKey={(c) => c.id}
          activeIndex={shownCommit}
          onActiveChange={setShownCommit}
          rowHeight={rowHeight}
          aria-label="Outgoing commits"
          className={styles.boxList}
          empty={<span>{upstream ? tx("Everything is up to date") : tx("No commits")}</span>}
          renderItem={(c) => <PushCommitSubject commit={c} />}
        />
      )}
    </div>
  );
  return (
    <Dialog
      open
      title={
        source && remote && !waitingForCommit
          ? tx`Push Commits to ${remote && target ? `${remote}/${target}` : (upstream ?? txPart("remote"))}`
          : "Push"
      }
      onClose={onClose}
      width={commits?.length ? PUSH_DIALOG_WIDTH : 620}
      minWidth={PUSH_DIALOG_MIN_WIDTH}
      minHeight={340}
      maxHeight={PUSH_DIALOG_MAX_HEIGHT}
      className={styles.pushDialog}
      resizable="both"
      footerStart={
        <div className={styles.pushOptions}>
          <span title={protectedTarget ? `Force push to protected branch '${target}' is prohibited` : undefined}>
            <Checkbox
              checked={force && forceAvailable}
              disabled={!forceAvailable || inspection.fetching}
              onChange={setForce}
              label="Force (with lease)"
            />
          </span>
          {hasHook && <Checkbox checked={runHooks} onChange={setRunHooks} label="Run Git hooks" />}
          {remote && !revision && !specialRef && (
            <Checkbox
              checked={setUpstream}
              disabled={resolvingDestination}
              onChange={setSetUpstream}
              label="Set upstream"
            />
          )}
          <PushTagOptions {...tagOptions} />
        </div>
      }
      buttons={[
        {
          label: inspection.needsFetch ? "Fetch" : force && forceAvailable ? "Force Push" : "Push",
          role: "default",
          autoFocus: true,
          disabled: !selection || inspection.fetching,
          onClick: () => void push(),
        },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <PushInspectionBanner
        inspection={inspection}
        forceAllowed={!protectedTarget}
        onUpdate={() => {
          onClose();
          showUpdateDialog();
        }}
        onShowLog={() => {
          onClose();
          void showInspectedCommits(inspection.incoming);
        }}
      />
      {root && <PushCheckStatus outgoing={[{ repo: root, commits: commits ?? [] }]} onReview={onClose} />}
      <div className={styles.pushTargetBar}>
        <span className={styles.pushTargetSource} title={!head ? detachedTitle(revision) : undefined}>
          {!source
            ? tx("No commit to push")
            : !head
              ? `${source} →`
              : !remote || trackedBranch || !setUpstream
                ? `${head}${revision ? ` up to ${revision.slice(0, 8)}` : ""} →`
                : revision
                  ? tx`${head} has no upstream: commits up to ${revision.slice(0, 8)} will be pushed as a new branch:`
                  : tx`${head} has no upstream: it will be pushed as a new branch and tracked:`}
        </span>
        {source && resolution && !resolution.error && !waitingForCommit && (
          <div className={styles.pushTargetControls}>
            <PushRemotePicker
              remotes={remotes}
              remote={remote}
              label={tx("Remote")}
              onRemote={setRemote}
              onDefine={() =>
                definePushRemote(root, () => {
                  if (remote) setRemote(remote);
                  reloadRemote((version) => version + 1);
                })
              }
            />
            {remote && (
              <>
                <span className={styles.pushRowSeparator} aria-hidden>
                  /
                </span>
                <TargetBranchInput
                  value={targetName}
                  onChange={(text) => setTargetName({ text, remote })}
                  branches={remoteBranchNames}
                  remote={remote}
                  repo={root}
                  source={head}
                  error={targetError}
                />
              </>
            )}
            {retarget && (checked?.remoteTip === "" || (checked?.remoteTip == null && !hasTrackingRef)) && (
              <span className={styles.hint}>{tx("New")}</span>
            )}
          </div>
        )}
      </div>
      {targetError && (
        <div className={styles.error} role="alert">
          {tx(targetError)}
        </div>
      )}
      {commits?.length && !error ? (
        <PushReview
          diff={diff}
          onClose={closeDiff}
          commits={commitList}
          changes={
            <PushChanges
              key={pushChangesKey(repo, shownCommits)}
              repo={repo}
              commits={shownCommits}
              onShowAll={shownCommit >= 0 && commits.length > 1 ? () => setShownCommit(-1) : undefined}
              onSelectFile={showDiff}
            />
          }
        />
      ) : (
        commitList
      )}
    </Dialog>
  );
}

const SILENT_FORCE_PUSH_KEY = "openidea.vcs.silentForcePushTargets";

function silentForcePushTargets(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(SILENT_FORCE_PUSH_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** IDEA's force push confirmation, with "Don't warn about this target". */
async function confirmForcePush(target: string): Promise<boolean> {
  if (target && silentForcePushTargets().includes(target)) return true;
  const r = await ask({
    title: "Force Push",
    body: tx`You're going to force push to '${target}'. It may overwrite commits at the remote. Are you sure you want to proceed?`,
    icon: "warning",
    checkbox: target ? "Don't warn about this target" : undefined,
    buttons: [{ id: "force", label: "Force Push", primary: true }],
  });
  if (r.button !== "force") return false;
  if (r.checked && target) {
    try {
      localStorage.setItem(SILENT_FORCE_PUSH_KEY, JSON.stringify([...silentForcePushTargets(), target]));
    } catch {
      // Not remembered: the next force push asks again.
    }
  }
  return true;
}

/**
 * Rejected because the remote has commits we don't (non-fast-forward): an update helps.
 * Not a tag that already exists there, nor a hook or the server refusing it.
 */
export function isPushRejected(message: string): boolean {
  return /\((?:non-fast-forward|fetch first)\)|tip of your current branch is behind|remote contains work that you do/i.test(
    message,
  );
}

/** A force-with-lease push refused because the remote moved since the last fetch. */
export function isLeaseRejected(message: string): boolean {
  return /\(stale info\)/i.test(message);
}

interface RejectedPush {
  repo: string | null;
  source: string;
  upstream: string;
  divergence: PushDivergence | null;
}

/** Pushes and updates again at most this many times while the push keeps being rejected. */
const MAX_PUSH_ATTEMPTS = 10;

function rejectedSelection({ target: { repo, op }, error }: RemoteFailure<PushOp>): PushReviewTarget[] {
  if (op.op !== "pushSelected" || op.selection.specialRef) return [];
  const entries = errorMessage(error)
    .split(/\r?\n/)
    .filter((line) => line.startsWith("!\t"));
  if (entries.length !== 1) return [];
  const [, refs, reason] = entries[0]!.split("\t");
  if (refs?.split(":")[1] !== `refs/heads/${op.selection.target}`) return [];
  if (!/^\[rejected\] \((?:fetch first|non-fast-forward|stale info)\)$/.test(reason?.trim() ?? "")) return [];
  return pushReviewTarget(repo, op.selection);
}

function pushReviewTarget(repo: string | null, selection: PushSelection): PushReviewTarget[] {
  const root = repo ?? allRepos()[0] ?? useVcs.getState().root;
  return root ? [{ repo: root, selection }] : [];
}

export async function fetchAndReviewPush(review: readonly PushReviewTarget[]) {
  if (!review.length) return;
  const project = useProject.getState().project;
  const failures = await runRemoteRound(
    review.map(({ repo, selection }) => ({ repo, op: { op: "fetchPushTarget" as const, selection } })),
  );
  if (!failures || useProject.getState().project !== project) return;
  await showPushDialog({ review });
}

function pushReviewActions(review: readonly PushReviewTarget[]) {
  if (!review.length) return undefined;
  const project = useProject.getState().project;
  return [
    {
      label: "Fetch and Review…",
      run: () => {
        if (useProject.getState().project === project) void executeAction("vcs.push.fetchAndReview", review);
      },
    },
  ];
}

function pushFailed(
  failures: RemoteFailure<PushOp>[],
  total: number,
  rejected: boolean,
  pushed: readonly RepoPushOutcome[],
): false {
  const isPartial = ({ error }: RemoteFailure<PushOp>) => !!partialPushReport(error);
  const names = (items: RemoteFailure<PushOp>[]) =>
    items.flatMap(({ target }) => (target.repo ? [repoName(target.repo)] : [])).join(", ");
  const notPushed = names(failures.filter((failure) => !isPartial(failure)));
  const partiallyApplied = failures.filter(isPartial);
  const partial = names(partiallyApplied);
  const review = failures.flatMap(rejectedSelection);
  const target = review[0]?.selection;
  const destination = target ? `${target.remote}/${target.target}` : null;
  const lines = formatPushOutcomes(pushed, total > 1);
  if (total > 1) {
    if (notPushed) lines.push(tx`Not pushed: ${notPushed}. See the Git console for details.`);
    if (partial) lines.push(tx`Push reported errors in ${partial}. See the Git console for details.`);
  } else if (partiallyApplied.length) {
    lines.push(tx("Git reported an error after publishing these changes."));
  } else {
    lines.push(
      destination
        ? tx`"${destination}" has commits outside the push source. Fetch and review its latest commits before pushing again.`
        : tx(errorMessage(failures[0]!.error)),
    );
  }
  const actions = pushReviewActions(review);
  notifications().notify({
    group: "vcs",
    level: "error",
    key: "vcs.remote",
    userInitiated: true,
    title:
      pushed.length || failures.length < total
        ? "Push partially failed"
        : rejected || review.length
          ? "Push rejected"
          : "Push failed",
    body: lines.join("\n"),
    actions: partiallyApplied.length ? [...(actions ?? []), gitConsoleNotificationAction()] : actions,
  });
  return false;
}

function pushLeaseMoved(destination: string, review: readonly PushReviewTarget[] = []): false {
  notifications().notify({
    group: "vcs",
    level: "error",
    key: "vcs.remote",
    userInitiated: true,
    title: "Push rejected",
    body: tx`"${destination}" changed. Fetch and review its latest commits before pushing again.`,
    actions: pushReviewActions(review),
  });
  return false;
}

async function rejectedTrackedPush({
  target: { repo, op },
  error,
}: RemoteFailure<PushOp>): Promise<RejectedPush | null> {
  if (op.op === "pushBranch" || (op.op === "push" && op.force) || op.force_with_lease) return null;
  const data = error instanceof IpcError && error.data?.type === "pushRejected" ? error.data : null;
  // Porcelain failures without recovery data refer to a different ref, or include another rejection.
  const message = errorMessage(error);
  if (
    !data &&
    (partialPushReport(error) || op.op === "pushSelected" || !isPushRejected(message) || /^!\t/m.test(message))
  )
    return null;
  const branch = await call(commands.vcsBranchInfo(repo)).catch(() => null);
  if (!branch?.head || !branch.upstream || (data && (branch.head !== data.source || branch.upstream !== data.upstream)))
    return null;
  if (op.op === "pushSelected" && !pushesCurrentUpstream(op.selection, branch)) return null;
  return { repo, source: branch.head, upstream: branch.upstream, divergence: data?.divergence ?? null };
}

/** Pushes every selected repository before deciding how to recover the rejected group. */
export async function pushTargets(targets: readonly RemoteTarget<PushOp>[]): Promise<boolean> {
  const project = useProject.getState().project;
  const pushed: RepoPushOutcome[] = [];
  const options = { handled: () => true, onPushResult: (result: RepoPushOutcome) => pushed.push(result) };
  // A submodule must reach its remote before the enclosing repository publishes its pointer.
  let pending = [...targets].sort((a, b) => (b.repo?.length ?? 0) - (a.repo?.length ?? 0));
  let method: UpdateMethod | null = null;
  for (let attempt = 1; ; attempt++) {
    const failures = await runRemoteRound(pending, pending.length === 1 ? pending[0]?.detail : undefined, options);
    if (!failures || useProject.getState().project !== project) return false;
    if (!failures.length) {
      if (pushed.length) notifyPushResults(pushed, targets.length > 1);
      return true;
    }
    const { target, error } = failures[0]!;
    const { repo, op, detail } = target;
    const message = errorMessage(error);
    const creatingDetachedBranch =
      op.op === "pushSelected" && op.selection.branch === null && op.inspected?.remoteTip === "";
    if (
      targets.length === 1 &&
      (op.force_with_lease || creatingDetachedBranch) &&
      !partialPushReport(error) &&
      isLeaseRejected(message)
    ) {
      if (op.op === "pushSelected")
        return pushLeaseMoved(`${op.selection.remote}/${op.selection.target}`, rejectedSelection(failures[0]!));
      if (op.op === "push") {
        await offerForcePush(op, detail, repo);
        return false;
      }
    }
    const rejected = (await Promise.all(failures.map(rejectedTrackedPush))).filter((r) => r !== null);
    if (rejected.length !== failures.length || attempt >= MAX_PUSH_ATTEMPTS)
      return pushFailed(failures, targets.length, rejected.length === failures.length, pushed);
    const roots = allRepos();
    const choice: UpdateMethod | "force" | null = method ?? (await choosePushRecovery(rejected, roots));
    if (useProject.getState().project !== project) return false;
    if (!choice) return pushFailed(failures, targets.length, true, pushed);
    if (choice === "force") {
      const divergence = rejected[0]?.divergence;
      if (op.op === "pushBranch" || !divergence || isProtectedBranch(divergence.target))
        return pushFailed(failures, targets.length, true, pushed);
      const { source, remote, target } = divergence;
      const destination = `${remote}/${target}`;
      const failed = await runRemoteRound(
        [
          {
            repo,
            op: { op: "forcePushRejected", divergence, tags: op.tags ?? null, no_verify: op.no_verify ?? false },
          },
        ],
        `${source} → ${destination}`,
        options,
      );
      if (!failed || useProject.getState().project !== project) return false;
      if (failed.length) {
        if (!partialPushReport(failed[0]!.error) && isLeaseRejected(errorMessage(failed[0]!.error))) {
          return pushLeaseMoved(
            destination,
            pushReviewTarget(repo, { branch: source, revision: null, remote, target }),
          );
        }
        // The force retry uses the same repository and only the original push can be reviewed.
        return pushFailed([{ target: failures[0]!.target, error: failed[0]!.error }], targets.length, false, pushed);
      }
      notifyPushResults(pushed, targets.length > 1);
      return true;
    }
    method = choice;
    await saveAll();
    const stillTracked = await Promise.all(
      rejected.map(async ({ repo, source, upstream }) => {
        const branch = await call(commands.vcsBranchInfo(repo)).catch(() => null);
        return branch?.head === source && branch.upstream === upstream;
      }),
    );
    if (useProject.getState().project !== project) return false;
    if (stillTracked.includes(false)) return pushFailed(failures, targets.length, true, pushed);
    const pull = { op: "pull" as const, rebase: method === "rebase" };
    if (!(await runRemote(pull, tx("updating after rejected push"), roots))) return false;
    pending = failures.map((failure) => failure.target);
  }
}

/** Unpushed merge commits, which a rebase would linearize (and may need resolving again). */
async function hasOutgoingMerges(repo: string | null): Promise<boolean> {
  const commits = await logOf("HEAD", 1000, "@{u}..HEAD", repo).catch(() => []);
  return commits.some((c) => c.parents.length > 1);
}

/** The Push Rejected dialog, with an exact lease when both histories are local. */
async function choosePushRecovery(
  rejections: readonly RejectedPush[],
  roots: readonly (string | null)[],
): Promise<UpdateMethod | "force" | null> {
  const git = workflowSettings().vcs.git;
  if (git.autoUpdateOnPushRejected) return git.updateMethod;
  const merges = (await Promise.all(roots.map(hasOutgoingMerges))).some(Boolean);
  const { repo, source: branch, divergence } = rejections[0]!;
  const name = repo && roots.length > 1 ? repoName(repo) : null;
  const sharedBranch = rejections.every(({ source }) => source === branch);
  const rejected =
    rejections.length === 1
      ? name
        ? tx`Push of the current branch "${branch}" in repository "${name}" was rejected.`
        : tx`Push of the current branch "${branch}" was rejected.`
      : [
          sharedBranch
            ? tx`Push of the current branch "${branch}" was rejected in these repositories.`
            : tx("Push was rejected in these repositories."),
          ...rejections.map(({ repo, source }) => (sharedBranch ? repoName(repo!) : `${repoName(repo!)} (${source})`)),
        ].join("\n");
  const allKnown = rejections.every((r) => r.divergence);
  const known = rejections.length === 1 ? divergence : null;
  const protectedDivergence = allKnown
    ? rejections.find((r) => r.divergence && isProtectedBranch(r.divergence.target))?.divergence
    : null;
  const allowForce = !!known && !protectedDivergence;
  const target = known ? `${known.remote}/${known.target}` : "";
  const remoteCommits = known?.remoteCommits ?? 0;
  const incoming = known
    ? remoteCommits === 1
      ? tx`"${target}" has one commit that "${branch}" does not have.`
      : tx`"${target}" has ${remoteCommits} commits that "${branch}" does not have.`
    : rejections.length > 1 && allKnown
      ? tx("The remote branches contain commits that are missing locally.")
      : null;
  const why = merges
    ? tx(
        "Remote changes need to be merged before pushing.\n\nIn this case merge is highly recommended, because there are non-pushed merge commits. Rebasing them can lead to problems.",
      )
    : allowForce
      ? tx("Merge or rebase to keep the remote changes, or force push to replace them.")
      : tx("Remote changes need to be merged before pushing.");
  const protectedTarget = protectedDivergence ? `${protectedDivergence.remote}/${protectedDivergence.target}` : null;
  const prohibited = protectedTarget ? tx`Force pushing to "${protectedTarget}" is prohibited.` : null;
  const rebaseFirst = !merges && git.updateMethod === "rebase";
  const r = await ask({
    title: "Push Rejected",
    body: [rejected, incoming, why, prohibited].filter(Boolean).join("\n\n"),
    icon: "warning",
    width: 520,
    checkbox:
      "Remember the update method and update silently in the future. Change this later in Settings | Version Control.",
    buttons: [
      { id: "merge", label: "Merge", primary: !rebaseFirst },
      { id: "rebase", label: merges ? "Rebase Anyway" : "Rebase", primary: rebaseFirst },
      ...(allowForce ? [{ id: "force", label: "Force Push" }] : []),
      { id: "cancel", label: "Cancel" },
    ],
  });
  if (r.button === "force" && allowForce) return "force";
  if (r.button !== "merge" && r.button !== "rebase") return null;
  if (r.checked) await saveVcsSetting("vcs.git.autoUpdateOnPushRejected", true);
  // A merge chosen only because of the merge commits doesn't replace a preferred rebase.
  if (!merges && r.button !== git.updateMethod) await saveVcsSetting("vcs.git.updateMethod", r.button);
  return r.button;
}

/** A rejected force-with-lease push: says why and offers a plain force push. */
async function offerForcePush(op: Extract<RemoteOp, { op: "push" }>, detail: string | undefined, repo: string | null) {
  const branch = await call(commands.vcsBranchInfo(repo)).catch(() => null);
  const source = branch?.head ?? "HEAD";
  const target = branch?.upstream ?? tx("the remote");
  notifications().notify({
    group: "vcs",
    level: "error",
    key: "vcs.remote",
    title: "Push rejected",
    body: tx`Force-with-lease push ${source} to ${target} was rejected. Force-with-lease push prevents overriding remote changes that haven't been fetched to the local repository. Fetch recent changes to verify that they can be discarded safely and repeat the push operation.`,
    actions: [
      {
        label: "Force push anyway",
        run: () => void runRemote({ ...op, force_with_lease: false, force: true }, detail, [repo]),
      },
    ],
  });
}
