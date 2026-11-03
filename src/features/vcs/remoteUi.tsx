/** Update Project and Push dialogs. */
import { useEffect, useMemo, useState } from "react";
import type { BranchInfo, Commit, PushTags, RemoteOp } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { workflowSettings } from "@/platform/workflowSettings";
import { notifications } from "@/workbench/contributions";
import { Checkbox, Dialog, Input, Select, Spinner, SplitGroup, SplitHandle, SplitPanel, T, Tree } from "@/ui";
import { ask } from "@/workbench/messages";
import { openDialog } from "./dialogs";
import { formatTime } from "./model";
import { allRepos, lastRemoteFailure, runRemote, saveAll } from "./ops";
import { currentRepo, refreshNow, repoName, useVcs } from "./store";
import { PushPreview } from "./PushPreview";
import styles from "./common.module.css";

/** Update Project…: the options dialog, or (Confirmation › Show options before Update off) the default method right away. */
export function showUpdateDialog() {
  const { vcs } = workflowSettings();
  if (!vcs.confirmation.showUpdateOptions) return void updateProject(vcs.git.updateMethod === "rebase");
  openDialog((close) => <UpdateDialog onClose={close} />);
}

async function updateProject(rebase: boolean) {
  await saveAll();
  const branch = useVcs.getState().branch;
  const repos = allRepos();
  const detail =
    repos.length > 1
      ? `${repos.length} repositories`
      : branch?.upstream
        ? `${branch.head} ← ${branch.upstream}`
        : undefined;
  await runRemote({ op: "pull", rebase }, detail, repos);
}

