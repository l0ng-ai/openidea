/**
 * Pure logic of review in the diff (IntelliJ's `GHPRDiffReviewViewModel`, `GHPRDiffViewModel`,
 * `GHPRThreadsViewModels`, `GHPRReviewNewCommentEditorViewModel`, `PatchHunkUtil`):
 *
 * - a file's patch (GitHub's `patch` of the changed file) parsed into hunks, the commentable
 *   ranges of each side (the hunks' lines), line mapping across a patch, and the "position"
 *   of a line (what commit comments are addressed by);
 * - where a review thread sits in the cumulative diff or in a single commit's diff, and
 *   whether the "Show Review Threads" option shows it;
 * - the new comment's GitHub input (`line`, `side`, `startLine`, `startSide`) and its submit
 *   actions;
 * - Previous / Next Comment: the threads in unified file / line order.
 *
 * Lines are 0-based unless the name says otherwise (GitHub's are 1-based).
 */
import type { GHDiffSide, GHPullRequestDraftReviewThread, GHPullRequestReviewThread } from "../api/types";

export type Side = "left" | "right";

export const toGitHubSide = (side: Side): GHDiffSide => (side === "left" ? "LEFT" : "RIGHT");
export const fromGitHubSide = (side: GHDiffSide): Side => (side === "LEFT" ? "left" : "right");

// ---------------------------------------------------------------------------
// Patches

export interface PatchHunk {
  /** 0-based first line of each side. */
  leftStart: number;
  leftCount: number;
  rightStart: number;
  rightCount: number;
  /** The rows after the header, with their first character (" ", "+", "-", "\"). */
  rows: string[];
}

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The hunks of a file's patch (GitHub's `patch`: hunks without the file header). */
export function parsePatch(patch: string | null | undefined): PatchHunk[] {
  const rows = (patch ?? "").replace(/\r\n?/g, "\n").split("\n");
  while (rows.length && rows[rows.length - 1] === "") rows.pop();
  const hunks: PatchHunk[] = [];
  for (const row of rows) {
    const h = HEADER.exec(row);
    if (h) {
      const leftCount = h[2] === undefined ? 1 : Number(h[2]);
      const rightCount = h[4] === undefined ? 1 : Number(h[4]);
      // An empty side's start is the line before it (`-0,0`, `+10,0`).
      hunks.push({
        leftStart: leftCount ? Number(h[1]) - 1 : Number(h[1]),
        leftCount,
        rightStart: rightCount ? Number(h[3]) - 1 : Number(h[3]),
        rightCount,
        rows: [],
      });
    } else hunks[hunks.length - 1]?.rows.push(row || " ");
  }
  return hunks;
}

/** A half-open line range `[start, end)`. */
export interface Span {
  start: number;
  end: number;
}

/** The commentable lines of each side (`patch.ranges`): the lines of every hunk, context included. */
export function commentableRanges(hunks: readonly PatchHunk[]): Record<Side, Span[]> {
  const out: Record<Side, Span[]> = { left: [], right: [] };
  for (const h of hunks) {
    if (h.leftCount) out.left.push({ start: h.leftStart, end: h.leftStart + h.leftCount });
    if (h.rightCount) out.right.push({ start: h.rightStart, end: h.rightStart + h.rightCount });
  }
  return out;
}

/**
 * The line of the other side matching `line` of `from` (`forcefullyMapLine`): outside the
 * hunks lines shift by what the hunks before added or removed; inside, context lines map
 * exactly and changed lines to the other side's line at that point.
 */
