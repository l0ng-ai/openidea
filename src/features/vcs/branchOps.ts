/** Branch operations (checkout, create, merge, rebase, update, delete) with recents and favorites. */
import { createElement, Fragment } from "react";
import { create } from "zustand";
import type {
  Branch,
  BranchInfo,
  BranchUpdateStatus,
  CheckoutOutcome,
  CheckoutOptions,
  CheckoutRebasePlan,
  DeletedBranch,
  ProjectInfo,
  RemoteOp,
  Worktree,
} from "@/bindings";
import { executeAction } from "@/platform/actions";
import { call, commands } from "@/platform/ipc";
import { notifications } from "@/workbench/contributions";
import { openWorktree } from "./openWorktree";
import { activeRepository } from "./activeRepository";
import { ask, confirmChecked } from "@/workbench/messages";
import { branchNamePrefixes, isFavoriteBranch, isProtectedBranch, pushRecent, shortRemoteName } from "./branches";
import { showCommitRanges } from "./CompareBranches";
import type { AffectedFiles } from "./LocalChangesReviewDialog";
import { confirmDialog, promptText } from "./dialogs";
import { cleanUpBranchNameOnTyping } from "@/platform/gitRefName";
import {
  errorMessage,
  runBranchUpdates,
  runGitOperation,
  runOp,
  runRemote,
  runRemoteRound,
  saveAll,
  startShelfBatch,
  type RepoBranchUpdate,
  type RemoteTarget,
} from "./ops";
import { beginGitWork, conflictedFiles, currentRepo, currentRepoRoot, refreshNow, repoName, useVcs } from "./store";
import { tx, txTemplate } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { workflowSettings } from "@/platform/workflowSettings";
import { trackMergeCompletion } from "./mergeCompletion";
import { branchRebaseRoots, runBranchRebases, type PlannedRebase } from "./branchRebase";
import { splitTracked } from "./pushTarget";
import { chooseRevision } from "./RevisionChooser";
import { branchRepositoryRoots } from "./repoBranches";

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
export function validateBranchName(
  name: string,
  overwrite = false,
  branches: readonly Branch[] = useVcs.getState().branches,
): string | null {
  const n = name.trim();
  if (!n) return "Branch name must not be empty";
  if (n.toLowerCase() === "head") return "HEAD is a reserved keyword";
  if (/[\s~^:?*[\\\p{Cc}]/u.test(n)) return "Branch name contains invalid characters";
  if (n.startsWith("-") || n.startsWith("/") || n.endsWith("/") || n.endsWith(".") || n.endsWith(".lock"))
    return "Invalid branch name";
  if (n.includes("..") || n.includes("//") || n.includes("@{") || n === "@") return "Invalid branch name";
  if (n.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))) return "Invalid branch name";
  if (branches.some((b) => b.remote && b.name === n)) return tx`Branch name '${n}' conflicts with a remote branch`;
  if (!overwrite && branches.some((b) => !b.remote && b.name === n)) return tx`Branch '${n}' already exists`;
  const collision = branches.find((b) => !b.remote && (b.name.startsWith(n + "/") || n.startsWith(b.name + "/")));
  if (collision) return tx`Branch name '${n}' conflicts with '${collision.name}'`;
  return null;
}

type CheckoutChoice = CheckoutOptions["mode"];

function localChangesChoices(operation: "checkout" | "merge", rev: string, roots: readonly (string | null)[]) {
  const decisions = new Map<string | null, { files: ReadonlySet<string>; mode: CheckoutChoice }>();
  return async (root: string | null, files: readonly string[], usePrevious: boolean) => {
    const prior = decisions.get(root);
    if (usePrevious && prior && files.every((file) => prior.files.has(file))) return prior.mode;

    const remaining = roots
      .slice(roots.indexOf(root) + 1)
      .filter((repo): repo is string => repo !== null && !decisions.has(repo));
    const preview = operation === "checkout" ? commands.vcsCheckoutAffectedFiles : commands.vcsMergeAffectedFiles;
    const others = remaining.length ? await call(preview(remaining, rev)).catch(() => []) : [];
    const affected: AffectedFiles[] = [[root, files], ...others];
    const { reviewLocalChanges } = await import("./LocalChangesReviewDialog");
    const decision = await reviewLocalChanges(operation, affected, roots.length > 1);
    if (!decision) return null;
    await saveAll();
    for (const [repo] of affected) decisions.delete(repo);
    if (decision.mode !== "normal") {
      for (const [repo, paths] of decision.files) decisions.set(repo, { files: new Set(paths), mode: decision.mode });
    }
    // The worktree may have changed during review. Ask Git again before using the chosen mode.
    return "normal";
  };
}

interface LocalChangesBatch {
  id: string | null;
  choose: ReturnType<typeof localChangesChoices>;
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
  batch?: LocalChangesBatch,
): Promise<boolean> {
  const project = useProject.getState().project;
  const root = repo ?? currentRepoRoot();
  await saveAll();
  const choose = batch?.choose ?? localChangesChoices("checkout", rev, [root]);
  const result = await reviewCheckout(
    tx`Checkout ${rev.replace(/^refs\/(?:heads|remotes|tags)\//, "").replace(/\^\{commit\}$/, "")}`,
    success,
    root,
    choose,
    async (opts) =>
      useProject.getState().project === project
        ? { checkout: await call(commands.vcsCheckout(repo, rev, false, opts, batch?.id ?? null)), result: true }
        : undefined,
    !batch,
  );
  return result === true;
}

async function reviewCheckout<T>(
  title: string,
  success: () => string,
  root: string | null,
  choose: LocalChangesBatch["choose"],
  attempt: (options: CheckoutOptions) => Promise<{ checkout: CheckoutOutcome; result: T } | undefined>,
  reportSuccess: boolean,
): Promise<T | undefined> {
  let options: CheckoutOptions = { mode: "normal", diverged: null };
  for (;;) {
    const opts = options;
    const response = await runOp(title, () => attempt(opts), { refresh: false });
    if (!response) {
      void refreshNow();
      return undefined;
    }
    const { checkout: outcome, result } = response;
    // `success` may name the branch now checked out.
    if (outcome.kind === "done" || outcome.kind === "conflicts" || outcome.kind === "restoreFailed") await refreshNow();
    switch (outcome.kind) {
      case "done":
        if (reportSuccess) notifications().notify({ group: "vcs", level: "info", title: success() });
        return result;
      case "restoreFailed": {
        const shelved = workflowSettings().vcs.git.saveChangesPolicy === "shelve";
        notifications().notify({
          group: "vcs",
          level: "warning",
          title: tx("Could not restore local changes after checkout"),
          body: outcome.message,
          actions: [
            shelved
              ? { label: "Show Shelf", run: () => void executeAction("vcs.showShelf") }
              : { label: "Show Stashes", run: () => void executeAction("vcs.showStashes") },
          ],
        });
        return result;
      }
      case "conflicts": {
        const shelved = opts.mode === "smart" && workflowSettings().vcs.git.saveChangesPolicy === "shelve";
        notifications().notify({
          group: "vcs",
          level: "warning",
          title: `${success()}, with conflicts`,
          body: outcome.files.join("\n"),
          actions: [
            { label: "Resolve Conflicts…", run: () => void executeAction("vcs.resolveConflicts") },
            ...(shelved ? [{ label: "Show Shelf", run: () => void executeAction("vcs.showShelf") }] : []),
          ],
        });
        await openConflictsInstead();
        return result;
      }
      case "untrackedFiles": {
        const files = outcome.files.join("\n");
        // git refuses untracked files in two ways: they would be overwritten by the
        // checkout (present in the target), or removed by it (tracked here, absent
        // from the target); each names its files the way git's own message does.
        const body = outcome.removed
          ? tx`The following untracked working tree files would be removed by checkout:\n${files}\nPlease move or remove them before you switch branches.`
          : tx`The following untracked working tree files would be overwritten by checkout:\n${files}\nPlease move or remove them before you switch branches.`;
        notifications().notify({
          group: "vcs",
          level: "error",
          title: "Untracked files prevent checkout",
          body,
        });
        return undefined;
      }
      case "localChanges": {
        const mode = await choose(root, outcome.files, opts.mode === "normal");
        if (!mode) return undefined;
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
        if (r.button !== "rebase" && r.button !== "reset") return undefined;
        options = { ...options, diverged: r.button };
        continue;
      }
      case "checkedOutInWorktree": {
        const { branch, path } = outcome;
        const r = await ask({
          title: "Worktree Conflict",
          body: tx`Branch '${branch}' is already checked out in a worktree at:\n${path}`,
          buttons: [
            { id: "anyway", label: "Checkout Anyway", primary: true },
            { id: "open", label: "Open Existing Worktree" },
            { id: "cancel", label: "Cancel" },
          ],
        });
        if (r.button === "anyway") {
          options = { ...options, ignoreOtherWorktrees: true };
          continue;
        }
        if (r.button === "open") await openWorktree(path);
        return undefined;
      }
    }
  }
}

