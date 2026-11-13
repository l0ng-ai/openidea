/** Update Project and Push dialogs. */
import { useEffect, useMemo, useState } from "react";
import type { BranchInfo, Commit, PushTags, RemoteOp } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { workflowSettings, type UpdateMethod } from "@/platform/workflowSettings";
import { notifications } from "@/workbench/contributions";
import {
  Button,
  Checkbox,
  Dialog,
  Input,
  List,
  Select,
  Spinner,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  T,
  Tree,
} from "@/ui";
import { ask } from "@/workbench/messages";
import { openDialog } from "./dialogs";
import { saveVcsSetting } from "./settingsUi";
import { formatTime } from "./model";
import { allRepos, lastRemoteFailure, runRemote, saveAll } from "./ops";
import { PushChanges, pushChangesKey } from "./PushChanges";
import { pushOperation, splitTracked, type PushChoice } from "./pushTarget";
import { currentRepo, currentRepoRoot, loadBranches, refreshNow, repoName, useVcs } from "./store";
import { stripRemotePrefix, TargetBranchInput } from "./TargetBranchInput";
import styles from "./common.module.css";

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
  const repos = updateRepos(target);
  if (!vcs.confirmation.showUpdateOptions) return void updateProject(vcs.git.updateMethod === "rebase", repos);
  openDialog((close) => <UpdateDialog repos={repos} onClose={close} />);
}

async function updateProject(rebase: boolean, repos: Array<string | null>) {
  await saveAll();
  const branch = useVcs.getState().branch;
  const detail =
    repos.length > 1
      ? `${repos.length} repositories`
      : branch?.upstream
        ? `${branch.head} ← ${branch.upstream}`
        : undefined;
  await runRemote({ op: "pull", rebase }, detail, repos);
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
        <>
          {single && (
            <Button
              onClick={() => {
                onClose();
                void resetToRemoteBranch();
              }}
            >
              <T>Reset to the Remote Branch</T>
            </Button>
          )}
          <Checkbox checked={hide} onChange={setHide} label="Don't show again" />
        </>
      }
      buttons={[
        { label: "OK", role: "default", autoFocus: true, onClick: () => void run() },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form} role="radiogroup" aria-label={tx("Update type")}>
        <div className={styles.hint}>
          {branch?.upstream
            ? `Update ${branch.head ?? "HEAD"} from ${branch.upstream}${branch.behind ? ` (${branch.behind} incoming)` : ""}`
            : tx("The current branch has no tracked branch; git pull may fail.")}
        </div>
        <div className={styles.fieldLabel}>
          <T>Update type:</T>
        </div>
        <label className={styles.radioRow}>
          <input type="radio" name="update" checked={!rebase} onChange={() => setRebase(false)} />
          <span className={styles.radioText}>
            <T>Merge incoming changes into the current branch</T>
            <span className={styles.hint}>
              <T>git pull --no-rebase --ff</T>
            </span>
          </span>
        </label>
        <label className={styles.radioRow}>
          <input type="radio" name="update" checked={rebase} onChange={() => setRebase(true)} />
          <span className={styles.radioText}>
            <T>Rebase the current branch on top of incoming changes</T>
            <span className={styles.hint}>
              <T>git pull --rebase</T>
            </span>
          </span>
        </label>
        <div className={styles.hint}>
          <T>Uncommitted changes are stashed before the update and restored afterwards.</T>
        </div>
      </div>
    </Dialog>
  );
}

const logOf = (branch: string, limit: number, range: string | null = null, repo = currentRepo()) =>
  call(commands.vcsLog(repo, { branch, path: null, author: null, text: null, range, skip: 0, limit }));

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
export async function pushRepoCommits(root: string, branch: BranchInfo): Promise<Commit[]> {
  if (!branch.head) return [];
  const q = outgoingQuery(branch.upstream);
  return logOf(q.branch, q.limit, q.range, root).catch(() => unpushedCommits(root));
}

const RECENT_HISTORY_LIMIT = 50;
const OUTGOING_LIMIT = 1000;

