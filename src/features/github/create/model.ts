/**
 * Pure logic of the New Pull Request tab (IntelliJ's `GHPRCreateViewModel` and
 * `GHPRCreateMergeDirectionModel`): the merge direction (base and head repository and
 * branch) and how it is shown, the default branches, the branches check, the generated
 * title and the push target of a local head.
 */
import type { Branch, Commit } from "@/platform/ipc";
import type { GHRepositoryCoordinates } from "../api/types";
import type { GHRemote } from "../data/repository";

/** A branch of a remote (`origin/main` is `{ remote: "origin", name: "main" }`). */
export interface RemoteBranchRef {
  remote: string;
  name: string;
}

/** The head: a local branch or a remote one (`GitLocalBranch` / `GitRemoteBranch`). */
export type HeadBranch = { kind: "local"; name: string } | ({ kind: "remote" } & RemoteBranchRef);

/** `BranchesState`: the base is always a branch of the connected repository. */
export interface Direction {
  baseRepo: GHRemote;
  baseBranch: RemoteBranchRef | null;
  headRepo: GHRemote | null;
  headBranch: HeadBranch | null;
}

const sameCoordinates = (a: GHRepositoryCoordinates, b: GHRepositoryCoordinates) =>
  a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();

/** `origin/main` → `{ remote: "origin", name: "main" }`, the longest matching remote name winning. */
export function splitRemoteBranch(full: string, remotes: readonly string[]): RemoteBranchRef | null {
  const remote = [...remotes].filter((r) => r && full.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0];
  return remote ? { remote, name: full.slice(remote.length + 1) } : null;
}

export const remoteBranchFullName = (b: RemoteBranchRef) => `${b.remote}/${b.name}`;

/** What git calls the head (`feature`, `origin/feature`). */
export const headBranchName = (b: HeadBranch) => (b.kind === "local" ? b.name : remoteBranchFullName(b));

export const sameRemoteBranch = (a: RemoteBranchRef | null | undefined, b: RemoteBranchRef | null | undefined) =>
  !!a && !!b && a.remote === b.remote && a.name === b.name;

export function sameHead(a: HeadBranch | null, b: HeadBranch | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind === "local" || b.kind === "local") return a.kind === b.kind && a.name === b.name;
  return sameRemoteBranch(a, b);
}