/** Checkout of a commit or tag (detached HEAD) with Smart Checkout. */
export async function checkoutDetached(rev: string, label: string, repo = currentRepo()) {
  await performCheckout(`${rev}^{commit}`, () => `Checked out ${label} (detached HEAD)`, repo);
}

type NamedBranch = Pick<Branch, "name" | "remote">;

export async function checkoutBranch(branch: NamedBranch, repo = currentRepo()) {
  const { name, remote } = branch;
  const state = useVcs.getState();
  const project = useProject.getState().project;
  const root = repo ?? state.roots[0] ?? state.root;
  const head = () => {
    const s = useVcs.getState();
    return root && root !== currentRepoRoot() ? s.heads[root]?.head : s.branch?.head;
  };
  const previous = head();
  // A local namesake tracking another branch: IDEA asks for a new local name instead.
  if (remote) {
    const check = await remoteCheckoutTargets(name, [repo]);
    if (!check || useProject.getState().project !== project) return;
    if (check.conflict) return newBranch(branch, repo);
  }
  const ok = await performCheckout(branchRef(name, remote), () => `Checked out ${head() ?? name}`, repo);
  if (ok && useProject.getState().project === project) {
    rememberBranch(previous);
    await refreshNow();
    rememberBranch(head());
  }
}

async function remoteCheckoutTargets(name: string, roots: readonly (string | null)[]) {
  const s = useVcs.getState();
  const targets = await runOp(
    tx("Load branches"),
    () =>
      Promise.all(
        roots.map(async (repo) => {
          const [remotes, branches] = await Promise.all([
            configuredRemoteNames(repo),
            repo === s.repo && s.branchesLoaded ? s.branches : call(commands.vcsBranches(repo)),
          ]);
          const localName = splitTracked(name, remotes).branch;
          const local = branches.find((branch) => !branch.remote && branch.name === localName);
          return { localName, conflict: !!local?.upstream && local.upstream !== name };
        }),
      ),
    { refresh: false },
  );
  if (!targets) return undefined;
  const label = targets[0]?.localName ?? name;
  return {
    label: targets.every((target) => target.localName === label) ? label : name,
    conflict: targets.some((target) => target.conflict),
  };
}

type BranchSource = string | NamedBranch | { tag: string };

/** New Branch from the current HEAD or a selected revision. */
export async function newBranch(from?: BranchSource, repo = currentRepo()) {
  const roots = useVcs.getState().roots;
  if (!from && roots.length > 1) return createBranch(roots, from, repo ?? roots[0]);
  return createBranch([repo], from);
}

const ALL_BRANCH_REPOS = "*";

async function createBranch(roots: readonly (string | null)[], from?: BranchSource, initialRepo?: string) {
  if (!roots.length) return;
  const project = useProject.getState().project;
  const state = useVcs.getState();
  const sourceName = typeof from === "object" ? ("tag" in from ? from.tag : from.name) : from;
  const start =
    typeof from === "object"
      ? "tag" in from
        ? `refs/tags/${from.tag}`
        : branchRef(from.name, from.remote)
      : (from ?? null);
  const head = (repo: string | null) =>
    repo === state.repo || repo === null ? state.branch?.head : state.heads[repo]?.head;
  const scopes = await runOp(
    tx("Load branches"),
    () =>
      Promise.all(
        roots.map(async (repo) => ({
          repo,
          branches:
            repo === state.repo && state.branchesLoaded ? state.branches : await call(commands.vcsBranches(repo)),
        })),
      ),
    { refresh: false },
  );
  if (!scopes || useProject.getState().project !== project) return;
  const multipleRoots = roots.length > 1;
  const seedRepo = initialRepo ?? (roots.includes(state.repo) ? state.repo : roots[0]!);
  const knownHead = head(seedRepo);
  const currentBranch =
    knownHead === undefined
      ? scopes.find(({ repo }) => repo === seedRepo)?.branches.find((branch) => branch.current)?.name
      : knownHead;
  const suggestion =
    typeof from === "object" && "remote" in from
      ? from.remote
        ? splitTracked(from.name, await configuredRemoteNames(seedRepo)).branch
        : from.name
      : sourceName
        ? `${sourceName}-copy`
        : (currentBranch ?? "");
  if (useProject.getState().project !== project) return;
  const inScope = (scope?: string) =>
    scopes.filter(({ repo }) => !scope || scope === ALL_BRANCH_REPOS || repo === scope);
  const allPrefixes = branchNamePrefixes(scopes.flatMap(({ branches }) => branches));
  const repoPrefixes = new Map(scopes.map(({ repo, branches }) => [repo, branchNamePrefixes(branches)]));
  const r = await promptText({
    title: sourceName ? tx`Create New Branch from ${sourceName}` : "Create New Branch",
    label: "New branch name:",
    labelPlacement: "inline",
    // Kept even when that branch exists (the current one always does): the user edits it.
    initial: suggestion,
    prefixes: (scope) => (scope && scope !== ALL_BRANCH_REPOS ? (repoPrefixes.get(scope) ?? []) : allPrefixes),
    scope: multipleRoots
      ? {
          label: "Repository:",
          initial: initialRepo ?? ALL_BRANCH_REPOS,
          options: [
            { value: ALL_BRANCH_REPOS, label: "All repositories" },
            ...roots.flatMap((repo) => (repo ? [{ value: repo, label: repoName(repo), verbatim: true }] : [])),
          ],
        }
      : undefined,
    okLabel: "Create",
    sanitize: cleanUpBranchNameOnTyping,
    validate: (name, overwrite, scope) => {
      const invalid = validateBranchName(name, false, []);
      if (invalid) return invalid;
      const selected = inScope(scope);
      for (const { repo, branches } of selected) {
        const conflict = validateBranchName(name, overwrite, branches);
        if (conflict) return repo && selected.length > 1 ? `${tx(conflict)} (${repoName(repo)})` : conflict;
      }
      return null;
    },
    overwriteBranch: (name, scope) =>
      inScope(scope).some(({ branches }) => branches.some((branch) => !branch.remote && branch.name === name.trim())),
    validateInitial: true,
    checkbox: { label: "Checkout branch", initial: true },
  });
  if (!r || useProject.getState().project !== project) return;
  const targets = inScope(r.scope);
  const expectedTips = new Map<string | null, string>();
  if (r.overwrite) {
    const dropping = await runOp(
      tx("Check branches for local commits"),
      async () => {
        const affected = [];
        for (const { repo, branches } of targets) {
          const existing = branches.find((branch) => !branch.remote && branch.name === r.value);
          if (!existing) continue;
          const tip = existing.commit;
          if (!tip) throw new Error(tx`Could not find the tip of branch '${r.value}'`);
          expectedTips.set(repo, tip);
          const base = await call(commands.vcsMergeBase(repo, tip, start ?? "HEAD"));
          if (base !== tip) affected.push(repo);
        }
        return affected;
      },
      { refresh: false },
    );
    if (!dropping || useProject.getState().project !== project) return;
    if (dropping.length) {
      const name = r.value;
      const repositories = dropping
        .map((repo) => (repo ? repoName(repo) : ""))
        .filter(Boolean)
        .join(", ");
      const confirmed = await confirmDialog({
        title: tx`Overwrite Branch ${name}`,
        message: multipleRoots
          ? tx`Overwriting '${name}' will drop local commits in ${repositories}.`
          : tx`Overwriting '${name}' will drop local commits.`,
        okLabel: "Drop Local Commits",
        danger: true,
      });
      if (!confirmed || useProject.getState().project !== project) return;
    }
  }
  const checkout = r.checked;
  if (checkout) await saveAll();
  if (useProject.getState().project !== project) return;
  const selected = targets.map(({ repo }) => repo);
  const title = tx`Create branch ${r.value}`;
  const success = checkout ? tx`Created and checked out ${r.value}` : tx`Created branch ${r.value}`;
  const primary = state.roots[0] ?? state.root;
  const choose = localChangesChoices(
    "checkout",
    start ?? "HEAD",
    selected.map((repo) => repo ?? primary),
  );
  const create = async (repo: string | null, batch: string | null) => {
    const expected = expectedTips.get(repo);
    const attempt = (options: CheckoutOptions | null) => {
      if (useProject.getState().project !== project) return undefined;
      return call(
        commands.vcsCreateBranch(repo, r.value, start, checkout, !!expected, expected ?? null, options, batch),
      );
    };
    if (!checkout) {
      return (
        (
          await runOp(title, async () => attempt(null), {
            refresh: selected.length === 1,
            success: selected.length === 1 ? success : undefined,
          })
        )?.created ?? undefined
      );
    }
    const result = await reviewCheckout(
      title,
      () => success,
      repo ?? primary,
      choose,
      async (opts) => {
        const outcome = await attempt(opts);
        return outcome && { checkout: outcome.checkout, result: outcome.created };
      },
      selected.length === 1,
    );
    return result ?? undefined;
  };
  const done =
    selected.length === 1
      ? (await create(selected[0]!, null)) !== undefined
      : (await eachRepo(
          selected.filter((repo): repo is string => repo !== null),
          create,
          success,
          {
            undo: tx`undo creation of branch ${r.value}`,
            run: async (repo, created, before) => {
              if (useProject.getState().project !== project) throw new Error(tx("The open project has changed"));
              if (checkout && !before.headCommit) throw new Error(tx("The previous branch has no commits"));
              const previous =
                checkout && before.headCommit ? { branch: before.head, commit: before.headCommit } : null;
              await call(commands.vcsUndoBranchCreation(repo, r.value, created, previous));
            },
          },
          checkout,
        )) > 0;
  if (!done || !checkout || useProject.getState().project !== project) return;
  const focused = currentRepoRoot();
  if (selected.includes(focused) || selected.includes(null)) {
    rememberBranch(head(focused));
    rememberBranch(r.value);
  }
}