export function mapAcrossPatch(hunks: readonly PatchHunk[], from: Side, line: number): number {
  const mine = from === "left" ? "-" : "+";
  const theirs = from === "left" ? "+" : "-";
  let shift = 0;
  for (const h of hunks) {
    const [start, count, otherStart, otherCount] =
      from === "left"
        ? [h.leftStart, h.leftCount, h.rightStart, h.rightCount]
        : [h.rightStart, h.rightCount, h.leftStart, h.leftCount];
    if (line < start) break;
    if (line < start + count) {
      let here = start;
      let there = otherStart;
      for (const row of h.rows) {
        const c = row[0];
        if (c === "\\") continue;
        if (c === theirs) there++;
        else {
          if (here === line) return there;
          here++;
          if (c !== mine) there++;
        }
      }
      return there;
    }
    shift = otherStart + otherCount - (start + count);
  }
  return Math.max(0, line + shift);
}

/**
 * GitHub's diff "position" of `line` of `side` (`PatchHunkUtil.findDiffFileLineIndex`): the
 * row's index counted from the first hunk header (the row under it is 1, later headers
 * count too); null when the line is not in the patch.
 */
export function diffPosition(patch: string | null | undefined, side: Side, line: number): number | null {
  let position = 0;
  let started = false;
  let left = 0;
  let right = 0;
  for (const row of (patch ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const h = HEADER.exec(row);
    if (h) {
      if (started) position++;
      started = true;
      left = Number(h[1]) - 1;
      right = Number(h[3]) - 1;
      continue;
    }
    if (!started) continue;
    position++;
    const c = row[0] ?? " ";
    if (c === "\\") continue;
    if (c !== "+") {
      if (side === "left" && left === line) return position;
      left++;
    }
    if (c !== "-") {
      if (side === "right" && right === line) return position;
      right++;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Threads in a diff

/** A comment's place: the last line (where its inlay goes) and the first. */
export interface CommentLocation {
  side: Side;
  line: number;
  startSide: Side;
  startLine: number;
}

/** Which diff of the pull request is shown: the cumulative one, or one commit's (`commit`). */
export interface ReviewDiffKind {
  commit: string | null;
}

/**
 * Where `thread` sits in the diff (`mapThreadToChange`), or null when it can't be placed:
 * the cumulative diff places current threads at their `line` / `startLine`; a single commit's
 * diff places right-side threads made on that commit at their original lines (and those whose
 * current commit it is at their lines). Outdated threads have no place in the cumulative diff.
 */
export function threadLocation(thread: GHPullRequestReviewThread, diff: ReviewDiffKind): CommentLocation | null {
  if (thread.subjectType === "FILE") return null;
  const root = thread.comments.nodes[0];
  const side = fromGitHubSide(thread.diffSide);
  const at = (line: number | null, start: number | null): CommentLocation | null =>
    line == null
      ? null
      : {
          side,
          line: line - 1,
          startSide: start == null ? side : fromGitHubSide(thread.startDiffSide ?? thread.diffSide),
          startLine: (start ?? line) - 1,
        };
  if (diff.commit === null) return at(thread.line, thread.startLine);
  if (side !== "right") return null;
  if (root?.originalCommit?.oid === diff.commit) return at(thread.originalLine, thread.originalStartLine);
  if (root?.commit?.oid === diff.commit) return at(thread.line, thread.startLine);
  return null;
}

/** "Show Review Threads" (`DiscussionsViewOption`). */
export type ThreadsViewOption = "all" | "unresolved" | "none";

export const THREADS_VIEW_OPTIONS: ReadonlyArray<{ value: ThreadsViewOption; label: string }> = [
  { value: "all", label: "All" },
  { value: "unresolved", label: "Unresolved Only" },
  { value: "none", label: "Do Not Show" },
];

export function isThreadVisible(thread: Pick<GHPullRequestReviewThread, "isResolved">, option: ThreadsViewOption) {
  return option === "all" || (option === "unresolved" && !thread.isResolved);
}

// ---------------------------------------------------------------------------
// New comments

/** `createThreadDTO`: the GitHub input of a new comment on `path` at `loc`. */
export function draftThread(path: string, loc: CommentLocation, body: string): GHPullRequestDraftReviewThread {
  const single = loc.startSide === loc.side && loc.startLine === loc.line;
  return {
    body,
    path,
    line: loc.line + 1,
    side: toGitHubSide(loc.side),
    startLine: single ? null : loc.startLine + 1,
    startSide: single ? null : toGitHubSide(loc.startSide),
  };
}

/** The location of a new comment on the 0-based lines `start`..`end` of one side. */
export function newCommentLocation(side: Side, start: number, end: number): CommentLocation {
  return { side, line: Math.max(start, end), startSide: side, startLine: Math.min(start, end) };
}

export type SubmitAction = "startReview" | "singleComment" | "reviewComment";

/**
 * The new comment's buttons, the primary one first: with a pending review "Add Review Comment";
 * else "Start Review" and "Add Single Comment", the one used last first (`reviewCommentsPreferred`).
 */
export function submitActions(hasPendingReview: boolean, reviewPreferred: boolean): SubmitAction[] {
  if (hasPendingReview) return ["reviewComment"];
  return reviewPreferred ? ["startReview", "singleComment"] : ["singleComment", "startReview"];
}

export const SUBMIT_ACTION_TEXT: Record<SubmitAction, string> = {
  startReview: "Start Review",
  singleComment: "Add Single Comment",
  reviewComment: "Add Review Comment",
};

// ---------------------------------------------------------------------------
// Previous / Next Comment

/** A thread's place in the unified order (`UnifiedCodeReviewItemPosition`): file, then right, then left line. */
export interface ThreadPosition {
  id: string;
  /** Index of the file in the pull request's changes. */
  file: number;
  path: string;
  left: number;
  right: number;
  createdAt: string;
  /** Where navigation reveals it. */
  side: Side;
  line: number;
}

export function comparePositions(
  a: Pick<ThreadPosition, "file" | "left" | "right">,
  b: Pick<ThreadPosition, "file" | "left" | "right">,
) {
  return a.file - b.file || a.right - b.right || a.left - b.left;
}

/**
 * The threads of the cumulative diff in navigation order (`createSortedThreadPositionsAndIds`):
 * each thread's line is mapped to both sides with its file's patch.
 */
export function threadOrder(
  files: ReadonlyArray<{ path: string; hunks: readonly PatchHunk[] }>,
  threads: readonly GHPullRequestReviewThread[],
): ThreadPosition[] {
  const index = new Map(files.map((f, i) => [f.path, i]));
  const out: ThreadPosition[] = [];
  for (const t of threads) {
    const file = index.get(t.path);
    const loc = threadLocation(t, { commit: null });
    if (file === undefined || !loc) continue;
    const other = mapAcrossPatch(files[file]!.hunks, loc.side, loc.line);
    out.push({
      id: t.id,
      file,
      path: t.path,
      left: loc.side === "left" ? loc.line : other,
      right: loc.side === "right" ? loc.line : other,
      createdAt: t.comments.nodes[0]?.createdAt ?? "",
      side: loc.side,
      line: loc.line,
    });
  }
  return out.sort((a, b) => comparePositions(a, b) || a.createdAt.localeCompare(b.createdAt));
}

/**
 * The visible thread after (`dir` 1) or before (-1) the current one (`from.id`) or the caret
 * (`from` a position: the thread on the caret's line counts as next / previous).
 */
export function adjacentThread(
  order: readonly ThreadPosition[],
  from: { id: string } | Pick<ThreadPosition, "file" | "left" | "right">,
  dir: 1 | -1,
  visible: (id: string) => boolean = () => true,
): ThreadPosition | null {
  let i: number;
  if ("id" in from) {
    const at = order.findIndex((p) => p.id === from.id);
    if (at < 0) return null;
    i = at + dir;
  } else if (dir === 1) {
    i = order.findIndex((p) => comparePositions(p, from) >= 0);
    if (i < 0) return null;
  } else {
    i = order.length - 1;
    while (i >= 0 && comparePositions(order[i]!, from) > 0) i--;
  }
  for (; i >= 0 && i < order.length; i += dir) if (visible(order[i]!.id)) return order[i]!;
  return null;
}