function UpdateDialog({ onClose }: { onClose: () => void }) {
  const branch = useVcs((s) => s.branch);
  // Default from Settings › Version Control › Git › Update method.
  const [rebase, setRebase] = useState(() => workflowSettings().vcs.git.updateMethod === "rebase");
  const run = async () => {
    onClose();
    await updateProject(rebase);
  };
  return (
    <Dialog
      open
      title="Update Project"
      onClose={onClose}
      width={420}
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

async function logOf(
  branch: string,
  limit: number,
  range: string | null = null,
  repo = currentRepo(),
  isCurrent: () => boolean = () => true,
): Promise<Commit[]> {
  const commits: Commit[] = [];
  // A preview must cover the whole push, including changes older than the first log page.
  while (isCurrent()) {
    const page = await call(
      commands.vcsLog(repo, { branch, path: null, author: null, text: null, range, skip: commits.length, limit }),
    );
    commits.push(...page);
    if (page.length < limit) return commits;
  }
  return commits;
}

/** Outgoing commits of the current branch: `@{u}..HEAD`, or HEAD history for a new branch; paged by `logOf`. */
export function outgoingQuery(upstream: string | null): { branch: string; range: string | null; limit: number } {
  return { branch: "HEAD", range: upstream ? "@{u}..HEAD" : null, limit: 1000 };
}

export interface PushTarget {
  /** Local branch to push (default: the current one). */
  branch?: string;
  /** Push only up to this commit of the branch (Push All up to Here). */
  revision?: Commit;
}

export async function showPushDialog(target: PushTarget = {}) {
  await refreshNow();
  // Several repositories: IDEA's dialog lists each one with outgoing commits.
  const multi = useVcs.getState().roots.length > 1 && !target.branch && !target.revision;
  openDialog((close) => (multi ? <MultiPushDialog onClose={close} /> : <PushDialog target={target} onClose={close} />));
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

/** Checked by default: repositories with outgoing commits (a new branch only in the selected one). */
export function defaultPushChecked(repos: readonly RepoPush[], selected: string | null): Set<string> {
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

function MultiPushDialog({ onClose }: { onClose: () => void }) {
  const roots = useVcs((s) => s.roots);
  const [repos, setRepos] = useState<RepoPush[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [force, setForce] = useState(false);
  const [pushTags, setPushTags] = useState(false);
  const [tagsMode, setTagsMode] = useState<PushTags>("all");

  useEffect(() => {
    let alive = true;
    // A repository that cannot be read (e.g. its upstream branch was deleted) is left out.
    Promise.allSettled(
      roots.map(async (root) => {
        const branch = await call(commands.vcsBranchInfo(root));
        const q = outgoingQuery(branch.upstream);
        const commits = branch.head ? await logOf(q.branch, q.limit, q.range, root, () => alive) : [];
        return { root, branch, commits };
      }),
    ).then((results) => {
      if (!alive) return;
      const loaded = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (!loaded.length && failed) {
        setError(failed.reason instanceof Error ? failed.reason.message : String(failed.reason));
        return;
      }
      const list = pushCandidates(loaded);
      setRepos(list);
      setChecked(defaultPushChecked(list, currentRepo()));
    });
    return () => {
      alive = false;
    };
  }, [roots]);

  const toggle = (root: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (!next.delete(root)) next.add(root);
      return next;
    });
  const targetOf = (r: RepoPush) =>
    r.branch.upstream ? r.branch.upstream.slice(r.branch.upstream.indexOf("/") + 1) : r.branch.head!;
  const picked = (repos ?? []).filter((r) => checked.has(r.root));
  const outgoingCount = picked.reduce((n, r) => n + r.commits.length, 0);
  const push = async () => {
    onClose();
    for (const r of picked) {
      const upstream = r.branch.upstream;
      const ok = await pushWithAutoUpdate(
        {
          op: "push",
          force_with_lease: force && !isProtectedBranch(targetOf(r)),
          set_upstream: !upstream,
          tags: pushTags ? tagsMode : null,
        },
        `${repoName(r.root)}: ${r.branch.head} → ${upstream ?? "new remote branch"}`,
        r.root,
      );
      if (!ok) return;
    }
  };
  const nodes: PushNode[] = (repos ?? []).map((repo) => ({
    key: repo.root,
    repo,
    children: repo.commits.map((commit) => ({ key: `${repo.root}:${commit.id}`, repo, commit })),
  }));
  // Selection reviews files only; the checkboxes remain the authority for what gets pushed.
  const preview = useMemo(
    () =>
      (repos ?? []).flatMap((r) => {
        const all = selected.has(r.root) || (!selected.size && checked.has(r.root));
        const commits = all ? r.commits : r.commits.filter((c) => selected.has(`${r.root}:${c.id}`));
        return commits.length ? [{ repo: r.root, commits }] : [];
      }),
    [repos, selected, checked],
  );

  return (
    <Dialog
      open
      title="Push Commits"
      onClose={onClose}
      width={980}
      resizable="both"
      footerStart={
        <>
          <Checkbox checked={force} onChange={setForce} label="Force (with lease)" />
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
      <div className={styles.pushReview}>
        <SplitGroup orientation="horizontal" className={styles.grow}>
          <SplitPanel id="commits" defaultSize="58%" minSize="220px">
            <div className={styles.pushCommits}>
              <div className={styles.pushPreviewBar}>
                <span className={styles.hint}>
                  {outgoingCount === 1 ? tx("1 outgoing commit") : tx`${outgoingCount} outgoing commits`}
                </span>
              </div>
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
                  rowHeight={22}
                  aria-label="Outgoing commits"
                  className={styles.boxList}
                  selected={selected}
                  onSelectionChange={setSelected}
                  multiSelect
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
                      <span className={styles.commitRow} style={{ flex: 1, padding: 0 }}>
                        <Checkbox
                          checked={checked.has(n.repo.root)}
                          onChange={() => toggle(n.repo.root)}
                          label={repoName(n.repo.root)}
                        />
                        <span className={styles.commitMeta}>
                          {n.repo.branch.head} → {n.repo.branch.upstream ?? tx("new remote branch")} (
                          {n.repo.commits.length})
                        </span>
                      </span>
                    )
                  }
                />
              )}
            </div>
          </SplitPanel>
          <SplitHandle />
          <SplitPanel id="files" minSize="200px">
            <PushPreview groups={preview} />
          </SplitPanel>
        </SplitGroup>
      </div>
    </Dialog>
  );
}

function PushDialog({ target: pushTarget, onClose }: { target: PushTarget; onClose: () => void }) {
  const [repo] = useState(currentRepo);
  const [branch] = useState(() => useVcs.getState().branch);
  const [branches] = useState(() => useVcs.getState().branches);
  const [outgoing, setOutgoing] = useState<{ key: string; commits: Commit[]; error: string | null } | null>(null);
  const [selection, setSelection] = useState<{ key: string; keys: ReadonlySet<string> } | null>(null);
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
  const upstream = trackedBranch ? (remote ? `${remote}/${trackedBranch}` : tracked) : tracked;
  const defaultTarget = trackedBranch ?? head;
  // IDEA's push target is editable: preview the destination that will actually receive the push.
  const [targetName, setTargetName] = useState(defaultTarget ?? "");
  const edited = targetName.trim();
  const retarget = !!head && !!edited && edited !== defaultTarget;
  const target = retarget ? edited : defaultTarget;
  const destination = remote && target ? `${remote}/${target}` : null;
  const queryKey = JSON.stringify([head, destination, explicit, revision, tracked, repo]);
  // A destination change immediately hides the previous result, without clearing state in an effect.
  const commits = outgoing?.key === queryKey ? outgoing.commits : null;
  const error = outgoing?.key === queryKey ? outgoing.error : null;
  const selected = useMemo(
    () => (selection?.key === queryKey ? selection.keys : new Set<string>()),
    [selection, queryKey],
  );

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
    // Closing or retargeting the dialog stops requesting further pages of the old range.
    const log = (tip: string, range: string | null = null) => logOf(tip, 1000, range, repo, () => alive);
    (async () => {
      if (!head) return [];
      if (!explicit && tracked && destination === tracked) {
        // The tracked upstream: `@{u}` resolves it even when the name is ambiguous.
        return log("HEAD", "@{u}..HEAD").catch(() => log("HEAD"));
      }
      const tip = revision ?? head;
      // A new destination has no local tracking ref yet: review the branch's full history.
      return destination ? log(tip, `${destination}..${tip}`).catch(() => log(tip)) : log(tip);
    })()
      .then((c) => alive && setOutgoing({ key: queryKey, commits: c, error: null }))
      .catch(
        (e) => alive && setOutgoing({ key: queryKey, commits: [], error: e instanceof Error ? e.message : String(e) }),
      );
    return () => {
      alive = false;
    };
  }, [head, destination, explicit, revision, tracked, repo, queryKey]);

  const preview = useMemo(
    () => [{ repo, commits: (commits ?? []).filter((c) => !selected.size || selected.has(c.id)) }],
    [repo, commits, selected],
  );
  // A remote different from the tracked one always goes through `pushBranch`.
  const remoteChanged = !!remote && remote !== trackedRemote;
  const targetLabel =
    remoteChanged || retarget ? `${remote ? `${remote}/` : ""}${target}` : (upstream ?? "new remote branch");
  const protectedTarget = !!target && isProtectedBranch(target);
  const push = async () => {
    if (force && !protectedTarget && !(await confirmForcePush(remote ? `${remote}/${target}` : (target ?? "")))) return;
    onClose();
    if ((explicit || retarget || remoteChanged) && head) {
      await runRemote(
        {
          op: "pushBranch",
          branch: head,
          revision,
          force_with_lease: force && !protectedTarget,
          target: retarget ? edited : null,
          remote: remoteChanged ? remote : null,
        },
        `${revision ? `${head} up to ${revision.slice(0, 8)}` : head} → ${targetLabel}`,
        [repo],
      );
      return;
    }
    await pushWithAutoUpdate(
      {
        op: "push",
        force_with_lease: force && !protectedTarget,
        set_upstream: setUpstream || !upstream,
        tags: pushTags ? tagsMode : null,
      },
      upstream ? `${head} → ${upstream}` : `${head} → new remote branch`,
      repo,
    );
  };

  return (
    <Dialog
      open
      title={head ? tx`Push Commits to ${targetLabel}` : "Push"}
      onClose={onClose}
      width={980}
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
          {!explicit && !retarget && !remoteChanged && (
            <>
              <Checkbox
                checked={setUpstream || !upstream}
                disabled={!upstream}
                onChange={setSetUpstream}
                label="Set upstream"
              />
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
          <Input
            aria-label="Target branch"
            mono
            value={targetName}
            onChange={(e) => setTargetName(e.target.value)}
            className={styles.targetInput}
          />
        )}
        {retarget && <span className={styles.hint}> {tx("New")}</span>}
      </div>
      <div className={styles.pushReview}>
        <SplitGroup orientation="horizontal" className={styles.grow}>
          <SplitPanel id="commits" defaultSize="58%" minSize="220px">
            <div className={styles.pushCommits}>
              <div className={styles.pushPreviewBar}>
                <span className={styles.hint}>
                  {commits
                    ? commits.length === 1
                      ? tx("1 outgoing commit")
                      : tx`${commits.length} outgoing commits`
                    : tx("Outgoing commits")}
                </span>
              </div>
              {error ? (
                <div className={styles.error}>{error}</div>
              ) : !commits ? (
                <div className={styles.empty}>
                  <Spinner size={14} />
                </div>
              ) : (
                <Tree<Commit>
                  roots={commits}
                  getKey={(c) => c.id}
                  getLabel={(c) => c.summary}
                  getChildren={() => undefined}
                  isExpandable={() => false}
                  selected={selected}
                  onSelectionChange={(keys) => setSelection({ key: queryKey, keys })}
                  multiSelect
                  rowHeight={22}
                  aria-label="Outgoing commits"
                  className={styles.boxList}
                  empty={<span>{upstream ? tx("Everything is up to date") : tx("No commits")}</span>}
                  renderNode={(c) => (
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
          </SplitPanel>
          <SplitHandle />
          <SplitPanel id="files" minSize="200px">
            <PushPreview groups={preview} />
          </SplitPanel>
        </SplitGroup>
      </div>
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

/** Rejected because the remote has commits we don't (non-fast-forward). */
export function isPushRejected(message: string): boolean {
  return /\[rejected\]|non-fast-forward|fetch first|updates were rejected/i.test(message);
}

/**
 * Pushes; when the push is rejected, either updates (pull with the configured
 * update method) and pushes again ("Auto-update if push of the current branch
 * was rejected") or offers to.
 */
export async function pushWithAutoUpdate(
  op: Extract<RemoteOp, { op: "push" }>,
  detail: string,
  repo: string | null = currentRepo(),
): Promise<boolean> {
  if (await runRemote(op, detail, [repo])) return true;
  const error = lastRemoteFailure();
  if (!error || op.force_with_lease || !isPushRejected(error)) return false;
  const git = workflowSettings().vcs.git;
  const updateAndPush = async () => {
    await saveAll();
    const pull = { op: "pull" as const, rebase: git.updateMethod === "rebase" };
    if (!(await runRemote(pull, "updating after rejected push", [repo]))) return false;
    return runRemote(op, detail, [repo]);
  };
  if (git.autoUpdateOnPushRejected) return updateAndPush();
  notifications().notify({
    level: "error",
    key: "vcs.remote",
    title: "Push rejected",
    body: "The remote contains commits that are not in your branch. Update the branch, then push again.",
    actions: [
      { label: git.updateMethod === "rebase" ? "Rebase and Push" : "Merge and Push", run: () => void updateAndPush() },
    ],
  });
  return false;
}