export interface CheckoutRevisionScope {
  repo?: string | null;
  repos?: readonly string[];
}

function checkoutRevisionRoots(scope?: CheckoutRevisionScope): readonly (string | null)[] {
  if (scope?.repo) return [scope.repo];
  if (scope?.repos?.length) return [...new Set(scope.repos)];
  const { roots, branchRoots } = useVcs.getState();
  const current = activeRepository();
  return workflowSettings().vcs.git.syncBranchOperations && roots.length
    ? branchRepositoryRoots(roots, branchRoots, current)
    : [current];
}

export function canCheckoutRevision(scope?: CheckoutRevisionScope): boolean {
  const { heads, branch } = useVcs.getState();
  return checkoutRevisionRoots(scope).every((root) => (root ? heads[root] : branch)?.headCommit !== null);
}

export async function checkoutRevision(scope?: CheckoutRevisionScope) {
  const project = useProject.getState().project;
  const roots = checkoutRevisionRoots(scope);
  const repositories = roots.filter((root): root is string => root !== null);
  const revision = await chooseRevision("Checkout Tag or Revision", {
    tags: true,
    commonOnly: true,
    repositories: repositories.length ? repositories : undefined,
  });
  if (!revision || useProject.getState().project !== project) return;
  const label = revision.replace(/^refs\/(?:heads|remotes|tags)\//, "");
  const available = await runOp(
    tx`Check revision ${label}`,
    () => Promise.all(roots.map((root) => call(commands.vcsHasCommit(root, revision)))),
    { refresh: false },
  );
  if (!available || useProject.getState().project !== project) return;
  const missing = roots.filter((_, i) => !available[i]);
  if (missing.length) {
    const names = missing
      .map((root) => repoName(root ?? ""))
      .filter(Boolean)
      .join(", ");
    notifications().notify({
      group: "vcs",
      level: "error",
      title: tx`Could not check out ${label}`,
      body: names ? tx`Revision was not found in ${names}` : tx("Revision was not found"),
    });
    return;
  }
  const target = `${revision}^{commit}`;
  const success = tx`Checked out ${label} (detached HEAD)`;
  if (roots.length === 1) {
    await performCheckout(target, () => success, roots[0]);
    return;
  }
  const choose = localChangesChoices("checkout", target, repositories);
  await eachRepo(
    repositories,
    async (root, id) =>
      useProject.getState().project === project && (await performCheckout(target, () => success, root, { id, choose }))
        ? true
        : undefined,
    success,
    { undo: tx("check out the previous branch again"), run: (root, _, before) => checkoutBack(root, before) },
    true,
  );
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

export async function openMergeConflicts(root: string | null, project: ProjectInfo | null, onComplete: () => void) {
  await refreshNow();
  const session = root && project ? await trackMergeCompletion([root], project, onComplete) : null;
  if (conflictedFiles().length) void executeAction("vcs.resolveConflicts", session ? { mergeRepo: root } : undefined);
}

/** The full ref of a branch, so a tag of the same name isn't taken instead. */
export function branchRef(name: string, remote: boolean): string {
  return remote ? `refs/remotes/${name}` : `refs/heads/${name}`;
}

async function performMerge(ref: string, title: string, repo: string | null, batch?: LocalChangesBatch) {
  const root = repo ?? currentRepoRoot();
  const choose = batch?.choose ?? localChangesChoices("merge", ref, [root]);
  let smart = false;
  for (;;) {
    const outcome = await runOp(title, () => call(commands.vcsMerge(repo, ref, batch?.id ?? null, smart)), {
      refresh: false,
      errorActions: conflictActions,
      onError: batch ? undefined : openConflictsInstead,
    });
    if (!outcome || outcome.kind !== "localChanges") return outcome?.kind;
    const mode = await choose(root, outcome.files, !smart);
    if (!mode) return undefined;
    smart = mode === "smart";
  }
}

interface MergedBranchCleanup {
  project: ProjectInfo;
  targets: { root: string; tip: string }[];
}

async function captureMergedBranch(
  name: string,
  ref: string,
  roots: readonly string[],
): Promise<MergedBranchCleanup | null> {
  const project = useProject.getState().project;
  if (!project || !roots.length || ref !== branchRef(name, false) || isProtectedBranch(name)) return null;
  const candidates = await Promise.all(
    roots.map(async (root) => {
      const branches = await call(commands.vcsBranches(root)).catch(() => []);
      const branch = branches.find((b) => !b.remote && !b.current && b.name === name);
      return branch?.commit ? { root, tip: branch.commit } : null;
    }),
  );
  const targets = candidates.filter((candidate) => candidate !== null);
  return targets.length === roots.length ? { project, targets } : null;
}

function notifyMergeSuccess(title: string, name: string, cleanup: MergedBranchCleanup | null) {
  if (!cleanup || isProtectedBranch(name)) {
    notifications().notify({ group: "vcs", level: "info", title });
    return;
  }
  const isCurrentProject = () => useProject.getState().project === cleanup.project;
  if (!isCurrentProject()) return;
  const key = `vcs.mergeCleanup.${JSON.stringify([name, ...cleanup.targets.map(({ root }) => root)])}`;
  let deletionStarted = false;
  const deleteMergedBranches = async () => {
    if (deletionStarted || !isCurrentProject() || isProtectedBranch(name)) return;
    deletionStarted = true;
    notifications().expire?.(key);
    const deleted: BranchDeletion[] = [];
    for (const { root, tip } of cleanup.targets) {
      if (!isCurrentProject()) return;
      const branch = await runOp(
        tx`Delete branch ${name} (${repoName(root)})`,
        () => call(commands.vcsDeleteMergedBranch(root, name, tip)),
        { refresh: false },
      );
      if (branch) deleted.push({ repo: root, branch });
    }
    await refreshNow();
    await notifyBranchDeletion(name, deleted, cleanup.project, cleanup.targets.length);
  };
  notifications().notify({
    group: "vcs",
    level: "info",
    key,
    title,
    actions: [{ label: tx`Delete ${name}`, run: deleteMergedBranches }],
  });
}

export async function mergeIntoCurrent(branch: string, repo: string | null = currentRepo(), ref = branch) {
  const current = (repo === currentRepo() ? useVcs.getState().branch?.head : null) ?? "HEAD";
  const root = repo ?? currentRepoRoot();
  const project = useProject.getState().project;
  const cleanup = await captureMergedBranch(branch, ref, root ? [root] : []);
  await saveAll();
  const outcome = await performMerge(ref, tx`Merge ${branch} into ${current}`, repo);
  const success = () => notifyMergeSuccess(tx`Merged ${branch} into ${current}`, branch, cleanup);
  if (outcome === "conflicts") {
    await openMergeConflicts(root, project, success);
  } else {
    await refreshNow();
    if (outcome === "done") success();
    else if (outcome === "alreadyUpToDate") notifyMergeSuccess("Already up to date", branch, cleanup);
  }
}

export async function rebaseOnto(branch: string, ref = branch) {
  const repo = currentRepo();
  const current = useVcs.getState().branch?.head ?? "HEAD";
  await saveAll();
  await runOp(tx`Rebase ${current} onto ${branch}`, () => call(commands.vcsRebase(repo, ref, null)), {
    success: tx`Rebased ${current} onto ${branch}`,
    errorActions: conflictActions,
    onError: openConflictsInstead,
  });
}

/**
 * Renames a local branch. `git branch -m` carries the upstream tracking to the new name;
 * a branch that has one also offers to drop it, since the remote branch keeps its old name.
 */
export async function renameBranch(branch: Branch) {
  const name = branch.name;
  const repo = currentRepoRoot();
  const project = useProject.getState().project;
  const rename = await promptBranchRename(name, [repo], !!branch.upstream, project);
  if (!rename || useProject.getState().project !== project) return;
  const { to, unsetUpstream } = rename;
  const ok = await runOp(
    tx`Rename branch ${name}`,
    () => call(commands.vcsRenameBranch(repo, name, to, unsetUpstream)),
    {
      success: tx`Renamed branch ${name} to ${to}`,
      onError: (message) => {
        // Unsetting the upstream can fail after the rename has succeeded.
        notifications().notify({ group: "vcs", level: "error", title: tx`Rename branch ${name}`, body: message });
        return true;
      },
    },
  );
  if (ok !== undefined && useProject.getState().project === project) renameRecent(name, to);
}

async function promptBranchRename(
  name: string,
  roots: readonly (string | null)[],
  upstream: boolean,
  project: ProjectInfo | null,
) {
  const scopes = await Promise.all(
    roots.map(async (repo) => {
      const branches = await call(commands.vcsBranches(repo)).catch(() =>
        repo === currentRepoRoot() ? useVcs.getState().branches : [],
      );
      return { repo, branches };
    }),
  );
  if (useProject.getState().project !== project) return null;
  const hasUpstream =
    upstream ||
    scopes.some(({ branches }) => branches.some((branch) => !branch.remote && branch.name === name && branch.upstream));
  const destinations = scopes.map(({ repo, branches }) => ({
    repo,
    branches: branches.filter((branch) => branch.remote || branch.name !== name),
  }));
  const r = await promptText({
    title: tx`Rename Branch ${name}`,
    label: roots.length > 1 ? tx`New branch name (in ${roots.length} repositories):` : "New branch name:",
    initial: name,
    prefixes: branchNamePrefixes(scopes.flatMap(({ branches }) => branches)),
    mono: true,
    okLabel: "Rename",
    sanitize: cleanUpBranchNameOnTyping,
    validate: (v) => {
      if (v.trim() === name) return "Enter a new name";
      const invalid = validateBranchName(v, false, []);
      if (invalid) return invalid;
      for (const { repo, branches } of destinations) {
        const conflict = validateBranchName(v, false, branches);
        if (conflict) return repo && roots.length > 1 ? `${tx(conflict)} (${repoName(repo)})` : conflict;
      }
      return null;
    },
    checkbox: hasUpstream ? { label: "Unset upstream branch", initial: false } : undefined,
  });
  return r ? { to: r.value.trim(), unsetUpstream: hasUpstream && r.checked } : null;
}

function renameRecent(from: string, to: string) {
  try {
    localStorage.setItem(recentKey(), JSON.stringify(recentBranches().map((b) => (b === from ? to : b))));
  } catch {
    // Recents are best effort.
  }
}

/**
 * A branch checked out in another worktree cannot be deleted: `git branch -d` refuses.
 * Offers to delete such a worktree first (its folder goes with it); false when the user
 * backed out. The main worktree cannot be removed, so it keeps git's own message on the
 * branch deletion. A worktree containing this window's project cannot be removed either;
 * worktrees below a project opened on a parent folder can still be offered.
 */
async function deleteHoldingWorktree(repo: string | null, name: string): Promise<boolean> {
  const project = useProject.getState().project;
  let holding: Worktree | undefined;
  try {
    holding = (await call(commands.vcsWorktrees(repo))).find((w) => w.branch === name && !w.main);
  } catch {
    return true; // no worktree list: let the branch deletion speak for itself
  }
  if (!holding) return true;
  const root = project?.root.replace(/\/+$/, "");
  const path = holding.path.replace(/\/+$/, "");
  if (root !== undefined && (root === path || root.startsWith(path + "/"))) return true;
  const ok = await confirmDialog({
    title: "Delete Branch",
    message: tx`Branch '${name}' is checked out in the worktree at ${holding.path}.\nDelete the worktree and the branch? Its folder is deleted.`,
    okLabel: "Delete",
    danger: true,
  });
  if (!ok || useProject.getState().project !== project) return false;
  try {
    await call(commands.vcsRemoveWorktree(repo, holding.path, false));
  } catch (e) {
    const force = await confirmDialog({
      title: "Delete Branch",
      message: tx`${errorMessage(e)}\n\nRemove it anyway, discarding its changes?`,
      okLabel: "Force Remove",
      danger: true,
    });
    if (!force || useProject.getState().project !== project) return false;
    const removed = await runOp(tx`Delete branch ${name}`, async () => {
      await call(commands.vcsRemoveWorktree(repo, holding.path, true));
      return true;
    });
    if (!removed) return false;
  }
  return true;
}

interface BranchDeletion {
  repo: string | null;
  branch: DeletedBranch;
}

async function notifyBranchDeletion(
  name: string,
  deleted: readonly BranchDeletion[],
  project: ProjectInfo | null,
  total = deleted.length,
) {
  const isCurrentProject = () => useProject.getState().project === project;
  if (!deleted.length || !isCurrentProject()) return;
  const key = `vcs.deletedBranch.${JSON.stringify([name, ...deleted.map(({ repo }) => repo)])}`;
  const pending = new Set(deleted);
  let busy = false;
  const restore = async () => {
    if (busy || !pending.size || !isCurrentProject()) return;
    busy = true;
    try {
      for (const entry of pending) {
        if (!isCurrentProject()) return;
        const ok = await runOp(
          tx`Restore branch ${name}`,
          async () => {
            await call(commands.vcsRestoreBranch(entry.repo, entry.branch));
            return true;
          },
          { refresh: false },
        );
        if (ok) pending.delete(entry);
      }
      await refreshNow();
      if (!pending.size && isCurrentProject()) {
        notifications().expire?.(key);
        notifications().notify({ group: "vcs", level: "info", title: tx`Restored branch ${name}` });
      }
    } finally {
      busy = false;
    }
  };
  const ranges = deleted.flatMap(({ repo, branch }) =>
    branch.unmerged ? [{ repo, from: branch.unmergedBase ?? "HEAD", to: branch.tip }] : [],
  );
  const tracked = deleted.flatMap(({ repo, branch }) =>
    branch.upstream && branch.remoteUpstream
      ? [
          {
            repo,
            tracking: branch.upstream,
            ...branch.remoteUpstream,
            ref: `${branch.remoteUpstream.remote}/${branch.remoteUpstream.branch}`,
          },
        ]
      : [],
  );
  const canDeleteTracked = async () => {
    if (!isCurrentProject() || !tracked.length || deleted.length !== total) return false;
    const valid = await Promise.all(
      tracked.map(async ({ repo, tracking, remote, branch, ref }) => {
        if (isProtectedBranch(branch)) return false;
        const [branches, remotes] = await Promise.all([
          call(commands.vcsBranches(repo)).catch(() => []),
          configuredRemoteNames(repo),
        ]);
        return (
          remotes.includes(remote) &&
          splitTracked(ref, remotes).remote === remote &&
          branches.some((b) => b.remote && b.name === ref) &&
          !branches.some((b) => !b.remote && b.upstream === tracking)
        );
      }),
    );
    return isCurrentProject() && valid.every(Boolean);
  };
  const offerTracked = await canDeleteTracked();
  if (!isCurrentProject()) return;
  const count = deleted.length;
  const title =
    total === 1
      ? tx`Deleted branch ${name}`
      : count === total
        ? tx`Deleted branch ${name} in ${total} repositories`
        : tx`Deleted branch ${name} in ${count} of ${total} repositories`;
  notifications().notify({
    group: "vcs",
    level: "info",
    key,
    title,
    body: ranges.length ? "Unmerged commits were discarded" : undefined,
    actions: [
      { label: "Restore", run: restore },
      ...(ranges.length
        ? [
            {
              label: "View Commits",
              run: () => {
                if (isCurrentProject() && pending.size) showCommitRanges(tx`Commits of ${name}`, ranges, restore);
              },
            },
          ]
        : []),
      ...(offerTracked
        ? [
            {
              label: "Delete Tracked Branch",
              run: async () => {
                if (busy || pending.size !== deleted.length || !isCurrentProject()) return;
                busy = true;
                try {
                  if (!(await canDeleteTracked())) return;
                  if (!(await confirmDialog(remoteDeletionQuestion(tracked))) || !(await canDeleteTracked())) return;
                  notifications().expire?.(key);
                  await runRemoteRound(
                    tracked.map(({ repo, ref }) => ({
                      repo,
                      op: { op: "deleteBranch", branch: ref },
                    })),
                  );
                } finally {
                  busy = false;
                }
              },
            },
          ]
        : []),
    ],
  });
}

export async function deleteBranch(name: string, repo = currentRepo()) {
  const project = useProject.getState().project;
  const root = repo ?? currentRepoRoot();
  if (!(await deleteHoldingWorktree(root, name)) || useProject.getState().project !== project) return;
  const branch = await runOp(tx`Delete branch ${name}`, () => call(commands.vcsDeleteBranch(root, name)));
  if (branch) await notifyBranchDeletion(name, [{ repo: root, branch }], project);
}

/** Remote names come from Git config, including remotes without tracking branches. */
export async function configuredRemoteNames(repo: string | null): Promise<string[]> {
  return (await call(commands.vcsRemotes(repo)).catch(() => [])).map((remote) => remote.name);
}

export interface RemoteBranchPull {
  branch: string;
  rebase: boolean;
  repositories?: readonly string[];
}

export async function pullRemoteBranch({ branch: selected, rebase, repositories }: RemoteBranchPull) {
  if (!selected.includes("/")) return;
  const project = useProject.getState().project;
  const roots = [...new Set(repositories ?? [currentRepoRoot()])];
  const targets = await Promise.all(
    roots.map(async (repo) => {
      const { remote, branch } = splitTracked(selected, await configuredRemoteNames(repo));
      return {
        repo,
        requireCurrentBranch: true,
        op: { op: "pullFrom" as const, remote, branches: [branch], rebase, options: {} },
      };
    }),
  );
  if (useProject.getState().project !== project) return;
  await saveAll();
  if (useProject.getState().project !== project) return;
  await runRemoteRound(targets, selected);
}

/** Tag › Delete: deletes the local tag; the notification restores it or deletes it on the remotes too. */
export async function deleteTag(name: string, repo = currentRepo()) {
  const project = useProject.getState().project;
  const deleted = await runOp(tx`Delete tag ${name}`, () => call(commands.vcsDeleteTag(repo, name)));
  if (!deleted) return;
  const remotes = await configuredRemoteNames(repo);
  const isCurrentProject = () => useProject.getState().project === project;
  if (!isCurrentProject()) return;
  const key = `vcs.deletedTag.${JSON.stringify([repo, name])}`;
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
          if (!isCurrentProject()) return;
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
                if (!isCurrentProject()) return;
                void runRemote({ op: "deleteTagOnRemotes", deleted }, name, [repo]);
              },
            },
          ]
        : []),
    ],
  });
}