/** The branches of `remote` (its `HEAD` pointer left out), sorted by name. */
export function remoteBranchesOf(branches: readonly Branch[], remote: string): RemoteBranchRef[] {
  return branches
    .filter((b) => b.remote)
    .flatMap((b) => {
      const ref = splitRemoteBranch(b.name, [remote]);
      return ref && ref.name !== "HEAD" ? [ref] : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Local branches, sorted by name. */
export function localBranchesOf(branches: readonly Branch[]): HeadBranch[] {
  return branches
    .filter((b) => !b.remote)
    .map((b): HeadBranch => ({ kind: "local", name: b.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * `getDefaultRemoteBranch`: the repository's default branch on the base remote, else
 * `master`, else `main`.
 */
export function defaultBaseBranch(
  branches: readonly Branch[],
  remote: string,
  defaultBranch: string | null | undefined,
): RemoteBranchRef | null {
  const names = new Set(remoteBranchesOf(branches, remote).map((b) => b.name));
  const name = [defaultBranch, "master", "main"].find((n): n is string => !!n && names.has(n));
  return name ? { remote, name } : null;
}

/** The remote branch a local branch tracks (`upstream`), split by the known remotes. */
export function upstreamOf(
  branches: readonly Branch[],
  local: string,
  remotes: readonly string[],
): RemoteBranchRef | null {
  const upstream = branches.find((b) => !b.remote && b.name === local)?.upstream;
  return upstream ? splitRemoteBranch(upstream, remotes) : null;
}

/** The remote branch the head is or tracks (none for an untracked local branch). */
export function trackedHead(
  head: HeadBranch,
  branches: readonly Branch[],
  remotes: readonly string[],
): RemoteBranchRef | null {
  return head.kind === "remote" ? head : upstreamOf(branches, head.name, remotes);
}

/**
 * The default direction: base the default branch of the connected repository's remote,
 * head the current branch in the repository of its tracked remote (else the base one).
 */
export function defaultDirection(opts: {
  baseRepo: GHRemote;
  remotes: readonly GHRemote[];
  branches: readonly Branch[];
  currentBranch: string | null;
  defaultBranch: string | null | undefined;
}): Direction {
  const { baseRepo, remotes, branches, currentBranch } = opts;
  const names = remotes.map((r) => r.remote);
  const tracked = currentBranch ? upstreamOf(branches, currentBranch, names) : null;
  const headRepo = (tracked && remotes.find((r) => r.remote === tracked.remote)) || baseRepo;
  return {
    baseRepo,
    baseBranch: defaultBaseBranch(branches, baseRepo.remote, opts.defaultBranch),
    headRepo,
    headBranch: currentBranch ? { kind: "local", name: currentBranch } : null,
  };
}

const repoText = (r: GHRepositoryCoordinates, showOwner: boolean) => (showOwner ? `${r.owner}/${r.name}` : r.name);

/** The base as the direction selector shows it: `repo:branch`, `owner/repo:branch` when the head's repository differs. */
export function baseText(d: Direction): string | null {
  if (!d.baseBranch) return null;
  const showOwner = !!d.headRepo && !sameCoordinates(d.headRepo, d.baseRepo);
  return `${repoText(d.baseRepo, showOwner)}:${d.baseBranch.name}`;
}

/** The head as the direction selector shows it: `repo:branch` (`origin/branch` for a remote branch). */
export function headText(d: Direction): string | null {
  if (!d.headBranch || !d.headRepo) return null;
  const showOwner = !sameCoordinates(d.headRepo, d.baseRepo);
  return `${repoText(d.headRepo, showOwner)}:${headBranchName(d.headBranch)}`;
}

/** `git log base..head`. */
export const commitsRange = (base: RemoteBranchRef, head: HeadBranch) =>
  `${remoteBranchFullName(base)}..${headBranchName(head)}`;

/** `generateTitle`: the subject of the only commit, else the branch name. */
export function generateTitle(commits: readonly Pick<Commit, "summary">[], head: HeadBranch): string {
  return commits.length === 1 ? commits[0]!.summary : headBranchName(head);
}

/** `headRefName` of `createPullRequest`: `owner:branch` for a branch of another repository (a fork). */
export function headRefName(baseRepo: GHRepositoryCoordinates, headRepo: GHRepositoryCoordinates, branch: string) {
  return sameCoordinates(baseRepo, headRepo) ? branch : `${headRepo.owner}:${branch}`;
}

/** `head` of the REST pull request search: always `owner:branch`. */
export const searchHead = (headRepo: GHRepositoryCoordinates, branch: string) => `${headRepo.owner}:${branch}`;

/** `GitPushUtil.findPushTarget`: the tracked branch when it is on the head's remote. */
export function pushTarget(
  branches: readonly Branch[],
  local: string,
  headRemote: string,
  remotes: readonly string[],
): RemoteBranchRef | null {
  const upstream = upstreamOf(branches, local, remotes);
  return upstream?.remote === headRemote ? upstream : null;
}

/** Whether the local branch differs from its push target (or the target does not exist yet). */
export function needsPush(branches: readonly Branch[], local: string, target: RemoteBranchRef): boolean {
  const localTip = branches.find((b) => !b.remote && b.name === local)?.commit;
  const remoteTip = branches.find((b) => b.remote && b.name === remoteBranchFullName(target))?.commit;
  return !localTip || !remoteTip || localTip !== remoteTip;
}

const ILLEGAL_REF_CHARS = /[\u0000- \u007f~^:?*[\\]|\.\.|@\{/g; // eslint-disable-line no-control-regex

/** `GitRefNameValidator.cleanUpBranchName`: characters git refuses become `_`. */
export function cleanUpBranchName(name: string): string {
  return name
    .trim()
    .replace(ILLEGAL_REF_CHARS, "_")
    .replace(/^[./-]+|[./]+$/g, "")
    .replace(/\.lock$/, "_lock");
}

/** `BranchesCheckResult`. */
export type BranchesCheckResult =
  | { kind: "noChanges"; base: string; head: string }
  | { kind: "alreadyExists"; number: number }
  | { kind: "ok" };

/**
 * `checkBranches`: no changes when the head tracks the base or has no commits over
 * it, else an open pull request of the head, else OK.
 */
export function checkBranches(opts: {
  base: RemoteBranchRef;
  head: HeadBranch;
  tracked: RemoteBranchRef | null;
  commits: readonly unknown[];
  existing: number | null;
}): BranchesCheckResult {
  const { base, head } = opts;
  const noChanges = { kind: "noChanges" as const, base: base.name, head: headBranchName(head) };
  if (sameRemoteBranch(base, opts.tracked)) return noChanges;
  if (opts.commits.length === 0) return noChanges;
  if (opts.existing !== null) return { kind: "alreadyExists", number: opts.existing };
  return { kind: "ok" };
}

/** The description part of a commit message (`fullMessage.split("\n\n")[1]`). */
export function commitDescription(message: string): string {
  return message.split("\n\n")[1]?.trim() ?? "";
}
