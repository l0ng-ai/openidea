/**
 * Pure logic of review mode (IntelliJ's `GHPRConnectedProjectViewModel.prOnCurrentBranch`,
 * `GHPRReviewBranchStateSharedViewModel`, `GHPRReviewFileEditorModel`, collaboration-tools'
 * `CodeReviewEditorDocumentUtil` and `ExcludingApproximateChangedRangesShifter`):
 *
 * - the remote branch the current branch tracks, from its git config, and the REST query of
 *   the open pull request with that head;
 * - whether the local branch is in sync (the pull request's head is in its history);
 * - line ranges between revisions: the review's changes (the patch without context), the
 *   local edits of the document against the review head, and lines and ranges carried from
 *   the review head to the document and back;
 * - where a review thread sits in the editor (right side, current threads only).
 *
 * Lines are 0-based; ranges are half-open.
 */
import type { LineHunk } from "@/bindings";
import type { GHPullRequestReviewThread, GHRepositoryCoordinates } from "../api/types";
import type { PatchHunk } from "../diff/model";
import { parseGitHubRemote, remoteOfRepository } from "../data/model";

// ---------------------------------------------------------------------------
// The pull request of the current branch

/** What the current branch tracks (`branch.<name>.remote` / `.merge`). */
export interface TrackedBranch {
  /** The repository the remote points to. */
  repository: GHRepositoryCoordinates;
  /** The branch name on the remote (`refs/heads/` stripped). */
  branch: string | null;
  /** `refs/pull/<n>/head` (gh checks out some pull requests so): the pull request itself. */
  pullRequest: number | null;
}

/**
 * The remote branch the current branch tracks (`findHostedRemoteBranchTrackedByCurrent`):
 * `remote` is a remote's name or URL (gh sets URLs for forks), `merge` the remote ref.
 * Null when it tracks nothing or the remote is not on GitHub. `connected` is recognised by
 * the URL's path too, for a remote behind an SSH host alias.
 */
export function trackedBranch(
  remote: string | null,
  merge: string | null,
  remotes: ReadonlyArray<{ name: string; url: string }>,
  connected?: GHRepositoryCoordinates,
): TrackedBranch | null {
  if (!remote || !merge || remote === ".") return null;
  const url = remotes.find((r) => r.name === remote)?.url ?? remote;
  const repository =
    parseGitHubRemote(url) ?? (connected && remoteOfRepository([{ name: remote, url }], connected) ? connected : null);
  if (!repository) return null;
  const pr = /^refs\/pull\/(\d+)\/head$/.exec(merge);
  if (pr) return { repository, branch: null, pullRequest: Number(pr[1]) };
  const branch = merge.startsWith("refs/heads/") ? merge.slice("refs/heads/".length) : merge;
  return branch ? { repository, branch, pullRequest: null } : null;
}

/**
 * `GET /repos/{base}/pulls` for the open pull request whose head is `tracked`
 * (`GHPRCreationService.findOpenPullRequest`: `head=<owner>:<branch>`, first match only).
 */
export function openPullRequestQuery(base: GHRepositoryCoordinates, tracked: TrackedBranch): string | null {
  if (!tracked.branch) return null;
  const head = encodeURIComponent(`${tracked.repository.owner}:${tracked.branch}`);
  return `repos/${base.owner}/${base.name}/pulls?state=open&head=${head}&per_page=1`;
}

/**
 * `updateRequired` (`isInCurrentHistory`): the pull request's head is not in the local
 * history, i.e. it is not the merge base of itself and HEAD (null when git doesn't know it).
 */
export function isUpdateRequired(headRefOid: string, mergeBase: string | null): boolean {
  return mergeBase?.toLowerCase() !== headRefOid.toLowerCase();
}

// ---------------------------------------------------------------------------
// Line ranges

/** A change between two texts: lines `[start1, end1)` of the first are `[start2, end2)` of the second. */
export interface Range {
  start1: number;
  end1: number;
  start2: number;
  end2: number;
}

/** The changes of a patch without its context lines (`withoutContext`): base → review head. */
export function patchChanges(hunks: readonly PatchHunk[]): Range[] {
  const out: Range[] = [];
  for (const h of hunks) {
    let left = h.leftStart;
    let right = h.rightStart;
    let open: Range | null = null;
    const close = () => {
      if (open) out.push(open);
      open = null;
    };
    for (const row of h.rows) {
      const c = row[0];
      if (c === "\\") continue;
      if (c === "-" || c === "+") {
        open ??= { start1: left, end1: left, start2: right, end2: right };
        if (c === "-") open.end1 = ++left;
        else open.end2 = ++right;
      } else {
        close();
        left++;
        right++;
      }
    }
    close();
  }
  return out;
}