/** Push Tag › Push to `remote`. */
export async function pushTag(tag: string, remote: string, repo = currentRepo()) {
  await runRemote({ op: "pushTag", tag, remote }, `${tag} → ${remote}`, [repo]);
}

/** Deletes a branch on its remote (`git push <remote> --delete <name>`); `name` is e.g. `origin/feature`. */
export async function deleteRemoteBranch(name: string, repo = currentRepo()) {
  const project = useProject.getState().project;
  const remote = [{ repo: repo ?? currentRepoRoot(), ref: name }];
  const tracking = await confirmRemoteDeletion(remote, project);
  if (tracking) await deleteRemoteBranches(remote, tracking, project);
}

/** Delete is offered for branches other than the current one in their repository. */
type BranchDeleteTarget = { ref?: string; repo?: string; branch?: Pick<Branch, "name" | "remote" | "current"> };

export function canDeleteBranch(t: BranchDeleteTarget | null): boolean {
  return !!t?.branch && !t.branch.current;
}

interface RemoteBranchDeletion {
  ref: string;
  repo: string | null;
}

interface TrackingBranchDeletion extends RemoteBranchDeletion {
  name: string;
  tip: string;
}

function groupBranchDeletions<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = key(item);
    const group = groups.get(name) ?? [];
    group.push(item);
    groups.set(name, group);
  }
  return groups;
}

