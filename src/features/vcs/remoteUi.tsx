/** Update Project and Push dialogs. */
import { useEffect, useState } from "react";
import type { BranchInfo, Commit, PushTags, RemoteOp } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { workflowSettings } from "@/platform/workflowSettings";
import { notifications } from "@/workbench/contributions";
import { Checkbox, Dialog, Input, List, Select, Spinner, T } from "@/ui";
import { ask } from "@/workbench/messages";
import { openDialog } from "./dialogs";
import { formatTime } from "./model";
import { allRepos, lastRemoteFailure, runRemote, saveAll } from "./ops";
import { currentRepo, refreshNow, repoName, useVcs } from "./store";
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

const logOf = (branch: string, limit: number, range: string | null = null, repo = currentRepo()) =>
  call(commands.vcsLog(repo, { branch, path: null, author: null, text: null, range, skip: 0, limit }));

/** Outgoing commits of the current branch: `@{u}..HEAD`, or recent HEAD history without an upstream. */
export function outgoingQuery(upstream: string | null): { branch: string; range: string | null; limit: number } {
  return upstream ? { branch: "HEAD", range: "@{u}..HEAD", limit: 1000 } : { branch: "HEAD", range: null, limit: 50 };
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

type PushRow = { type: "repo"; repo: RepoPush } | { type: "commit"; repo: RepoPush; commit: Commit };

function MultiPushDialog({ onClose }: { onClose: () => void }) {
  const roots = useVcs((s) => s.roots);
  const [repos, setRepos] = useState<RepoPush[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
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
        const commits = branch.head ? await logOf(q.branch, q.limit, q.range, root) : [];
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
  const rows: PushRow[] = (repos ?? []).flatMap((repo) => [
    { type: "repo" as const, repo },
    ...repo.commits.map((commit) => ({ type: "commit" as const, repo, commit })),
  ]);

  return (
    <Dialog
      open
      title="Push Commits"
      onClose={onClose}
      width={620}
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
      <div style={{ height: 340, display: "flex", flexDirection: "column", padding: "14px" }}>
        {error ? (
          <div className={styles.error}>{error}</div>
        ) : !repos ? (
          <div className={styles.empty}>
            <Spinner size={14} />
          </div>
        ) : (
          <List
            items={rows}
            getKey={(r) => (r.type === "repo" ? `repo:${r.repo.root}` : `${r.repo.root}:${r.commit.id}`)}
            rowHeight={22}
            aria-label="Outgoing commits"
            className={styles.boxList}
            // Clicks on the checkbox toggle it themselves.
            onActivate={(r, _i, e) => {
              if (r.type === "repo" && !(e.target as HTMLElement | null)?.closest?.("label")) toggle(r.repo.root);
            }}
            empty={
              <span>
                <T>Everything is up to date</T>
              </span>
            }
            renderItem={(r) =>
              r.type === "repo" ? (
                <span className={styles.commitRow} style={{ flex: 1, padding: 0 }}>
                  <Checkbox
                    checked={checked.has(r.repo.root)}
                    onChange={() => toggle(r.repo.root)}
                    label={repoName(r.repo.root)}
                  />
                  <span className={styles.commitMeta}>
                    {r.repo.branch.head} → {r.repo.branch.upstream ?? tx("new remote branch")}
                  </span>
                </span>
              ) : (
                <span className={styles.commitRow} style={{ flex: 1, padding: "0 0 0 24px" }}>
                  <span className={styles.commitHash}>{r.commit.shortId}</span>
                  <span className={styles.commitSubject}>{r.commit.summary}</span>
                  <span className={styles.commitMeta}>{r.commit.author}</span>
                  <span className={styles.commitMeta}>{formatTime(r.commit.timeMs)}</span>
                </span>
              )
            }
          />
        )}
      </div>
    </Dialog>
  );
}

function PushDialog({ target: pushTarget, onClose }: { target: PushTarget; onClose: () => void }) {
  const [repo] = useState(currentRepo);
  const [branch] = useState(() => useVcs.getState().branch);
  const [branches] = useState(() => useVcs.getState().branches);
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [force, setForce] = useState(false);
  const current = branch?.head ?? null;
  const head = pushTarget.branch ?? current;
  // Another branch, or a partial push: `git push <remote> <src>:<dst>` instead of the plain push.
  const explicit = head !== current || !!pushTarget.revision;
  const upstream = explicit
    ? (branches.find((b) => !b.remote && b.name === head)?.upstream ?? null)
    : (branch?.upstream ?? null);
  const revision = pushTarget.revision?.id ?? null;
  const [setUpstream, setSetUpstream] = useState(!upstream);
  const [pushTags, setPushTags] = useState(false);
  const [tagsMode, setTagsMode] = useState<PushTags>("all");

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!head) return [];
      if (!explicit) {
        const q = outgoingQuery(upstream);
        return logOf(q.branch, q.limit, q.range, repo);
      }
      const tip = revision ?? head;
      return upstream ? logOf(tip, 1000, `${upstream}..${tip}`, repo) : logOf(tip, 50, null, repo);
    })()
      .then((c) => alive && setCommits(c))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [head, upstream, explicit, revision]);

  const remote = upstream ? upstream.slice(0, upstream.indexOf("/")) : null;
  const defaultTarget = upstream ? upstream.slice(upstream.indexOf("/") + 1) : head;
  // IDEA's push target is editable: another name pushes to that branch of the same remote.
  const [targetName, setTargetName] = useState(defaultTarget ?? "");
  const edited = targetName.trim();
  const retarget = !!head && !!edited && edited !== defaultTarget;
  const target = retarget ? edited : defaultTarget;
  const targetLabel = retarget ? `${remote ? `${remote}/` : ""}${edited}` : (upstream ?? "new remote branch");
  const protectedTarget = !!target && isProtectedBranch(target);
  const push = async () => {
    if (force && !protectedTarget && !(await confirmForcePush(remote ? `${remote}/${target}` : (target ?? "")))) return;
    onClose();
    if ((explicit || retarget) && head) {
      await runRemote(
        {
          op: "pushBranch",
          branch: head,
          revision,
          force_with_lease: force && !protectedTarget,
          target: retarget ? edited : null,
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
      title={head ? tx`Push Commits to ${upstream ?? "remote"}` : "Push"}
      onClose={onClose}
      width={620}
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
          {!explicit && !retarget && (
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
          : upstream
            ? `${head}${revision ? ` up to ${revision.slice(0, 8)}` : ""} → ${remote}/`
            : revision
              ? tx`${head} has no upstream: commits up to ${revision.slice(0, 8)} will be pushed as a new branch:`
              : tx`${head} has no upstream: it will be pushed as a new branch and tracked:`}
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
      <div style={{ height: 300, display: "flex", flexDirection: "column", padding: "0 14px 14px" }}>
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