async function unpushedCommits(root: string): Promise<Commit[]> {
  const branches = await call(commands.vcsBranches(root)).catch(() => []);
  const remotes = branches.filter((b) => b.remote).map((b) => `^refs/remotes/${b.name}`);
  if (!remotes.length) return logOf("HEAD", RECENT_HISTORY_LIMIT, null, root);
  return logOf("HEAD", OUTGOING_LIMIT, ["HEAD", ...remotes].join(" "), root);
}

export interface PushTarget {
  repo?: string | null;
  /** Local branch to push (default: the current one). */
  branch?: string;
  /** Push only up to this commit of the branch (Push All up to Here). */
  revision?: Commit;
}

export async function showPushDialog(target: PushTarget = {}) {
  await refreshNow();
  // Several repositories: IDEA's dialog lists each one with outgoing commits.
  const multi = useVcs.getState().roots.length > 1 && !target.branch && !target.revision;
  const only = target.repo === undefined ? undefined : (target.repo ?? currentRepoRoot() ?? undefined);
  openDialog((close) =>
    multi ? <MultiPushDialog only={only} onClose={close} /> : <PushDialog target={target} onClose={close} />,
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
  branch: BranchInfo;
  commits: Commit[];
}

/** Repositories with something to push: outgoing commits, or a branch without upstream. */
export function pushCandidates(repos: readonly RepoPush[]): RepoPush[] {
  return repos.filter((r) => r.branch.head && (r.branch.upstream ? r.commits.length > 0 : true));
}

/**
 * Checked by default: repositories with outgoing commits (a new branch only in the selected
 * one); with `onlySelected` (Push… from one repository's branch menu), only the selected one.
 */
export function defaultPushChecked(
  repos: readonly RepoPush[],
  selected: string | null,
  onlySelected = false,
): Set<string> {
  if (onlySelected) return new Set(repos.filter((r) => r.root === selected).map((r) => r.root));
  return new Set(
    repos.filter((r) => (r.branch.upstream ? r.commits.length > 0 : r.root === selected)).map((r) => r.root),
  );
}

/** One node of the multi-repository Push tree: a repo group with its outgoing commits. */
interface PushNode {
  key: string;
  repo: RepoPush;
  commit?: Commit;
  children?: PushNode[];
}

// A long outgoing list scrolls inside the dialog instead of growing it to the screen (IDEA: 800×450 centre panel).
const PUSH_DIALOG_MAX_HEIGHT = 720;

interface MultiPushDialogProps {
  only?: string;
  onClose: () => void;
}

function MultiPushDialog({ only, onClose }: MultiPushDialogProps) {
  const roots = useVcs((s) => s.roots);
  const [repos, setRepos] = useState<RepoPush[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  // The selected row: a repository shows all its outgoing changes, a commit its own.
  const [shown, setShown] = useState<PushNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [force, setForce] = useState(false);
  const [pushTags, setPushTags] = useState(false);
  const [tagsMode, setTagsMode] = useState<PushTags>("all");
  const hasHook = usePrePushHook(roots);
  const [runHooks, setRunHooks] = useState(true);
  const [remotesOf, setRemotesOf] = useState<Record<string, string[]>>({});
  const [edits, setEdits] = useState<Record<string, { remote?: string; target?: string }>>({});
  const edit = (root: string, change: { remote?: string; target?: string }) =>
    setEdits((prev) => ({ ...prev, [root]: { ...prev[root], ...change } }));

  useEffect(() => {
    let alive = true;
    // A repository whose branch info cannot be read is left out; a deleted upstream
    // branch falls back to recent history (pushRepoCommits) and stays pushable.
    Promise.allSettled(
      roots.map(async (root) => {
        const remotes = call(commands.vcsRemotes(root)).catch(() => []);
        const branch = await call(commands.vcsBranchInfo(root));
        const commits = await pushRepoCommits(root, branch);
        return { repo: { root, branch, commits }, remotes: (await remotes).map((r) => r.name) };
      }),
    ).then((results) => {
      if (!alive) return;
      const fulfilled = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      const loaded = fulfilled.map((r) => r.repo);
      setRemotesOf(Object.fromEntries(fulfilled.map((r) => [r.repo.root, r.remotes])));
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (!loaded.length && failed) {
        setError(failed.reason instanceof Error ? failed.reason.message : String(failed.reason));
        return;
      }
      const list = pushCandidates(loaded);
      setRepos(list);
      setChecked(only === undefined ? defaultPushChecked(list, currentRepo()) : defaultPushChecked(list, only, true));
    });
    return () => {
      alive = false;
    };
  }, [roots, only]);

  const toggle = (root: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (!next.delete(root)) next.add(root);
      return next;
    });
  const targetOf = (r: RepoPush) => (r.branch.upstream ? splitTracked(r.branch.upstream).branch : r.branch.head!);
  const trackedRemoteOf = (r: RepoPush) => (r.branch.upstream ? splitTracked(r.branch.upstream).remote : null);
  const shownRemoteOf = (r: RepoPush) => {
    const remotes = remotesOf[r.root] ?? [];
    return (
      edits[r.root]?.remote ?? trackedRemoteOf(r) ?? (remotes.includes("origin") ? "origin" : (remotes[0] ?? null))
    );
  };
  const targetNameOf = (r: RepoPush) => edits[r.root]?.target?.trim() || targetOf(r);
  const choiceOf = (r: RepoPush, tags: PushTags | null): PushChoice => ({
    head: r.branch.head!,
    tracked: r.branch.upstream,
    remote: edits[r.root]?.remote ?? null,
    target: edits[r.root]?.target ?? "",
    forceWithLease: force && !isProtectedBranch(targetNameOf(r)),
    setUpstream: false,
    tags,
    noVerify: hasHook && !runHooks,
  });
  const picked = (repos ?? []).filter((r) => checked.has(r.root));
  // Like the single-repository dialog: tags go only with plain pushes, so a retargeted repository hides them.
  const retargeted = picked.some((r) => pushOperation(choiceOf(r, null)).op === "pushBranch");
  const push = async () => {
    onClose();
    // Every picked repository is pushed even when another fails; the outcome is summed up.
    const session: PushSession = { method: null };
    const failed: string[] = [];
    for (const r of picked) {
      const upstream = r.branch.upstream;
      const op = pushOperation(choiceOf(r, pushTags && !retargeted ? tagsMode : null));
      const name = repoName(r.root);
      const remote = shownRemoteOf(r);
      // A retargeted push names a branch, so it has no tracked branch to update from when rejected.
      const ok =
        op.op === "pushBranch"
          ? await runRemote(op, `${name}: ${r.branch.head} → ${remote ? `${remote}/` : ""}${targetNameOf(r)}`, [r.root])
          : await pushWithAutoUpdate(
              op,
              `${name}: ${r.branch.head} → ${upstream ?? "new remote branch"}`,
              r.root,
              session,
            );
      if (!ok) failed.push(name);
    }
    const notPushed = failed.join(", ");
    if (failed.length && picked.length > 1)
      notifications().notify({
        group: "vcs",
        level: "error",
        key: "vcs.remote",
        title: failed.length < picked.length ? "Push partially failed" : "Push failed",
        body: tx`Not pushed: ${notPushed}. See the Git console for details.`,
      });
  };
  const nodes: PushNode[] = (repos ?? []).map((repo) => ({
    key: repo.root,
    repo,
    children: repo.commits.map((commit) => ({ key: `${repo.root}:${commit.id}`, repo, commit })),
  }));

  const shownRepo = shown?.repo ?? (repos?.length === 1 ? repos[0]! : null);
  const shownCommits = useMemo(() => (shown?.commit ? [shown.commit] : (shownRepo?.commits ?? [])), [shown, shownRepo]);

  return (
    <Dialog
      open
      title="Push Commits"
      onClose={onClose}
      width={repos?.some((r) => r.commits.length) ? 860 : 620}
      maxHeight={PUSH_DIALOG_MAX_HEIGHT}
      className={styles.pushDialog}
      resizable="both"
      footerStart={
        <>
          <Checkbox checked={force} onChange={setForce} label="Force (with lease)" />
          {hasHook && <Checkbox checked={runHooks} onChange={setRunHooks} label="Run Git hooks" />}
          {!retargeted && (
            <>
              <Checkbox checked={pushTags} onChange={setPushTags} label="Push tags:" />
              <Select<PushTags>
                value={tagsMode}
                disabled={!pushTags}
                aria-label="Tags to push"
                onChange={setTagsMode}
                options={[
                  { value: "all", label: "All" },
                  { value: "currentBranch", label: "Current Branch" },
                ]}
              />
            </>
          )}
        </>
      }
      buttons={[
        {
          label: force ? "Force Push" : "Push",
          role: "default",
          autoFocus: true,
          disabled: !picked.length,
          onClick: () => void push(),
        },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.pushTreeWrap}>
        {error ? (
          <div className={styles.error}>{error}</div>
        ) : !repos ? (
          <div className={styles.empty}>
            <Spinner size={14} />
          </div>
        ) : (
          <Tree<PushNode>
            roots={nodes}
            getKey={(n) => n.key}
            getLabel={(n) => (n.commit ? n.commit.summary : repoName(n.repo.root))}
            getChildren={(n) => n.children}
            isExpandable={(n) => !!n.children?.length}
            expanded={new Set(nodes.map((n) => n.key).filter((k) => !collapsed.has(k)))}
            onExpandedChange={(_next, node, open) =>
              setCollapsed((c) => {
                const s = new Set(c);
                if (open) s.delete(node.key);
                else s.add(node.key);
                return s;
              })
            }
            selected={new Set(shown ? [shown.key] : [])}
            multiSelect={false}
            onSelectionChange={(_sel, lead) => setShown(lead)}
            rowHeight={22}
            aria-label="Outgoing commits"
            className={styles.boxList}
            empty={
              <span>
                <T>Everything is up to date</T>
              </span>
            }
            renderNode={(n) =>
              n.commit ? (
                <span className={styles.commitRow} style={{ flex: 1, padding: 0 }}>
                  <span className={styles.commitHash}>{n.commit.shortId}</span>
                  <span className={styles.commitSubject}>{n.commit.summary}</span>
                  <span className={styles.commitMeta}>{n.commit.author}</span>
                  <span className={styles.commitMeta}>{formatTime(n.commit.timeMs)}</span>
                </span>
              ) : (
                <span
                  className={styles.commitRow}
                  style={{ flex: 1, padding: 0 }}
                  // A row click toggles the checkbox, like before; only the chevron collapses.
                  onClick={(e) => {
                    if (!(e.target as HTMLElement | null)?.closest?.("label")) toggle(n.repo.root);
                  }}
                >
                  <Checkbox
                    checked={checked.has(n.repo.root)}
                    onChange={() => toggle(n.repo.root)}
                    label={repoName(n.repo.root)}
                  />
                  <span className={styles.commitMeta}>{n.repo.branch.head} →</span>
                  <PushRowTarget
                    name={repoName(n.repo.root)}
                    remotes={remotesOf[n.repo.root] ?? []}
                    remote={shownRemoteOf(n.repo)}
                    onRemote={(remote) => edit(n.repo.root, { remote })}
                    target={edits[n.repo.root]?.target ?? targetOf(n.repo)}
                    onTarget={(target) => edit(n.repo.root, { target })}
                    changed={pushOperation(choiceOf(n.repo, null)).op === "pushBranch"}
                    onEnter={() => {
                      if (picked.length) void push();
                    }}
                  />
                  {!n.repo.branch.upstream && <span className={styles.commitMeta}>{tx("new remote branch")}</span>}
                </span>
              )
            }
          />
        )}
      </div>
      {shownRepo && (
        <PushChanges key={pushChangesKey(shownRepo.root, shownCommits)} repo={shownRepo.root} commits={shownCommits} />
      )}
    </Dialog>
  );
}

/** The remote and target branch of one repository's row in the multi-repository Push tree. */
function PushRowTarget(props: {
  name: string;
  remotes: string[];
  remote: string | null;
  onRemote: (remote: string) => void;
  target: string;
  onTarget: (target: string) => void;
  /** Pushed elsewhere than to the upstream: the field is marked so the difference is not missed. */
  changed: boolean;
  onEnter: () => void;
}) {
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
      {props.remotes.length > 1 ? (
        <Select<string>
          variant="ghost"
          value={props.remote ?? ""}
          aria-label={tx`Remote of ${props.name}`}
          onChange={props.onRemote}
          options={props.remotes.map((r) => ({ value: r, label: r }))}
        />
      ) : (
        props.remote && <span className={styles.commitMeta}>{props.remote}</span>
      )}
      {props.remote && <span className={styles.pushRowSeparator}>/</span>}
      <Input
        aria-label={tx`Target branch of ${props.name}`}
        mono
        value={props.target}
        data-changed={props.changed || undefined}
        // Mono, so `ch` is exact: the field follows the branch name instead of a fixed width.
        style={{ width: `${Math.min(32, Math.max(10, props.target.length + 3))}ch` }}
        onChange={(e) => props.onTarget(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
          e.preventDefault();
          props.onEnter();
        }}
        className={styles.pushRowInput}
      />
    </span>
  );
}

function PushDialog({ target: pushTarget, onClose }: { target: PushTarget; onClose: () => void }) {
  const [repo] = useState(currentRepo);
  const [branch] = useState(() => useVcs.getState().branch);
  const [branches] = useState(() => useVcs.getState().branches);
  // Branches the chosen remote already has, for the target branch field's suggestions.
  const liveBranches = useVcs((s) => s.branches);
  const branchesLoaded = useVcs((s) => s.branchesLoaded);
  const [commits, setCommits] = useState<Commit[] | null>(null);
  // The commit whose changes are shown; -1: all outgoing commits.
  const [shownCommit, setShownCommit] = useState(-1);
  const [pushSplit, setPushSplit] = useState(loadPushSplit);
  const keepPushSplit = (layout: Record<string, number>) => {
    setPushSplit(layout);
    savePushSplit(layout);
  };
  const shownCommits = useMemo(
    () => (commits && shownCommit >= 0 && commits[shownCommit] ? [commits[shownCommit]] : (commits ?? [])),
    [commits, shownCommit],
  );
  const [error, setError] = useState<string | null>(null);
  const [force, setForce] = useState(false);
  const [remotes, setRemotes] = useState<string[]>([]);
  const current = branch?.head ?? null;
  const head = pushTarget.branch ?? current;
  // Another branch, or a partial push: `git push <remote> <src>:<dst>` instead of the plain push.
  const explicit = head !== current || !!pushTarget.revision;
  const tracked = explicit
    ? (branches.find((b) => !b.remote && b.name === head)?.upstream ?? null)
    : (branch?.upstream ?? null);
  const revision = pushTarget.revision?.id ?? null;
  const trackedRemote = tracked ? tracked.slice(0, tracked.indexOf("/")) : null;
  const trackedBranch = tracked ? tracked.slice(tracked.indexOf("/") + 1) : null;
  // The picked remote (Git › Push can target any configured remote, like IDEA).
  const [remote, setRemote] = useState<string | null>(trackedRemote);
  const [setUpstream, setSetUpstream] = useState(!tracked);
  const [pushTags, setPushTags] = useState(false);
  const [tagsMode, setTagsMode] = useState<PushTags>("all");
  const hookRoots = useMemo(() => [repo], [repo]);
  const hasHook = usePrePushHook(hookRoots);
  const [runHooks, setRunHooks] = useState(true);
  const upstream = trackedBranch ? (remote ? `${remote}/${trackedBranch}` : tracked) : tracked;

  useEffect(() => {
    if (!branchesLoaded) void loadBranches().catch(() => undefined);
  }, [branchesLoaded]);

  // Names the chosen remote already has (`origin/feat` → `feat`), suggested in the target field.
  const remoteBranchNames = useMemo(() => {
    if (!remote) return [];
    const prefix = `${remote}/`;
    return liveBranches.filter((b) => b.remote && b.name.startsWith(prefix)).map((b) => b.name.slice(prefix.length));
  }, [liveBranches, remote]);

  useEffect(() => {
    let alive = true;
    call(commands.vcsRemotes(repo))
      .then((list) => {
        if (!alive) return;
        setRemotes(list.map((r) => r.name));
        setRemote((r) => r ?? (list.some((x) => x.name === "origin") ? "origin" : (list[0]?.name ?? null)));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [repo]);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!head) return [];
      if (!explicit && upstream === tracked) {
        // The tracked upstream: `@{u}` resolves it even when the name is ambiguous.
        return logOf("HEAD", 1000, "@{u}..HEAD", repo).catch(() => logOf("HEAD", 50, null, repo));
      }
      const tip = revision ?? head;
      // `remote/branch` may not exist locally yet: fall back to the recent history.
      return upstream
        ? logOf(tip, 1000, `${upstream}..${tip}`, repo).catch(() => logOf(tip, 50, null, repo))
        : logOf(tip, 50, null, repo);
    })()
      .then((c) => alive && setCommits(c))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [head, upstream, explicit, revision, tracked, repo]);

  const defaultTarget = trackedBranch ?? head;
  // IDEA's push target is editable: another name pushes to that branch of the same remote.
  const [targetName, setTargetName] = useState(defaultTarget ?? "");
  // The branch the remote ends up with: a typed `origin/feat` names the branch `feat` there.
  const edited = stripRemotePrefix(targetName.trim(), remote);
  const retarget = !!head && !!edited && edited !== defaultTarget;
  const target = retarget ? edited : defaultTarget;
  // A remote different from the tracked one always goes through `pushBranch`.
  const remoteChanged = !!remote && remote !== trackedRemote;
  const targetLabel =
    remoteChanged || retarget ? `${remote ? `${remote}/` : ""}${target}` : (upstream ?? "new remote branch");
  const protectedTarget = !!target && isProtectedBranch(target);
  const push = async () => {
    if (force && !protectedTarget && !(await confirmForcePush(remote ? `${remote}/${target}` : (target ?? "")))) return;
    onClose();
    if (!head) return;
    const op = pushOperation({
      head,
      tracked,
      remote,
      target: targetName,
      explicit,
      revision,
      forceWithLease: force && !protectedTarget,
      setUpstream,
      tags: pushTags ? tagsMode : null,
      noVerify: hasHook && !runHooks,
    });
    if (op.op === "pushBranch") {
      await runRemote(op, `${revision ? `${head} up to ${revision.slice(0, 8)}` : head} → ${targetLabel}`, [repo]);
      return;
    }
    await pushWithAutoUpdate(op, upstream ? `${head} → ${upstream}` : `${head} → new remote branch`, repo);
  };

  const commitList = (
    <div className={styles.pushListWrap}>
      {error ? (
        <div className={styles.error}>{error}</div>
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
          rowHeight={22}
          aria-label="Outgoing commits"
          className={styles.boxList}
          empty={<span>{upstream ? tx("Everything is up to date") : tx("No commits")}</span>}
          renderItem={(c) => (
            <span className={styles.commitRow} style={{ flex: 1, padding: 0 }}>
              <span className={styles.commitHash}>{c.shortId}</span>
              <span className={styles.commitSubject}>{c.summary}</span>
              <span className={styles.commitMeta}>{c.author}</span>
              <span className={styles.commitMeta}>{formatTime(c.timeMs)}</span>
            </span>
          )}
        />
      )}
    </div>
  );
  return (
    <Dialog
      open
      title={head ? tx`Push Commits to ${upstream ?? "remote"}` : "Push"}
      onClose={onClose}
      width={commits?.length ? 860 : 620}
      maxHeight={PUSH_DIALOG_MAX_HEIGHT}
      className={styles.pushDialog}
      resizable="both"
      footerStart={
        <>
          <span title={protectedTarget ? `Force push to protected branch '${target}' is prohibited` : undefined}>
            <Checkbox
              checked={force && !protectedTarget}
              disabled={protectedTarget}
              onChange={setForce}
              label="Force (with lease)"
            />
          </span>
          {hasHook && <Checkbox checked={runHooks} onChange={setRunHooks} label="Run Git hooks" />}
          {!revision && (
            <Checkbox
              checked={setUpstream || !tracked}
              disabled={!tracked}
              onChange={setSetUpstream}
              label="Set upstream"
            />
          )}
          {!explicit && !retarget && !remoteChanged && (
            <>
              <Checkbox checked={pushTags} onChange={setPushTags} label="Push tags:" />
              <Select<PushTags>
                value={tagsMode}
                disabled={!pushTags}
                aria-label="Tags to push"
                onChange={setTagsMode}
                options={[
                  { value: "all", label: "All" },
                  { value: "currentBranch", label: "Current Branch" },
                ]}
              />
            </>
          )}
        </>
      }
      buttons={[
        {
          label: force && !protectedTarget ? "Force Push" : "Push",
          role: "default",
          autoFocus: true,
          disabled: !head,
          onClick: () => void push(),
        },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.section}>
        {!head
          ? tx("HEAD is detached; check out a branch to push.")
          : trackedBranch
            ? `${head}${revision ? ` up to ${revision.slice(0, 8)}` : ""} → ${remote ?? trackedRemote ?? ""}/`
            : revision
              ? tx`${head} has no upstream: commits up to ${revision.slice(0, 8)} will be pushed as a new branch:`
              : tx`${head} has no upstream: it will be pushed as a new branch and tracked:`}
        {head && remotes.length > 1 && (
          <Select<string>
            value={remote ?? ""}
            aria-label="Remote"
            onChange={setRemote}
            options={remotes.map((r) => ({ value: r, label: r }))}
          />
        )}
        {head && (
          <TargetBranchInput value={targetName} onChange={setTargetName} branches={remoteBranchNames} remote={remote} />
        )}
        {retarget && !remoteBranchNames.includes(edited) && <span className={styles.hint}> {tx("New")}</span>}
      </div>
      {commits?.length && !error ? (
        <SplitGroup
          orientation="vertical"
          id="vcs-push-split"
          className={styles.pushSplit}
          defaultLayout={pushSplit}
          onLayoutChanged={keepPushSplit}
        >
          <SplitPanel id="commits" minSize="72px" defaultSize="35%" className={styles.pushSplitPanel}>
            {commitList}
          </SplitPanel>
          <SplitHandle />
          <SplitPanel id="changes" minSize="160px" className={styles.pushSplitPanel}>
            <PushChanges
              key={pushChangesKey(repo, shownCommits)}
              repo={repo}
              commits={shownCommits}
              onShowAll={shownCommit >= 0 && commits.length > 1 ? () => setShownCommit(-1) : undefined}
            />
          </SplitPanel>
        </SplitGroup>
      ) : (
        commitList
      )}
    </Dialog>
  );
}

const PUSH_SPLIT_KEY = "openidea.vcs.pushSplit";

/** Heights of the Push dialog's commits and changed files, as the splitter left them. */
function loadPushSplit(): Record<string, number> | undefined {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(PUSH_SPLIT_KEY) ?? "null");
    return v && typeof v === "object" && Object.values(v).every((n) => typeof n === "number")
      ? (v as Record<string, number>)
      : undefined;
  } catch {
    return undefined;
  }
}