function remoteDeletionQuestion(remote: readonly RemoteBranchDeletion[]) {
  if (remote.length === 1) {
    const name = remote[0]!.ref;
    return {
      title: "Delete Remote Branch",
      message: tx`Delete branch '${shortRemoteName(name)}' on the remote? The remote-tracking branch '${name}' is removed as well.`,
      okLabel: "Delete",
      danger: true,
    };
  }
  const names = remote.map(({ ref, repo }) => (repo ? `${ref} (${repoName(repo)})` : ref)).join("', '");
  return {
    title: "Delete Remote Branches",
    message: tx`Delete the ${remote.length} branches '${names}' on the remote? The remote-tracking branches are removed as well.`,
    okLabel: "Delete",
    danger: true,
  };
}

async function commonTrackingDeletions(remote: readonly RemoteBranchDeletion[]): Promise<TrackingBranchDeletion[]> {
  const repos = [...new Set(remote.map(({ repo }) => repo))];
  const branches = new Map(
    await Promise.all(
      repos.map(async (repo) => [repo, await call(commands.vcsBranches(repo)).catch(() => [])] as const),
    ),
  );
  const groups = groupBranchDeletions(remote, ({ ref }) => ref);
  return [...groups.values()].flatMap((targets) => {
    const trackers = targets.map(({ repo, ref }) =>
      (branches.get(repo) ?? []).flatMap((branch) =>
        !branch.remote && !branch.current && branch.upstream === ref && branch.commit
          ? [{ name: branch.name, tip: branch.commit }]
          : [],
      ),
    );
    const common = (trackers[0] ?? []).filter((branch) =>
      trackers.every((list) => list.some((b) => b.name === branch.name)),
    );
    return targets.flatMap((target, i) =>
      (trackers[i] ?? [])
        .filter((branch) => common.some((b) => b.name === branch.name))
        .map((branch) => ({ ...target, ...branch })),
    );
  });
}