/** The commentable lines of a patch as ranges of both sides (`patch.ranges`: whole hunks). */
export function patchRanges(hunks: readonly PatchHunk[]): Range[] {
  return hunks.map((h) => ({
    start1: h.leftStart,
    end1: h.leftStart + h.leftCount,
    start2: h.rightStart,
    end2: h.rightStart + h.rightCount,
  }));
}

/** Line hunks of a text diff (`vcsDiffHunks(old, new)`) as ranges old → new. */
export function hunksToRanges(hunks: readonly Pick<LineHunk, "start" | "lines" | "oldStart" | "oldLines">[]): Range[] {
  return hunks
    .map((h) => ({ start1: h.oldStart, end1: h.oldStart + h.oldLines, start2: h.start, end2: h.start + h.lines }))
    .sort((a, b) => a.start1 - b.start1);
}

/** `transferLineToAfter`: `line` of the first text in the second (a changed line goes to the change's last line). */
export function lineToAfter(ranges: readonly Range[], line: number): number {
  let result = line;
  for (const r of ranges) {
    if (line >= r.start1 && line < r.end1) return Math.max(0, r.end2 - 1);
    if (r.end1 > line) return result;
    result += r.end2 - r.start2 - (r.end1 - r.start1);
  }
  return result;
}

/**
 * `transferLineFromAfter`: `line` of the second text in the first; null when it was added or
 * changed there, unless `approximate` (then the line after the change).
 */
export function lineFromAfter(ranges: readonly Range[], line: number, approximate = false): number | null {
  let result = line;
  for (const r of ranges) {
    if (line < r.start2) return result;
    if (line < r.end2) return approximate ? r.end1 : null;
    result -= r.end2 - r.start2 - (r.end1 - r.start1);
  }
  return result;
}

/**
 * `ExcludingApproximateChangedRangesShifter.shift`: `early` changes A → B and `later` ones
 * B → C as changes A → C, leaving out the parts of `early` that `later` changed again.
 */
export function shiftRanges(early: readonly Range[], later: readonly Range[]): Range[] {
  const result: Range[] = [];
  let i = 0;
  let shift = 0;
  for (const e of early) {
    let bStart = e.start2;
    let fullyMapped = false;
    while (i < later.length) {
      const l = later[i]!;
      const delta = l.end2 - l.start2 - (l.end1 - l.start1);
      if (l.end1 <= e.start2) {
        // Before.
        shift += delta;
        i++;
      } else if (l.start1 >= e.end2) {
        // After.
        break;
      } else if (l.start1 <= e.start2) {
        if (l.end1 >= e.end2) {
          // `early` inside `later`.
          fullyMapped = true;
          break;
        }
        // Overlapping its start.
        bStart = l.end1;
        shift += delta;
        i++;
      } else {
        result.push({ start1: e.start1, end1: e.end1, start2: shift + bStart, end2: l.start2 });
        if (l.end1 === e.end2) {
          shift += delta;
          i++;
          fullyMapped = true;
          break;
        } else if (l.end1 < e.end2) {
          // `later` inside `early`.
          bStart = l.end1;
          shift += delta;
          i++;
        } else {
          // Overlapping its end.
          fullyMapped = true;
          break;
        }
      }
    }
    if (!fullyMapped && bStart <= e.end2)
      result.push({ start1: e.start1, end1: e.end1, start2: shift + bStart, end2: shift + e.end2 });
  }
  return result;
}

export type ChangeKind = "added" | "modified" | "deleted";

/** A review change in the document, for the gutter (`asLst`). */
export interface DocumentChange {
  kind: ChangeKind;
  /** Document lines `[start, end)`; a deletion is empty at `start`. */
  start: number;
  end: number;
}

export function documentChanges(ranges: readonly Range[]): DocumentChange[] {
  return ranges.map((r) => ({
    kind: r.start1 === r.end1 ? "added" : r.start2 === r.end2 ? "deleted" : "modified",
    start: r.start2,
    end: r.end2,
  }));
}

// ---------------------------------------------------------------------------
// Threads in the editor

/**
 * The review-head lines `[start, end]` of `thread` in the editor (`mapToInEditorRange`):
 * current line threads on the right side only (outdated ones and left-side ones are not
 * in the head's text).
 */
export function editorThreadRange(thread: GHPullRequestReviewThread): { start: number; end: number } | null {
  if (thread.subjectType === "FILE" || thread.isOutdated || thread.line == null) return null;
  if (thread.diffSide !== "RIGHT" || (thread.startDiffSide ?? "RIGHT") !== "RIGHT") return null;
  const end = thread.line - 1;
  const start = (thread.startLine ?? thread.line) - 1;
  return start > end ? null : { start, end };
}

/** "Show Unresolved Comments Only" / "Show All Comments"; "Disable Review Mode" turns it off instead. */
export type EditorThreadsOption = "unresolved" | "all";
