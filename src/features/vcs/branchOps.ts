/** Branch operations (checkout, create, merge, rebase, update, delete) with recents and favorites. */
import { create } from "zustand";
import type { Branch, CheckoutOptions } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { call, commands } from "@/platform/ipc";
import { notifications } from "@/workbench/contributions";
import { ask } from "@/workbench/messages";
import { isFavoriteBranch, pushRecent, shortRemoteName } from "./branches";
import { showCommitRange } from "./CompareBranches";
import { confirmDialog, promptText } from "./dialogs";
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
    const outcome = await runOp(`Checkout ${rev}`, () => call(commands.vcsCheckout(repo, rev, false, opts)));
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
  const suggestion = from ? (from.includes("/") ? shortRemoteName(from) : `${from}-copy`) : "";
  const r = await promptText({
    title: from ? tx`Create New Branch from ${from}` : "Create New Branch",
    label: "New branch name:",
    initial: from && from.includes("/") && !validateBranchName(suggestion) ? suggestion : "",
    mono: true,
    okLabel: "Create",
    validate: validateBranchName,
    checkbox: { label: "Checkout branch", initial: true },
  });
  if (!r) return;
  const checkout = r.checked;
  const previous = useVcs.getState().branch?.head;
  if (checkout) await saveAll();
  const create = () => call(commands.vcsCreateBranch(repo, r.value, from ?? null, checkout));
  const ok = await runOp(`Create branch ${r.value}`, create, {
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
  return conflictedFiles().length || /conflict/i.test(message)
    ? [{ label: "Resolve Conflicts…", run: () => void executeAction("vcs.resolveConflicts") }]
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

export async function mergeIntoCurrent(branch: string) {
  const repo = currentRepo();
  const current = useVcs.getState().branch?.head ?? "HEAD";
  await saveAll();
  await runOp(`Merge ${branch} into ${current}`, () => call(commands.vcsMerge(repo, branch)), {
    success: `Merged ${branch} into ${current}`,
    errorActions: conflictActions,
    onError: openConflictsInstead,
  });
}

export async function rebaseOnto(branch: string) {
  const repo = currentRepo();
  const current = useVcs.getState().branch?.head ?? "HEAD";
  await saveAll();
  await runOp(`Rebase ${current} onto ${branch}`, () => call(commands.vcsRebase(repo, branch)), {
    success: `Rebased ${current} onto ${branch}`,
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
    validate: (v) => (v.trim() === name ? "Enter a new name" : validateBranchName(v)),
  });
  if (!r) return;
  const to = r.value.trim();
  const ok = await runOp(`Rename branch ${name}`, () => call(commands.vcsRenameBranch(repo, name, to)), {
    success: `Renamed branch ${name} to ${to}`,
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
  const deleted = await runOp(`Delete branch ${name}`, () => call(commands.vcsDeleteBranch(repo, name)));
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
          void runOp(`Restore branch ${name}`, () => call(commands.vcsRestoreBranch(repo, deleted)), {
            success: `Restored branch ${name}`,
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
  await rebaseOnto(current);
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

/**
 * Runs `step` in each repository in turn, stopping at the first one that fails (its
 * error is reported by `step`), then reports how many repositories it was done in.
 */
async function eachRepo(roots: readonly string[], step: (root: string) => Promise<boolean>, title: string) {
  let done = 0;
  for (const root of roots) {
    if (!(await step(root))) break;
    done++;
  }
  await refreshNow();
  if (done) notifications().notify({ group: "vcs", level: "info", title: `${title} ${inRepos(done, roots.length)}` });
}

/** Checks out `name` (local, or remote: its local namesake) in every repository of `roots`. */
export async function checkoutInRepos(name: string, roots: readonly string[]) {
  const label = useVcs.getState().branches.some((b) => b.remote && b.name === name) ? shortRemoteName(name) : name;
  const previous = useVcs.getState().branch?.head;
  await eachRepo(roots, (root) => performCheckout(name, () => "", root, true), `Checked out ${label}`);
  rememberBranch(previous);
  rememberBranch(useVcs.getState().branch?.head);
}

/** New Branch in every repository of `roots` (from HEAD or `from`), checked out by default. */
export async function newBranchInRepos(roots: readonly string[], from?: string) {
  const r = await promptText({
    title: from ? tx`Create New Branch from ${from}` : "Create New Branch",
    label: tx`New branch name (in ${roots.length} repositories):`,
    initial: from?.includes("/") ? shortRemoteName(from) : "",
    mono: true,
    okLabel: "Create",
    validate: validateBranchName,
    checkbox: { label: "Checkout branch", initial: true },
  });
  if (!r) return;
  const name = r.value.trim();
  if (r.checked) await saveAll();
  await eachRepo(
    roots,
    async (root) =>
      (await runOp(`Create branch ${name}`, () => call(commands.vcsCreateBranch(root, name, from ?? null, r.checked)), {
        refresh: false,
      })) !== undefined,
    r.checked ? `Created and checked out ${name}` : `Created branch ${name}`,
  );
}

/** Merges `branch` into the current branch of every repository of `roots`; stops on conflicts. */
export async function mergeInRepos(branch: string, roots: readonly string[]) {
  await saveAll();
  await eachRepo(
    roots,
    async (root) =>
      (await runOp(`Merge ${branch} (${repoName(root)})`, () => call(commands.vcsMerge(root, branch)), {
        refresh: false,
        errorActions: conflictActions,
        onError: openConflictsInstead,
      })) !== undefined,
    `Merged ${branch}`,
  );
}

/** Rebases the current branch of every repository of `roots` onto `branch`; stops on conflicts. */
export async function rebaseInRepos(branch: string, roots: readonly string[]) {
  await saveAll();
  await eachRepo(
    roots,
    async (root) =>
      (await runOp(`Rebase onto ${branch} (${repoName(root)})`, () => call(commands.vcsRebase(root, branch)), {
        refresh: false,
        errorActions: conflictActions,
        onError: openConflictsInstead,
      })) !== undefined,
    `Rebased onto ${branch}`,
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
    async (root) =>
      (await runOp(`Delete branch ${name} (${repoName(root)})`, () => call(commands.vcsDeleteBranch(root, name)), {
        refresh: false,
      })) !== undefined,
    `Deleted branch ${name}`,
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