async function confirmRemoteDeletion(
  remote: readonly RemoteBranchDeletion[],
  project: ProjectInfo | null,
  selectedLocal?: ReadonlyMap<string, ReadonlySet<string | null>>,
): Promise<TrackingBranchDeletion[] | null> {
  const tracked = (await commonTrackingDeletions(remote)).filter(
    ({ repo, name }) => !selectedLocal?.get(name)?.has(repo),
  );
  if (useProject.getState().project !== project) return null;
  const question = remoteDeletionQuestion(remote);
  if (!tracked.length) return (await confirmDialog(question)) ? [] : null;
  const names = [...new Set(tracked.map(({ name }) => name))];
  const name = names[0]!;
  const list = names.map((name) => `'${name}'`).join(", ");
  const result = await confirmChecked({
    title: question.title,
    message: question.message,
    ok: question.okLabel,
    icon: "warning",
    presentation: "form",
    checkbox:
      names.length === 1
        ? tx`Delete the local tracking branch '${name}' as well`
        : tx`Also delete the local tracking branches ${list}`,
  });
  return result ? (result.checked ? tracked : []) : null;
}

async function deleteRemoteBranches(
  remote: readonly RemoteBranchDeletion[],
  tracking: readonly TrackingBranchDeletion[],
  project: ProjectInfo | null,
) {
  const isCurrentProject = () => useProject.getState().project === project;
  if (!isCurrentProject()) return;
  const failures = await runRemoteRound(
    remote.map(({ repo, ref }) => ({ repo, op: { op: "deleteBranch", branch: ref } })),
  );
  if (!failures || !isCurrentProject()) return;
  const failedRefs = new Set(failures.map(({ target }) => target.op.branch));
  for (const [name, targets] of groupBranchDeletions(tracking, (target) => target.name)) {
    const deleted: BranchDeletion[] = [];
    for (const { repo, ref, tip } of targets) {
      if (!isCurrentProject()) return;
      if (failedRefs.has(ref)) continue;
      const branch = await runOp(tx`Delete branch ${name}`, () =>
        call(commands.vcsDeleteTrackingBranch(repo, name, tip, ref)),
      );
      if (branch) deleted.push({ repo, branch });
    }
    await notifyBranchDeletion(name, deleted, project, targets.length);
  }
}

/** Deletes selected branches in their repositories without changing focus, skipping current branches. */
export async function deleteBranches(targets: readonly BranchDeleteTarget[]) {
  const list = targets.filter((t): t is Required<Pick<BranchDeleteTarget, "branch">> & BranchDeleteTarget =>
    canDeleteBranch(t),
  );
  if (!list.length) return;
  const project = useProject.getState().project;
  const fallback = currentRepoRoot();
  const remote = [
    ...new Map(
      list
        .filter((t) => t.branch.remote)
        .map((t) => {
          const target = { ref: t.branch.name, repo: t.repo ?? fallback };
          return [JSON.stringify([target.repo, target.ref]), target] as const;
        }),
    ).values(),
  ];
  const local = new Map<string, Set<string | null>>();
  for (const t of list) {
    const repo = t.repo ?? fallback;
    if (t.branch.remote) continue;
    const repos = local.get(t.branch.name) ?? new Set<string | null>();
    repos.add(repo);
    local.set(t.branch.name, repos);
  }
  const tracking = remote.length ? await confirmRemoteDeletion(remote, project, local) : [];
  if (!tracking) return;
  for (const [name, repos] of local) {
    if (useProject.getState().project !== project) return;
    const roots = [...repos].filter((repo) => repo !== null);
    if (roots.length > 1 && roots.length === repos.size) await deleteInRepos(name, roots);
    else for (const repo of repos) await deleteBranch(name, repo);
  }
  if (remote.length) await deleteRemoteBranches(remote, tracking, project);
}

export interface CheckoutRebaseTarget {
  branch: Pick<Branch, "name" | "remote">;
  repos: readonly (string | null)[];
}

/** Confirms the destination and any discarded commits before rewriting any repository. */
export async function checkoutAndRebase({ branch, repos }: CheckoutRebaseTarget) {
  const project = useProject.getState().project;
  const roots = branchRebaseRoots(repos);
  if (!project || !roots.length) return;
  const title = tx("Checkout and Rebase");
  const prepared = await runOp(
    title,
    async () => {
      const states = await Promise.all(
        roots.map(async (repo) => {
          const [head, branches] = await Promise.all([
            call(commands.vcsBranchInfo(repo)),
            call(commands.vcsBranches(repo)),
          ]);
          const sourceTip = branches.find((b) => b.name === branch.name && b.remote === branch.remote)?.commit;
          if (!sourceTip) throw new Error(tx`Branch '${branch.name}' is no longer available`);
          if (!head.headCommit) throw new Error(tx("Checkout and Rebase requires an existing commit"));
          if (head.operation) throw new Error(tx`Finish the Git operation in ${repoName(repo)} before rebasing`);
          return { repo, base: { branch: head.head, commit: head.headCommit }, branches, sourceTip };
        }),
      );
      let branchName = branch.remote ? shortRemoteName(branch.name) : branch.name;
      if (
        branch.remote &&
        states.some(({ branches }) =>
          branches.some((b) => !b.remote && b.name === branchName && b.upstream && b.upstream !== branch.name),
        )
      ) {
        const result = await promptText({
          title: tx`Checkout '${branch.name}'`,
          label: "New branch name:",
          initial: branchName,
          mono: true,
          okLabel: "Checkout and Rebase",
          validateInitial: true,
          sanitize: cleanUpBranchNameOnTyping,
          validate: (name) =>
            validateBranchName(
              name,
              false,
              states.flatMap(({ branches }) => branches),
            ),
        });
        if (!result) return;
        branchName = result.value.trim();
      }
      if (states.some(({ base }) => base.branch === branchName))
        throw new Error(tx`Branch '${branchName}' is already the current branch`);
      const candidates = await Promise.all(
        states.map(async ({ repo, base, branches, sourceTip }) => {
          const branchTip = branches.find((b) => !b.remote && b.name === branchName)?.commit ?? null;
          const divergent =
            branch.remote &&
            !!branchTip &&
            branchTip !== sourceTip &&
            (await call(commands.vcsMergeBase(repo, branchTip, sourceTip))) !== branchTip;
          return { repo, base, sourceTip, branchTip, divergent };
        }),
      );
      let drop = false;
      if (candidates.some(({ divergent }) => divergent)) {
        const choice = await ask({
          title: tx`Checkout '${branch.name}'`,
          body: tx`Local branch '${branchName}' has commits that do not exist in '${branch.name}'. Which commits should be rebased onto the current branch?`,
          icon: "warning",
          buttons: [
            { id: "local", label: "Use Local Branch", primary: true },
            { id: "drop", label: "Drop Local Commits" },
            { id: "cancel", label: "Cancel" },
          ],
        });
        if (choice.button !== "local" && choice.button !== "drop") return;
        drop = choice.button === "drop";
      }
      const plans = candidates.map(({ repo, base, sourceTip, branchTip, divergent }): PlannedRebase => {
        const dropLocalCommits = drop && divergent;
        const plan: CheckoutRebasePlan = {
          base,
          branch: branchName,
          branchTip,
          remote: branch.remote ? { name: branch.name, commit: sourceTip, dropLocalCommits } : null,
        };
        return {
          root: repo,
          operation: { op: "checkoutRebase", plan },
          state: {
            original: { branch: branchName, commit: dropLocalCommits ? sourceTip : (branchTip ?? sourceTip) },
            onto: base.commit,
          },
        };
      });
      return { branchName, plans };
    },
    { refresh: false },
  );
  if (!prepared || useProject.getState().project !== project) return;
  const { branchName, plans } = prepared;
  await runBranchRebases(plans, {
    progress: title,
    success: tx`Checked out and rebased '${branchName}'`,
    failure: tx("Checkout and Rebase failed"),
    onRebased({ operation }) {
      if (operation.op === "checkoutRebase") {
        rememberBranch(operation.plan.base.branch);
        rememberBranch(operation.plan.branch);
      }
    },
  });
}