function savePushSplit(layout: Record<string, number>) {
  try {
    localStorage.setItem(PUSH_SPLIT_KEY, JSON.stringify(layout));
  } catch {
    /* kept for this dialog only */
  }
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

/** Settings › Git › Protected branches: `;`/`,`-separated globs (`*`, `?`). */
export function isProtectedBranch(branch: string, patterns = workflowSettings().vcs.git.protectedBranches): boolean {
  return patterns
    .split(/[;,\s]+/)
    .filter(Boolean)
    .some((p) =>
      new RegExp(
        `^${p
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".")}$`,
      ).test(branch),
    );
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

/** One Push of several repositories: the update method is asked for once. */
interface PushSession {
  method: UpdateMethod | null;
}

/** Pushes and updates again at most this many times while the push keeps being rejected. */
const MAX_PUSH_ATTEMPTS = 10;

/**
 * Pushes the current branch; when the push is rejected because the remote has new
 * commits, updates every repository with the method chosen in the Push Rejected
 * dialog (or, with "update silently", the configured one) and pushes again, as long
 * as it keeps being rejected. A rejected forced push offers neither.
 */
export async function pushWithAutoUpdate(
  op: Extract<RemoteOp, { op: "push" }>,
  detail: string,
  repo: string | null = currentRepo(),
  session: PushSession = { method: null },
): Promise<boolean> {
  // A rejection that leads to an update is reported by the Push Rejected dialog instead.
  const updatable = (message: string) => !op.force && !op.force_with_lease && isPushRejected(message);
  const rejected = (message: string) => {
    notifications().notify({ group: "vcs", level: "error", key: "vcs.remote", title: "Push rejected", body: message });
    return false;
  };
  for (let attempt = 1; ; attempt++) {
    if (await runRemote(op, detail, [repo], updatable)) return true;
    const error = lastRemoteFailure();
    if (!error) return false;
    if (op.force_with_lease && isLeaseRejected(error)) {
      offerForcePush(op, detail, repo);
      return false;
    }
    if (!updatable(error)) return false;
    if (attempt >= MAX_PUSH_ATTEMPTS) return rejected(error);
    // Only the tracked branch is brought up to date: a new remote branch has nothing to update from.
    const branch = await call(commands.vcsBranchInfo(repo)).catch(() => null);
    if (!branch?.head || !branch.upstream) return rejected(error);
    session.method ??= await chooseUpdateMethod(repo, branch.head);
    if (!session.method) return rejected(error);
    await saveAll();
    const pull = { op: "pull" as const, rebase: session.method === "rebase" };
    if (!(await runRemote(pull, tx("updating after rejected push"), allRepos()))) return false;
  }
}

/** Unpushed merge commits, which a rebase would linearize (and may need resolving again). */
async function hasOutgoingMerges(repo: string | null): Promise<boolean> {
  const commits = await logOf("HEAD", 1000, "@{u}..HEAD", repo).catch(() => []);
  return commits.some((c) => c.parents.length > 1);
}

/** The Push Rejected dialog: Merge or Rebase, optionally remembered as the silent update. */
async function chooseUpdateMethod(repo: string | null, branch: string): Promise<UpdateMethod | null> {
  const git = workflowSettings().vcs.git;
  if (git.autoUpdateOnPushRejected) return git.updateMethod;
  const merges = await hasOutgoingMerges(repo);
  const name = repo && useVcs.getState().roots.length > 1 ? repoName(repo) : null;
  const rejected = name
    ? tx`Push of the current branch "${branch}" in repository "${name}" was rejected.`
    : tx`Push of the current branch "${branch}" was rejected.`;
  const why = merges
    ? tx(
        "Remote changes need to be merged before pushing.\n\nIn this case merge is highly recommended, because there are non-pushed merge commits. Rebasing them can lead to problems.",
      )
    : tx("Remote changes need to be merged before pushing.");
  const rebaseFirst = !merges && git.updateMethod === "rebase";
  const r = await ask({
    title: "Push Rejected",
    body: `${rejected}\n\n${why}`,
    icon: "warning",
    width: 520,
    checkbox:
      "Remember the update method and update silently in the future. Change this later in Settings | Version Control.",
    buttons: [
      { id: "merge", label: "Merge", primary: !rebaseFirst },
      { id: "rebase", label: merges ? "Rebase Anyway" : "Rebase", primary: rebaseFirst },
      { id: "cancel", label: "Cancel" },
    ],
  });
  if (r.button !== "merge" && r.button !== "rebase") return null;
  if (r.checked) await saveVcsSetting("vcs.git.autoUpdateOnPushRejected", true);
  // A merge chosen only because of the merge commits doesn't replace a preferred rebase.
  if (!merges && r.button !== git.updateMethod) await saveVcsSetting("vcs.git.updateMethod", r.button);
  return r.button;
}

/** A rejected force-with-lease push: says why and offers a plain force push. */
function offerForcePush(op: Extract<RemoteOp, { op: "push" }>, detail: string, repo: string | null) {
  const branch = useVcs.getState().branch;
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
