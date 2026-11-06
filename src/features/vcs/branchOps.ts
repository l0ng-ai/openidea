/** Branch operations (checkout, create, merge, rebase, update, delete) with recents and favorites. */
import { create } from "zustand";
import type { Branch, BranchInfo, CheckoutOptions } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { call, commands } from "@/platform/ipc";
import { notifications } from "@/workbench/contributions";
import { ask } from "@/workbench/messages";
import { isFavoriteBranch, pushRecent, shortRemoteName } from "./branches";
import { showCommitRange } from "./CompareBranches";
import { confirmDialog, promptText } from "./dialogs";
import { cleanUpBranchNameOnTyping } from "@/platform/gitRefName";
import { runOp, runRemote, saveAll } from "./ops";
import { conflictedFiles, currentRepo, refreshNow, repoName, useVcs } from "./store";
import { tx } from "@/platform/i18n";

const recentKey = () => `openidea.vcs.recentBranches:${useVcs.getState().root ?? ""}`;

export function recentBranches(): string[] {
  try {
    const raw = localStorage.getItem(recentKey());
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function rememberBranch(name: string | null | undefined) {
  if (!name) return;
  try {
    localStorage.setItem(recentKey(), JSON.stringify(pushRecent(recentBranches(), name)));
  } catch {
    // Storage unavailable: recents are a convenience only.
  }
}

/** Valid-enough git ref name check (mirrors `git check-ref-format` basics). */
export function validateBranchName(name: string): string | null {
  const n = name.trim();
  if (!n) return "Branch name must not be empty";
  if (/[\s~^:?*[\\\p{Cc}]/u.test(n)) return "Branch name contains invalid characters";
  if (n.startsWith("-") || n.startsWith("/") || n.endsWith("/") || n.endsWith(".") || n.endsWith(".lock"))
    return "Invalid branch name";
  if (n.includes("..") || n.includes("//") || n.includes("@{") || n === "@") return "Invalid branch name";
  const exists = useVcs.getState().branches.some((b) => !b.remote && b.name === n);
  if (exists) return `Branch '${n}' already exists`;
  return null;
}

/** IDEA's Smart Checkout dialog; the chosen mode, or null for Don't Checkout. */
async function askSmartCheckout(files: readonly string[]): Promise<CheckoutOptions["mode"] | null> {
  const list = files.slice(0, 20).join("\n") + (files.length > 20 ? "\n…" : "");
  const r = await ask({
    title: "Git Checkout Problem",
    body: tx`Your local changes to the following files would be overwritten by checkout:\n${list}\n\nSmart Checkout can stash the changes, checkout and unstash them after that.`,
    icon: "warning",
    width: 520,
    buttons: [
      { id: "smart", label: "Smart Checkout", primary: true },
      { id: "force", label: "Force Checkout" },
      { id: "cancel", label: "Don't Checkout" },
    ],
  });
  return r.button === "smart" || r.button === "force" ? r.button : null;
}

/**
 * Checks out `rev` as IDEA does: local changes in the way open the Smart Checkout
 * dialog, and a remote branch whose local namesake has commits of its own asks whether
 * to rebase that branch onto the remote or drop its commits (one that is only behind is
 * fast-forwarded). Resolves true once switched.
 */
async function performCheckout(
  rev: string,
  success: () => string,
  repo: string | null = currentRepo(),
  quiet = false,
): Promise<boolean> {
  await saveAll();
  let options: CheckoutOptions = { mode: "normal", diverged: null };
  for (;;) {
    const opts = options;
    const outcome = await runOp(tx`Checkout ${rev}`, () => call(commands.vcsCheckout(repo, rev, false, opts)));
    if (!outcome) return false;
    // `success` may name the branch now checked out.
    if (outcome.kind === "done" || outcome.kind === "conflicts") await refreshNow();
    switch (outcome.kind) {
      case "done":
        if (!quiet) notifications().notify({ group: "vcs", level: "info", title: success() });
        return true;
      case "conflicts":
        notifications().notify({
          group: "vcs",
          level: "warning",
          title: `${success()}, with conflicts`,
          body: outcome.files.join("\n"),
          actions: [{ label: "Resolve Conflicts…", run: () => void executeAction("vcs.resolveConflicts") }],
        });
        await openConflictsInstead();
        return true;
      case "untrackedFiles": {
        const files = outcome.files.join("\n");
        notifications().notify({
          group: "vcs",
          level: "error",
          title: "Untracked files prevent checkout",
          body: tx`The following untracked working tree files would be overwritten by checkout:\n${files}\nPlease move or remove them before you switch branches.`,
        });
        return false;
      }
      case "localChanges": {
        const mode = await askSmartCheckout(outcome.files);
        if (!mode) return false;
        options = { ...options, mode };
        continue;
      }
      case "localBranchAhead": {
        const { local, remote } = outcome;
        const r = await ask({
          title: tx`Checkout ${remote}`,
          body: tx`Local branch '${local}' has commits that do not exist in '${remote}'. Rebase '${local}' onto '${remote}', or drop local commits?`,
          buttons: [
            { id: "rebase", label: "Rebase onto Remote", primary: true },
            { id: "reset", label: "Drop Local Commits" },
          ],
        });
        if (r.button !== "rebase" && r.button !== "reset") return false;
        options = { ...options, diverged: r.button };
        continue;
      }
    }
  }
}

/** Checkout of a commit or tag (detached HEAD) with Smart Checkout. */
export async function checkoutDetached(rev: string, label: string) {
  await performCheckout(rev, () => `Checked out ${label} (detached HEAD)`);
}

export async function checkoutBranch(name: string) {
  const state = useVcs.getState();
  const previous = state.branch?.head;
  // A local namesake tracking another branch: IDEA asks for a new local name instead.
  if (state.branches.some((b) => b.remote && b.name === name)) {
    const local = state.branches.find((b) => !b.remote && b.name === shortRemoteName(name));
    if (local?.upstream && local.upstream !== name) return newBranch(name);
  }
  const ok = await performCheckout(name, () => `Checked out ${useVcs.getState().branch?.head ?? name}`);
  if (ok) {
    rememberBranch(previous);
    await refreshNow();
    rememberBranch(useVcs.getState().branch?.head);
  }
}

/** New Branch: creates a branch from HEAD (or `from`) and, by default, checks it out. */
export async function newBranch(from?: string) {
  const repo = currentRepo();
  // IDEA opens the dialog with a suggestion instead of an empty field: a
  // remote's name without the prefix, the source ref as `-copy`, or the
  // current branch for a plain New Branch from HEAD.
  const suggestion = from
    ? from.includes("/")
      ? shortRemoteName(from)
      : `${from}-copy`
    : (useVcs.getState().branch?.head ?? "");
  const r = await promptText({
    title: from ? tx`Create New Branch from ${from}` : "Create New Branch",
    label: "New branch name:",
    // Kept even when that branch exists (the current one always does): the user edits it.
    initial: suggestion,
    mono: true,
    okLabel: "Create",
    sanitize: cleanUpBranchNameOnTyping,
    validate: validateBranchName,
    validateInitial: true,
    checkbox: { label: "Checkout branch", initial: true },
  });
  if (!r) return;
  const checkout = r.checked;
  const previous = useVcs.getState().branch?.head;
  if (checkout) await saveAll();
  const create = () => call(commands.vcsCreateBranch(repo, r.value, from ?? null, checkout));
  const ok = await runOp(tx`Create branch ${r.value}`, create, {
    success: checkout ? `Created and checked out ${r.value}` : `Created branch ${r.value}`,
  });
  if (ok !== undefined && checkout) {
    rememberBranch(previous);
    rememberBranch(r.value);
  }
}

export async function checkoutRevision() {
  const r = await promptText({
    title: "Checkout Tag or Revision",
    label: "Enter a tag, branch or commit hash:",
    mono: true,
    okLabel: "Checkout",
    validate: (v) => (v.trim() ? null : "Enter a revision"),
  });
  if (!r) return;
  await performCheckout(r.value, () => `Checked out ${r.value}`);
}

export function conflictActions(message: string) {
  if (conflictedFiles().length || /conflict/i.test(message))
    return [{ label: "Resolve Conflicts…", run: () => void executeAction("vcs.resolveConflicts") }];
  // Stopped for another reason (the status was refreshed by openConflictsInstead): Abort.
  const op = useVcs.getState().branch?.operation;
  return op === "rebase" || op === "merge"
    ? [{ label: "Abort", run: () => void executeAction(`vcs.${op}.abort`) }]
    : [];
}

/**
 * A merge / rebase that stopped on conflicts isn't an error in IDEA: it opens
 * the Conflicts dialog instead of an error balloon.
 */
export async function openConflictsInstead(): Promise<boolean> {
  await refreshNow();
  if (!conflictedFiles().length) return false;
  void executeAction("vcs.resolveConflicts");
  return true;
}

/** The full ref of a branch, so a tag of the same name isn't taken instead. */
export function branchRef(name: string, remote: boolean): string {
  return remote ? `refs/remotes/${name}` : `refs/heads/${name}`;
}

export async function mergeIntoCurrent(branch: string, repo: string | null = currentRepo(), ref = branch) {
  const current = (repo === currentRepo() ? useVcs.getState().branch?.head : null) ?? "HEAD";
  await saveAll();
  await runOp(tx`Merge ${branch} into ${current}`, () => call(commands.vcsMerge(repo, ref)), {
    success: tx`Merged ${branch} into ${current}`,
    errorActions: conflictActions,
    onError: openConflictsInstead,
  });
}

export async function rebaseOnto(branch: string, ref = branch) {
  const repo = currentRepo();
  const current = useVcs.getState().branch?.head ?? "HEAD";
  await saveAll();
  await runOp(tx`Rebase ${current} onto ${branch}`, () => call(commands.vcsRebase(repo, ref)), {
    success: tx`Rebased ${current} onto ${branch}`,
    errorActions: conflictActions,
    onError: openConflictsInstead,
  });
}

export async function renameBranch(name: string) {
  const repo = currentRepo();
  const r = await promptText({
    title: tx`Rename Branch ${name}`,
    label: "New branch name:",
    initial: name,
    mono: true,
    okLabel: "Rename",
    sanitize: cleanUpBranchNameOnTyping,
    validate: (v) => (v.trim() === name ? "Enter a new name" : validateBranchName(v)),
  });
  if (!r) return;
  const to = r.value.trim();
  const ok = await runOp(tx`Rename branch ${name}`, () => call(commands.vcsRenameBranch(repo, name, to)), {
    success: tx`Renamed branch ${name} to ${to}`,
  });
  if (ok !== undefined) {
    try {
      localStorage.setItem(recentKey(), JSON.stringify(recentBranches().map((b) => (b === name ? to : b))));
    } catch {
      // Recents are best effort.
    }
  }
}

/**
 * Delete Branch as IDEA does it: no confirmation; a branch that is not fully merged is
 * deleted anyway and the notification says so, offering View Commits. Restore recreates
 * the branch (with its upstream); Delete Tracked Branch removes the remote branch too.
 */
export async function deleteBranch(name: string) {
  const repo = currentRepo();
  const deleted = await runOp(tx`Delete branch ${name}`, () => call(commands.vcsDeleteBranch(repo, name)));
  if (!deleted) return;
  const tracked = deleted.upstream;
  const otherTracking = useVcs.getState().branches.some((b) => !b.remote && b.name !== name && b.upstream === tracked);
  const key = `vcs.deleted.${name}`;
  const done = () => notifications().expire?.(key);
  notifications().notify({
    group: "vcs",
    level: "info",
    key,
    title: `Deleted branch ${name}`,
    body: deleted.unmerged ? "Unmerged commits were discarded" : undefined,
    actions: [
      {
        label: "Restore",
        run: () => {
          done();
          void runOp(tx`Restore branch ${name}`, () => call(commands.vcsRestoreBranch(repo, deleted)), {
            success: tx`Restored branch ${name}`,
          });
        },
      },
      ...(deleted.unmerged
        ? [{ label: "View Commits", run: () => showCommitRange(`Commits of ${name}`, "HEAD", deleted.tip) }]
        : []),
      ...(tracked && !otherTracking
        ? [
            {
              label: "Delete Tracked Branch",
              run: () => {
                done();
                void deleteRemoteBranch(tracked);
              },
            },
          ]
        : []),
    ],
  });
}

/** Remotes of the selected repository, as its remote-tracking branches name them. */
export function knownRemotes(): string[] {
  const names = useVcs
    .getState()
    .branches.filter((b) => b.remote)
    .map((b) => b.name.slice(0, b.name.indexOf("/")))
    .filter(Boolean);
  return [...new Set(names)];
}

/** Tag › Delete: deletes the local tag; the notification restores it or deletes it on the remotes too. */
export async function deleteTag(name: string) {
  const repo = currentRepo();
  const deleted = await runOp(tx`Delete tag ${name}`, () => call(commands.vcsDeleteTag(repo, name)));
  if (!deleted) return;
  const remotes = knownRemotes();
  const key = `vcs.deletedTag.${name}`;
  const done = () => notifications().expire?.(key);
  notifications().notify({
    group: "vcs",
    level: "info",
    key,
    title: tx`Deleted tag ${name}`,
    actions: [
      {
        label: "Restore",
        run: () => {
          done();
          void runOp(tx`Restore tag ${name}`, () => call(commands.vcsRestoreTag(repo, deleted)), {
            success: tx`Restored tag ${name}`,
          });
        },
      },
      ...(remotes.length
        ? [
            {
              label: remotes.length === 1 ? "Delete on Remote" : "Delete on Remotes",
              run: () => {
                done();
                void deleteRemoteTag(name, remotes, repo);
              },
            },
          ]
        : []),
    ],
  });
}

async function deleteRemoteTag(tag: string, remotes: readonly string[], repo: string | null) {
  for (const remote of remotes) {
    if (!(await runRemote({ op: "deleteRemoteTag", tag, remote }, `${remote}: ${tag}`, [repo]))) return;
  }
}

/** Push Tag › Push to `remote`. */
export async function pushTag(tag: string, remote: string) {
  await runRemote({ op: "pushTag", tag, remote }, `${tag} → ${remote}`);
}

/** Deletes a branch on its remote (`git push <remote> --delete <name>`); `name` is e.g. `origin/feature`. */
export async function deleteRemoteBranch(name: string) {
  const ok = await confirmDialog({
    title: "Delete Remote Branch",
    message: tx`Delete branch '${shortRemoteName(name)}' on the remote? The remote-tracking branch '${name}' is removed as well.`,
    okLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  await runRemote({ op: "deleteBranch", branch: name }, name);
}

/** Checkout and Rebase onto Current: checks out `name`, then rebases it onto the branch that was current. */
export async function checkoutAndRebase(name: string) {
  const current = useVcs.getState().branch?.head;
  if (!current) return;
  const ok = await performCheckout(name, () => `Checked out ${name}`);
  if (!ok) return;
  rememberBranch(current);
  rememberBranch(name);
  await refreshNow();
  await rebaseOnto(current, branchRef(current, false));
}

/** Update for a branch other than the current one: fast-forwards it to its upstream. */
export async function updateBranch(name: string) {
  const b = useVcs.getState().branches.find((x) => !x.remote && x.name === name);
  if (b?.current) return void executeAction("vcs.update");
  if (!b?.upstream) {
    notifications().notify({ group: "vcs", level: "warning", title: `Branch '${name}' has no tracked branch` });
    return;
  }
  await runRemote({ op: "updateBranch", branch: name }, `${name} ← ${b.upstream}`);
}

// --- several repositories ----------------------------------------------------

/** "in 3 repositories", or "in 2 of 3 repositories" when some were left out. */
function inRepos(done: number, total: number): string {
  return done === total ? `in ${total} repositories` : `in ${done} of ${total} repositories`;
}

interface Rollback<T> {
  /** What rolling back does, for the question: "check out the previous branch again". */
  undo: string;
  run: (root: string, result: T, before: BranchInfo) => Promise<unknown>;
}

const branchInfo = (root: string) => call(commands.vcsBranchInfo(root)).catch(() => null);

/**
 * Runs `step` in each repository in turn, stopping at the first one that fails (its
 * error is reported by `step`), then reports how many repositories it was done in.
 * When it failed after succeeding in some repositories, offers to roll those back so
 * the repositories don't diverge (not when the failed one stopped on conflicts).
 */
async function eachRepo<T>(
  roots: readonly string[],
  step: (root: string) => Promise<T | undefined>,
  title: string,
  rollback?: Rollback<T>,
) {
  const done: { root: string; result: T; before: BranchInfo }[] = [];
  let failed: string | null = null;
  for (const root of roots) {
    const before = await branchInfo(root);
    const result = await step(root);
    if (result === undefined || !before) {
      failed = root;
      break;
    }
    done.push({ root, result, before });
  }
  await refreshNow();
  if (failed && done.length && rollback && !(await branchInfo(failed))?.operation) {
    const succeeded = done.map((d) => repoName(d.root)).join(", ");
    const failedName = repoName(failed);
    const r = await ask({
      title: "Rollback",
      body: tx`The operation failed in ${failedName}, but succeeded in ${succeeded}. Roll those back (${rollback.undo}) so the repositories don't diverge?`,
      icon: "warning",
      buttons: [
        { id: "rollback", label: "Rollback", primary: true },
        { id: "keep", label: "Don't Rollback" },
      ],
    });
    if (r.button === "rollback") {
      for (const d of done.reverse()) {
        const repo = repoName(d.root);
        await runOp(tx`Rollback (${repo})`, () => rollback.run(d.root, d.result, d.before), { refresh: false });
      }
      await refreshNow();
      return;
    }
  }
  if (done.length)
    notifications().notify({ group: "vcs", level: "info", title: `${title} ${inRepos(done.length, roots.length)}` });
}

/** HEAD as a checkout target: the branch, or the commit on a detached HEAD. */
const headRef = (b: BranchInfo) => b.head ?? b.headCommit ?? "HEAD";

async function checkoutBack(root: string, before: BranchInfo) {
  await call(commands.vcsCheckout(root, headRef(before), false, { mode: "smart", diverged: null }));
}

/** Moves HEAD back to where it was before a merge or rebase, keeping local changes. */
async function resetBack(root: string, before: BranchInfo) {
  const after = (await branchInfo(root))?.headCommit;
  if (before.headCommit && after) await call(commands.vcsRestoreHead(root, before.headCommit, after));
}

/** Checks out `name` (local, or remote: its local namesake) in every repository of `roots`. */
export async function checkoutInRepos(name: string, roots: readonly string[]) {
  const label = useVcs.getState().branches.some((b) => b.remote && b.name === name) ? shortRemoteName(name) : name;
  const previous = useVcs.getState().branch?.head;
  await eachRepo(
    roots,
    async (root) => ((await performCheckout(name, () => "", root, true)) ? true : undefined),
    `Checked out ${label}`,
    { undo: tx("check out the previous branch again"), run: (root, _, before) => checkoutBack(root, before) },
  );
  rememberBranch(previous);
  rememberBranch(useVcs.getState().branch?.head);
}

/** New Branch in every repository of `roots` (from HEAD or `from`), checked out by default. */
export async function newBranchInRepos(roots: readonly string[], from?: string) {
  const r = await promptText({
    title: from ? tx`Create New Branch from ${from}` : "Create New Branch",
    label: tx`New branch name (in ${roots.length} repositories):`,
    initial: from ? (from.includes("/") ? shortRemoteName(from) : "") : (useVcs.getState().branch?.head ?? ""),
    mono: true,
    okLabel: "Create",
    sanitize: cleanUpBranchNameOnTyping,
    validate: validateBranchName,
    validateInitial: true,
    checkbox: { label: "Checkout branch", initial: true },
  });
  if (!r) return;
  const name = r.value.trim();
  if (r.checked) await saveAll();
  await eachRepo(
    roots,
    (root) =>
      runOp(tx`Create branch ${name}`, () => call(commands.vcsCreateBranch(root, name, from ?? null, r.checked)), {
        refresh: false,
      }).then((done) => (done === undefined ? undefined : true)),
    r.checked ? `Created and checked out ${name}` : `Created branch ${name}`,
    {
      undo: tx`delete branch ${name}`,
      run: async (root, _, before) => {
        if (r.checked) await checkoutBack(root, before);
        await call(commands.vcsDeleteBranch(root, name));
      },
    },
  );
}

/** Merges `branch` into the current branch of every repository of `roots`; stops on conflicts. */
export async function mergeInRepos(branch: string, roots: readonly string[]) {
  await saveAll();
  await eachRepo(
    roots,
    (root) =>
      runOp(tx`Merge ${branch} (${repoName(root)})`, () => call(commands.vcsMerge(root, branch)), {
        refresh: false,
        errorActions: conflictActions,
        onError: openConflictsInstead,
      }).then((done) => (done === undefined ? undefined : true)),
    `Merged ${branch}`,
    { undo: tx("reset to the commit before the merge"), run: (root, _, before) => resetBack(root, before) },
  );
}

/** Rebases the current branch of every repository of `roots` onto `branch`; stops on conflicts. */
export async function rebaseInRepos(branch: string, roots: readonly string[]) {
  await saveAll();
  await eachRepo(
    roots,
    (root) =>
      runOp(tx`Rebase onto ${branch} (${repoName(root)})`, () => call(commands.vcsRebase(root, branch)), {
        refresh: false,
        errorActions: conflictActions,
        onError: openConflictsInstead,
      }).then((done) => (done === undefined ? undefined : true)),
    `Rebased onto ${branch}`,
    { undo: tx("reset to the commit before the rebase"), run: (root, _, before) => resetBack(root, before) },
  );
}

/** Deletes local branch `name` in every repository of `roots`. */
export async function deleteInRepos(name: string, roots: readonly string[]) {
  const ok = await confirmDialog({
    title: "Delete Branch",
    message: tx`Delete branch '${name}' in ${roots.length} repositories? Unmerged commits are discarded.`,
    okLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  await eachRepo(
    roots,
    (root) =>
      runOp(tx`Delete branch ${name} (${repoName(root)})`, () => call(commands.vcsDeleteBranch(root, name)), {
        refresh: false,
      }),
    `Deleted branch ${name}`,
    { undo: tx`restore branch ${name}`, run: (root, deleted) => call(commands.vcsRestoreBranch(root, deleted)) },
  );
}

// --- favorites ---------------------------------------------------------------

const favoritesKey = () => `openidea.vcs.favoriteBranches:${useVcs.getState().root ?? ""}`;

/** The user's favorite branches for the open repository; `null` = defaults (main / master). */
export const useFavoriteBranches = create<{ key: string; names: string[] | null }>(() => ({ key: "", names: null }));

export function loadFavoriteBranches() {
  const key = favoritesKey();
  if (useFavoriteBranches.getState().key === key) return;
  let names: string[] | null = null;
  try {
    const raw = localStorage.getItem(key);
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(v)) names = v.filter((x): x is string => typeof x === "string");
  } catch {
    // Storage unavailable: defaults.
  }
  useFavoriteBranches.setState({ key, names });
}

export function toggleFavoriteBranch(b: Branch) {
  loadFavoriteBranches();
  const stored = useFavoriteBranches.getState().names;
  // First edit: start from the defaults that are currently shown.
  const base =
    stored ??
    useVcs
      .getState()
      .branches.filter((x) => isFavoriteBranch(x, null))
      .map((x) => x.name);
  const names = base.includes(b.name) ? base.filter((n) => n !== b.name) : [...base, b.name];
  useFavoriteBranches.setState({ names });
  try {
    localStorage.setItem(favoritesKey(), JSON.stringify(names));
  } catch {
    // Favorites last for the session only.
  }
}