export type BranchUpdateTarget = { repo?: string; branch?: Pick<Branch, "name" | "remote"> };

/** Update the named branches. Checked-out branches follow the configured update method. */
export async function updateBranches(targets: readonly BranchUpdateTarget[]) {
  const project = useProject.getState().project;
  const fallback = currentRepoRoot();
  const byRepo = new Map<string | null, Set<string>>();
  for (const { branch, repo = fallback } of targets) {
    if (!branch || branch.remote) continue;
    const names = byRepo.get(repo) ?? new Set<string>();
    names.add(branch.name);
    byRepo.set(repo, names);
  }
  if (!byRepo.size) return;
  const heads = await Promise.all(
    [...byRepo.keys()].map(async (repo) => [repo, await call(commands.vcsBranchInfo(repo)).catch(() => null)] as const),
  );
  if (useProject.getState().project !== project) return;
  await saveAll();
  if (useProject.getState().project !== project) return;

  const rebase = workflowSettings().vcs.git.updateMethod === "rebase";
  const current: RemoteTarget<Extract<RemoteOp, { op: "pull" }>>[] = [];
  for (const [repo, info] of heads) {
    const names = byRepo.get(repo)!;
    if (!info?.head || (!info.upstream && !info.upstreamTracking) || !names.delete(info.head)) continue;
    if (!names.size) byRepo.delete(repo);
    current.push({ repo, op: { op: "pull", rebase, expectedBranch: info.head } });
  }
  if (byRepo.size) {
    const results = await runBranchUpdates(new Map([...byRepo].map(([repo, names]) => [repo, [...names]])));
    if (!results || useProject.getState().project !== project) return;
    const { lines, ...summary } = branchUpdateSummary(results, heads.length > 1);
    const body = createElement(Fragment, null, ...lines.map((line) => createElement("div", { key: line }, line)));
    const worktrees = [...new Set(results.flatMap((r) => (r.status === "failed" && r.worktree ? [r.worktree] : [])))];
    notifications().notify({
      group: "vcs",
      key: "vcs.branch-update",
      userInitiated: true,
      ...summary,
      body,
      actions: worktrees.map((path) => {
        const name = repoName(path);
        return { label: tx`Open Worktree ${name}`, run: () => void openWorktree(path, true) };
      }),
    });
  }
  if (current.length && useProject.getState().project === project) await runRemoteRound(current);
}

/** IDEA's "Selected branches updated" balloon: which branches were updated, and why the others were not. */
export function branchUpdateSummary(
  results: readonly RepoBranchUpdate[],
  showRepo = new Set(results.map((r) => r.repo)).size > 1,
) {
  const label = (r: RepoBranchUpdate) => (showRepo && r.repo ? `${repoName(r.repo)}: ${r.branch}` : r.branch);
  const names = (status: BranchUpdateStatus) =>
    results
      .filter((r) => r.status === status)
      .map(label)
      .join(", ");
  const count = (status: BranchUpdateStatus) => results.filter((r) => r.status === status).length;
  const updated = count("updated");
  const problems = count("notFastForward") + count("noUpstream") + count("failed");
  const lines = [
    updated ? tx`Updated: ${names("updated")}` : null,
    count("upToDate") ? tx`Already up-to-date: ${names("upToDate")}` : null,
    count("notFastForward") ? tx`Not updated, cannot be fast-forwarded: ${names("notFastForward")}` : null,
    count("noUpstream") ? tx`Not updated, no tracked branch: ${names("noUpstream")}` : null,
    ...results
      .filter((r) => r.status === "failed")
      .map((r) => {
        const message = txTemplate(r.message ?? "");
        return tx`Failed to update ${label(r)}: ${message}`;
      }),
  ].filter((l): l is string => !!l);
  const title = updated
    ? updated === 1
      ? tx`Updated ${updated} branch`
      : tx`Updated ${updated} branches`
    : problems
      ? tx("No branches were updated")
      : tx("Selected branches are up-to-date");
  return { level: problems ? ("warning" as const) : ("info" as const), title, lines };
}

// --- several repositories ----------------------------------------------------

/** "in 3 repositories", or "in 2 of 3 repositories" when some were left out. */
function inRepos(done: number, total: number): string {
  if (done === total) return total === 1 ? "in 1 repository" : `in ${total} repositories`;
  return `in ${done} of ${total} repositories`;
}

interface Rollback<T> {
  /** What rolling back does, for the question: "check out the previous branch again". */
  undo: string;
  changed?: (result: T) => boolean;
  run: (root: string, result: T, before: BranchInfo) => Promise<unknown>;
}

interface RepoStep<T> {
  root: string;
  result: T;
  before: BranchInfo;
}

const skippedRepo = Symbol("skipped repository");

const branchInfo = (root: string) => call(commands.vcsBranchInfo(root)).catch(() => null);

/**
 * Runs `step` in each repository in turn, stopping at the first one that fails (its
 * error is reported by `step`), then reports how many repositories it was done in.
 * When it failed after succeeding in some repositories, offers to roll those back so
 * the repositories don't diverge (not when the failed one stopped on conflicts).
 * Returns the number of repositories it stays done in after any rollback.
 */
async function eachRepo<T>(
  roots: readonly string[],
  step: (root: string, batch: string | null) => Promise<T | typeof skippedRepo | undefined>,
  title: string | ((done: readonly RepoStep<T>[], complete: boolean) => Promise<string | null>),
  rollback?: Rollback<T>,
  preserve = false,
  notifySuccess: (title: string, complete: boolean, done: readonly RepoStep<T>[]) => void | Promise<void> = (title) => {
    notifications().notify({ group: "vcs", level: "info", title });
  },
): Promise<number> {
  const done: RepoStep<T>[] = [];
  let failed: string | null = null;
  const batch = startShelfBatch(roots, preserve);
  const endWork = batch.id ? beginGitWork() : undefined;
  let restoreError: string | null;
  try {
    for (const root of roots) {
      const before = await runOp(tx("Read repository HEAD"), () => call(commands.vcsBranchInfo(root)), {
        refresh: false,
      });
      if (!before) {
        failed = root;
        break;
      }
      const result = await step(root, batch.id);
      if (result === skippedRepo) continue;
      if (result === undefined) {
        failed = root;
        break;
      }
      done.push({ root, result, before });
    }
  } finally {
    restoreError = await batch.finish().finally(() => endWork?.());
  }
  await refreshNow();
  if (restoreError !== null) return done.length;
  const didChange = rollback?.changed;
  const changed = didChange ? done.filter(({ result }) => didChange(result)) : done;
  if (failed && changed.length && rollback && !(await branchInfo(failed))?.operation) {
    const succeeded = changed.map((d) => repoName(d.root)).join(", ");
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
      let remaining = done.length;
      for (const d of changed.reverse()) {
        const repo = repoName(d.root);
        const undone = await runOp(
          tx`Rollback (${repo})`,
          async () => {
            await rollback.run(d.root, d.result, d.before);
            return true;
          },
          { refresh: false },
        );
        if (undone) remaining--;
      }
      await refreshNow();
      return remaining;
    }
  }
  if (done.length) {
    const complete = !failed && done.length === roots.length;
    const label = typeof title === "function" ? await title(done, complete) : title;
    if (label) await notifySuccess(`${label} ${inRepos(done.length, roots.length)}`, complete, done);
  }
  return done.length;
}

/** The repositories of `roots` whose current branch is not `name`. */
function reposNotOn(name: string, roots: readonly string[]): string[] {
  const { heads } = useVcs.getState();
  return roots.filter((root) => heads[root]?.head !== name);
}

/** HEAD as a checkout target: the branch, or the commit on a detached HEAD. */
const headRef = (b: BranchInfo) => (b.head ? branchRef(b.head, false) : `${b.headCommit ?? "HEAD"}^{commit}`);

async function checkoutBack(root: string, before: BranchInfo) {
  const outcome = await call(
    commands.vcsCheckout(root, headRef(before), false, { mode: "smart", diverged: null }, null),
  );
  if (outcome.kind !== "done") throw new Error(tx("Could not check out the previous branch"));
}

/** Moves HEAD back to where it was before a merge or rebase, keeping local changes. */
async function resetBack(root: string, before: BranchInfo) {
  const after = (await branchInfo(root))?.headCommit;
  if (before.headCommit && after)
    await call(commands.vcsRestoreHead(root, before.headCommit, after, before.head, null));
}

/**
 * Checks out `name` (local, or remote: its local namesake) in every repository of `roots`
 * not already on it (with diverged branches, only the others move).
 */
export async function checkoutInRepos(branch: NamedBranch, roots: readonly string[]) {
  const { name, remote } = branch;
  const elsewhere = remote ? roots : reposNotOn(name, roots);
  if (!elsewhere.length) return;
  const project = useProject.getState().project;
  const previous = useVcs.getState().branch?.head;
  let label = name;
  if (remote) {
    const check = await remoteCheckoutTargets(name, elsewhere);
    if (!check || useProject.getState().project !== project) return;
    if (check.conflict) return newBranchInRepos(elsewhere, branch);
    label = check.label;
  }
  const ref = branchRef(name, remote);
  const choose = localChangesChoices("checkout", ref, elsewhere);
  await eachRepo(
    elsewhere,
    async (root, id) =>
      useProject.getState().project === project &&
      (await performCheckout(ref, () => `Checked out ${label}`, root, {
        id,
        choose,
      }))
        ? true
        : undefined,
    `Checked out ${label}`,
    { undo: tx("check out the previous branch again"), run: (root, _, before) => checkoutBack(root, before) },
    true,
  );
  rememberBranch(previous);
  rememberBranch(useVcs.getState().branch?.head);
}

/** New Branch in every repository of `roots` (from HEAD or `from`), checked out by default. */
export async function newBranchInRepos(roots: readonly string[], from?: BranchSource) {
  return createBranch(roots, from);
}

/** Merges `branch` across repositories and reviews their conflicts together. */
export async function mergeInRepos(branch: string, roots: readonly string[], ref = branch) {
  const project = useProject.getState().project;
  const cleanup = await captureMergedBranch(branch, ref, roots);
  await saveAll();
  const choose = localChangesChoices("merge", ref, roots);
  await eachRepo(
    roots,
    (root, id) => performMerge(ref, tx`Merge ${branch} (${repoName(root)})`, root, { id, choose }),
    async (done, complete) => {
      const title = tx`Merged ${branch}`;
      const paused = done.filter(({ result }) => result === "conflicts").map(({ root }) => root);
      if (!paused.length)
        return done.every(({ result }) => result === "alreadyUpToDate") ? tx("Already up to date") : title;
      const session = project
        ? await trackMergeCompletion(paused, project, () => {
            if (complete) notifyMergeSuccess(`${title} ${inRepos(roots.length, roots.length)}`, branch, cleanup);
            else notifications().notify({ group: "vcs", level: "info", title: "Merge continued" });
          })
        : null;
      void executeAction("vcs.resolveConflicts", session ? { mergeRepo: paused[0] } : undefined);
      return null;
    },
    {
      undo: tx("reset to the commit before the merge"),
      changed: (result) => result !== "alreadyUpToDate",
      run: async (root, result, before) => {
        if (result === "conflicts" && (await branchInfo(root))?.operation === "merge") {
          return runGitOperation(
            { op: "abort", expected: "merge" },
            { progress: "Aborting merge", success: "Merge aborted", failure: "Abort failed" },
            root,
          );
        }
        return resetBack(root, before);
      },
    },
    true,
    (title, complete) => notifyMergeSuccess(title, branch, complete ? cleanup : null),
  );
}

/**
 * Deletes local branch `name` in every repository of `roots` where it is not checked out
 * (git refuses those; with diverged branches it may be current in some of them).
 */
export async function deleteInRepos(name: string, roots: readonly string[]) {
  const deletable = reposNotOn(name, roots);
  if (!deletable.length) return;
  const project = useProject.getState().project;
  await eachRepo(
    deletable,
    async (root) => {
      const canDelete = await deleteHoldingWorktree(root, name);
      if (useProject.getState().project !== project) return undefined;
      if (!canDelete) return skippedRepo;
      return runOp(tx`Delete branch ${name} (${repoName(root)})`, () => call(commands.vcsDeleteBranch(root, name)), {
        refresh: false,
      });
    },
    `Deleted branch ${name}`,
    { undo: tx`restore branch ${name}`, run: (root, deleted) => call(commands.vcsRestoreBranch(root, deleted)) },
    false,
    (_title, _complete, done) =>
      notifyBranchDeletion(
        name,
        done.map(({ root, result }) => ({ repo: root, branch: result })),
        project,
        deletable.length,
      ),
  );
}

/** Renames local branch `name` in every repository of `roots`; `upstream`: some of them track a remote branch. */
export async function renameInRepos(name: string, roots: readonly string[], upstream: boolean) {
  if (!roots.length) return;
  const project = useProject.getState().project;
  const rename = await promptBranchRename(name, roots, upstream, project);
  if (!rename || useProject.getState().project !== project) return;
  const { to, unsetUpstream } = rename;
  await eachRepo(
    roots,
    async (root) => {
      if (useProject.getState().project !== project) return skippedRepo;
      return runOp(
        tx`Rename branch ${name} (${repoName(root)})`,
        () => call(commands.vcsRenameBranch(root, name, to, false)),
        { refresh: false },
      ).then((done) => (done === undefined ? undefined : true));
    },
    tx`Renamed branch ${name} to ${to}`,
    {
      undo: tx`rename it back to ${name}`,
      run: async (root) => {
        if (useProject.getState().project === project) await call(commands.vcsRenameBranch(root, to, name, false));
      },
    },
    false,
    async (title, complete, done) => {
      if (useProject.getState().project !== project) return;
      if (complete) renameRecent(name, to);
      else rememberBranch(to);
      // Only change tracking after the user has decided which renames to retain.
      if (unsetUpstream) {
        for (const { root } of done) {
          if (useProject.getState().project !== project) return;
          await runOp(tx`Unset upstream of ${to} (${repoName(root)})`, () =>
            call(commands.vcsRenameBranch(root, to, to, true)),
          );
        }
      }
      if (useProject.getState().project === project) notifications().notify({ group: "vcs", level: "info", title });
    },
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
