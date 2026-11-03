/**
 * Pure rules of the timeline, ported from IntelliJ: merging the raw timeline items
 * (`GHPRTimelineMergingModel`, `GHPRTimelineMergedSimpleEvents`, `…StateEvents`), review
 * statuses (`GHPRTimelineItemComponentFactory.createReviewStatus`), the thread's diff hunk
 * with its anchor (`GHPRTimelineThreadViewModel.calcDiffWithAnchor`, `PatchHunkUtil`),
 * suggested changes (`GHPRReviewCommentBodyViewModel`, `GHSuggestedChange`), reactions
 * (`GHReactionsViewModel`) and the @mention completion of the comment editor.
 */
import type {
  GHActor,
  GHIssueComment,
  GHLabel,
  GHPRTimelineItem,
  GHPullRequestRequestedReviewer,
  GHPullRequestReview,
  GHPullRequestReviewState,
  GHPullRequestReviewThread,
  GHPullRequestState,
  GHReaction,
  GHReactionContent,
  GHUser,
} from "../api/types";
import { isTeam, reviewerKey } from "../data/model";

// ---------------------------------------------------------------------------
// Merging (`GHPRTimelineMergingModel`)

/** Events from one actor within this time are shown as one item. */
export const MERGE_THRESHOLD_MS = 2 * 60_000;

type Item<T extends GHPRTimelineItem["__typename"]> = Extract<GHPRTimelineItem, { __typename: T }>;

export type TimelineCommit = Item<"PullRequestCommit">;

/** `GHPRTimelineEvent.Simple`: labels, assignees, review requests, title. */
type SimpleEvent = Item<
  | "LabeledEvent"
  | "UnlabeledEvent"
  | "AssignedEvent"
  | "UnassignedEvent"
  | "ReviewRequestedEvent"
  | "ReviewRequestRemovedEvent"
  | "RenamedTitleEvent"
>;
/** `GHPRTimelineEvent.State`. */
export type StateEvent = Item<"ClosedEvent" | "ReopenedEvent" | "MergedEvent">;
/** `GHPRTimelineEvent.Branch` and `.Complex`: never merged. */
export type ComplexEvent = Item<
  | "BaseRefChangedEvent"
  | "BaseRefForcePushedEvent"
  | "HeadRefForcePushedEvent"
  | "HeadRefDeletedEvent"
  | "HeadRefRestoredEvent"
  | "ReviewDismissedEvent"
  | "ReadyForReviewEvent"
  | "ConvertToDraftEvent"
  | "CrossReferencedEvent"
  | "ConnectedEvent"
  | "DisconnectedEvent"
>;

/** Merged simple events (one event is a group of one): what changed overall. */
export interface SimpleGroup {
  kind: "simple";
  key: string;
  actor: GHActor | null;
  createdAt: string;
  /** Raw events in the group. */
  count: number;
  addedLabels: GHLabel[];
  removedLabels: GHLabel[];
  assigned: GHUser[];
  unassigned: GHUser[];
  addedReviewers: Array<GHPullRequestRequestedReviewer | null>;
  removedReviewers: Array<GHPullRequestRequestedReviewer | null>;
  /** [from, to]; with several events only when the title really changed. */
  rename: [string, string] | null;
}

/** Merged state events: the resulting state and the event that set it. */
export interface StateGroup {
  kind: "state";
  key: string;
  actor: GHActor | null;
  createdAt: string;
  count: number;
  newState: GHPullRequestState;
  /** The event that set `newState` (a merge stays the last state). */
  last: StateEvent;
  inferredOriginalState: GHPullRequestState;
}

export type TimelineEntry =
  | { kind: "commits"; key: string; commits: TimelineCommit[] }
  | { kind: "comment"; key: string; comment: GHIssueComment }
  | { kind: "review"; key: string; review: GHPullRequestReview }
  | { kind: "event"; key: string; event: ComplexEvent }
  | SimpleGroup
  | StateGroup
  | { kind: "unknown"; key: string; type: string };

const SIMPLE = new Set<string>([
  "LabeledEvent",
  "UnlabeledEvent",
  "AssignedEvent",
  "UnassignedEvent",
  "ReviewRequestedEvent",
  "ReviewRequestRemovedEvent",
  "RenamedTitleEvent",
]);
const STATE = new Set<string>(["ClosedEvent", "ReopenedEvent", "MergedEvent"]);

const isSimple = (i: GHPRTimelineItem): i is SimpleEvent => SIMPLE.has(i.__typename);
const isState = (i: GHPRTimelineItem): i is StateEvent => STATE.has(i.__typename);

export function stateOf(e: StateEvent): GHPullRequestState {
  return e.__typename === "ClosedEvent" ? "CLOSED" : e.__typename === "MergedEvent" ? "MERGED" : "OPEN";
}

const actorKey = (a: GHActor | null) => (a ? a.login : null);
const labelKey = (l: GHLabel) => l.id || l.name;
const userKey = (u: GHUser) => u.id || u.login;
const reviewerKeyOrNull = (r: GHPullRequestRequestedReviewer | null) => (r ? reviewerKey(r) : "ghost");

/** Adds `item` unless the opposite list holds it (which then loses it): a label added and removed is no change. */
function toggleIn<T>(add: T[], remove: T[], item: T, key: (t: T) => string) {
  const i = remove.findIndex((r) => key(r) === key(item));
  if (i >= 0) remove.splice(i, 1);
  else if (!add.some((a) => key(a) === key(item))) add.push(item);
}

function addSimple(g: SimpleGroup, e: SimpleEvent) {
  switch (e.__typename) {
    case "LabeledEvent":
      return toggleIn(g.addedLabels, g.removedLabels, e.label, labelKey);
    case "UnlabeledEvent":
      return toggleIn(g.removedLabels, g.addedLabels, e.label, labelKey);
    case "AssignedEvent":
      return e.user && toggleIn(g.assigned, g.unassigned, e.user, userKey);
    case "UnassignedEvent":
      return e.user && toggleIn(g.unassigned, g.assigned, e.user, userKey);
    case "ReviewRequestedEvent":
      return toggleIn(g.addedReviewers, g.removedReviewers, e.requestedReviewer, reviewerKeyOrNull);
    case "ReviewRequestRemovedEvent":
      return toggleIn(g.removedReviewers, g.addedReviewers, e.requestedReviewer, reviewerKeyOrNull);
    case "RenamedTitleEvent":
      g.rename = [g.rename?.[0] ?? e.previousTitle, e.currentTitle];
  }
}

function simpleGroup(e: SimpleEvent, key: string): SimpleGroup {
  const g: SimpleGroup = {
    kind: "simple",
    key,
    actor: e.actor,
    createdAt: e.createdAt,
    count: 1,
    addedLabels: [],
    removedLabels: [],
    assigned: [],
    unassigned: [],
    addedReviewers: [],
    removedReviewers: [],
    rename: null,
  };
  addSimple(g, e);
  return g;
}

function stateGroup(e: StateEvent, key: string): StateGroup {
  const s = stateOf(e);
  return {
    kind: "state",
    key,
    actor: e.actor,
    createdAt: e.createdAt,
    count: 1,
    newState: s,
    last: e,
    inferredOriginalState: s === "OPEN" ? "CLOSED" : "OPEN",
  };
}

const later = (a: string, b: string) => (Date.parse(b) > Date.parse(a) ? b : a);

/** `GHPRTimelineMergedSimpleEvents.hasAnyChanges`. */
export function simpleHasChanges(g: SimpleGroup): boolean {
  return (
    g.addedLabels.length > 0 ||
    g.removedLabels.length > 0 ||
    g.assigned.length > 0 ||
    g.unassigned.length > 0 ||
    g.addedReviewers.length > 0 ||
    g.removedReviewers.length > 0 ||
    effectiveRename(g) !== null
  );
}

/** The rename to show: a single event always, a merged one only when the title changed. */
export function effectiveRename(g: SimpleGroup): [string, string] | null {
  if (!g.rename) return null;
  return g.count === 1 || g.rename[0] !== g.rename[1] ? g.rename : null;
}

/** Merged groups that change nothing (assigned and unassigned again, closed and reopened) are dropped. */
function isCollapsedMerge(e: TimelineEntry): boolean {
  if (e.kind === "simple") return e.count > 1 && !simpleHasChanges(e);
  if (e.kind === "state") return e.count > 1 && e.newState === e.inferredOriginalState;
  return false;
}

function withinThreshold(prev: { actor: GHActor | null; createdAt: string }, e: { createdAt: string }) {
  return Date.parse(e.createdAt) - Date.parse(prev.createdAt) <= MERGE_THRESHOLD_MS;
}

/**
 * The items as the timeline shows them: consecutive commits grouped, simple and state
 * events of one actor within `MERGE_THRESHOLD_MS` of the previous one merged, merges
 * that change nothing dropped. Unknown types are kept only with `showUnknown` (IntelliJ
 * shows them in internal / EAP builds); the API layer already drops the ignored types.
 */
export function mergeTimeline(items: readonly GHPRTimelineItem[], showUnknown = false): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  let last: TimelineEntry | null = null;
  const push = (e: TimelineEntry | null) => {
    if (e && !isCollapsedMerge(e)) out.push(e);
  };
  items.forEach((item, index) => {
    const key = `${index}`;
    if (item.__typename === "Unknown") {
      if (!showUnknown) return;
      push(last);
      last = { kind: "unknown", key: `unknown:${key}`, type: item.type };
      return;
    }
    if (item.__typename === "PullRequestCommit") {
      if (last?.kind === "commits") last.commits.push(item);
      else {
        push(last);
        last = { kind: "commits", key: `commits:${item.id}`, commits: [item] };
      }
      return;
    }
    if (isSimple(item)) {
      if (last?.kind === "simple" && actorKey(last.actor) === actorKey(item.actor) && withinThreshold(last, item)) {
        last.count++;
        last.actor = item.actor;
        last.createdAt = later(last.createdAt, item.createdAt);
        addSimple(last, item);
      } else {
        push(last);
        last = simpleGroup(item, `simple:${key}`);
      }
      return;
    }
    if (isState(item)) {
      if (last?.kind === "state" && actorKey(last.actor) === actorKey(item.actor) && withinThreshold(last, item)) {
        last.count++;
        last.actor = item.actor;
        last.createdAt = later(last.createdAt, item.createdAt);
        if (last.newState !== "MERGED") {
          last.newState = stateOf(item);
          last.last = item;
        }
      } else {
        push(last);
        last = stateGroup(item, `state:${key}`);
      }
      return;
    }
    push(last);
    if (item.__typename === "IssueComment") last = { kind: "comment", key: `comment:${item.id}`, comment: item };
    else if (item.__typename === "PullRequestReview") last = { kind: "review", key: `review:${item.id}`, review: item };
    else last = { kind: "event", key: `event:${key}`, event: item };
  });
  push(last);
  return out;
}

/** The actor an item is shown with (`event.actor ?: ghostUser`); commits: their author's user. */
export function commitsActor(commits: readonly TimelineCommit[], prAuthor: GHActor | null): GHActor | null {
  return commits.length === 1 ? (commits[0]!.commit.author?.user ?? prAuthor) : prAuthor;
}

// ---------------------------------------------------------------------------
// Reviews

export type StatusType = "INFO" | "SECONDARY_INFO" | "SUCCESS" | "ERROR" | "WARNING";

/** The review's status line: text and colour. */
export function reviewStatus(state: GHPullRequestReviewState): { text: string; type: StatusType } {
  switch (state) {
    case "APPROVED":
      return { text: "approved the changes", type: "SUCCESS" };
    case "CHANGES_REQUESTED":
      return { text: "requested changes", type: "ERROR" };
    case "PENDING":
      return { text: "started a review", type: "SECONDARY_INFO" };
    default:
      return { text: "reviewed the changes", type: "INFO" };
  }
}

/** The review a thread belongs to (its first comment's review). */
export const threadReviewId = (t: GHPullRequestReviewThread) => t.comments.nodes[0]?.pullRequestReview?.id ?? null;

/** `canEdit` of a review: GitHub fails to edit reviews created with an empty body. */
export const canEditReview = (r: GHPullRequestReview) => r.viewerCanUpdate && r.body.length > 0;

/** `getPresentableName`: users' and bots' name, else the login. */
export function presentableName(a: GHActor | GHPullRequestRequestedReviewer | null | undefined): string {
  if (!a) return "ghost";
  if (isTeam(a)) return a.teamName || a.slug;
  return (a as GHActor).name || (a as GHActor).login;
}

// ---------------------------------------------------------------------------
// Diff hunks (`PatchHunk`)

export type HunkLineType = "CONTEXT" | "ADD" | "REMOVE";

export interface HunkLine {
  type: HunkLineType;
  text: string;
}

/** A unified diff hunk; start lines are 0-based. */
export interface PatchHunk {
  startLineBefore: number;
  startLineAfter: number;
  lines: HunkLine[];
}

/** Parses GitHub's `diffHunk` (`@@ -a,b +c,d @@ …` then the lines); null when it has none. */
export function parsePatchHunk(diffHunk: string): PatchHunk | null {
  if (!diffHunk.trim()) return null;
  const rows = diffHunk.replace(/\r\n?/g, "\n").split("\n");
  if (rows.length > 1 && rows[rows.length - 1] === "") rows.pop();
  const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rows[0] ?? "");
  if (!header) return null;
  const lines: HunkLine[] = [];
  for (const row of rows.slice(1)) {
    if (row.startsWith("\\")) continue;
    const c = row[0];
    if (c === "+") lines.push({ type: "ADD", text: row.slice(1) });
    else if (c === "-") lines.push({ type: "REMOVE", text: row.slice(1) });
    else if (c === " " || row === "") lines.push({ type: "CONTEXT", text: row.slice(1) });
  }
  return {
    startLineBefore: Math.max(0, Number(header[1]) - 1),
    startLineAfter: Math.max(0, Number(header[2]) - 1),
    lines,
  };
}

/** `PatchHunkUtil.truncateHunkBefore`: drops the lines before index `start`, moving the start lines. */
export function truncateHunkBefore(hunk: PatchHunk, start: number): PatchHunk {
  if (start <= 0) return hunk;
  const dropped = hunk.lines.slice(0, start);
  const before = dropped.filter((l) => l.type !== "ADD").length;
  const after = dropped.filter((l) => l.type !== "REMOVE").length;
  return {
    startLineBefore: hunk.startLineBefore + before,
    startLineAfter: hunk.startLineAfter + after,
    lines: hunk.lines.slice(start),
  };
}

/** Lines of the timeline's thread diffs around the anchor (`TimelineDiffComponentFactory.DIFF_CONTEXT_SIZE`). */
export const DIFF_CONTEXT_SIZE = 3;

/**
 * The thread's diff (the end of its hunk, where GitHub anchors the comment) and the
 * anchor line range in it (`[start, end)` indexes), as `calcDiffWithAnchor`; null when
 * the hunk is empty (file comments, some outdated threads).
 */
export function threadDiffWithAnchor(
  thread: Pick<GHPullRequestReviewThread, "diffSide" | "originalLine" | "startDiffSide" | "originalStartLine"> & {
    diffHunk: string;
  },
): { hunk: PatchHunk; anchor: [number, number] } | null {
  const hunk = parsePatchHunk(thread.diffHunk);
  if (!hunk || !hunk.lines.length) return null;
  const anchor = thread.originalLine != null ? { side: thread.diffSide, line: thread.originalLine - 1 } : null;
  const startAnchor =
    thread.startDiffSide && thread.originalStartLine != null
      ? {
          side: thread.startDiffSide,
          line: Math.max(
            thread.originalStartLine - 1,
            thread.startDiffSide === "LEFT" ? hunk.startLineBefore : hunk.startLineAfter,
          ),
        }
      : null;
  const anchorLength =
    startAnchor?.side === anchor?.side ? Math.max(0, (anchor?.line ?? 0) - (startAnchor?.line ?? 0)) : 0;
  const truncated = truncateHunkBefore(hunk, hunk.lines.length - 1 - (anchorLength + DIFF_CONTEXT_SIZE));
  return { hunk: truncated, anchor: [truncated.lines.length - 1 - anchorLength, truncated.lines.length] };
}

/** The diff hunk of a thread (its first comment's). */
export const threadDiffHunk = (t: GHPullRequestReviewThread) => t.comments.nodes[0]?.diffHunk ?? "";

/** Line numbers (1-based) of each hunk line on both sides; null where the line does not exist on that side. */
export function hunkLineNumbers(hunk: PatchHunk): Array<[number | null, number | null]> {
  let before = hunk.startLineBefore;
  let after = hunk.startLineAfter;
  return hunk.lines.map((l) => {
    if (l.type === "ADD") return [null, ++after];
    if (l.type === "REMOVE") return [++before, null];
    return [++before, ++after];
  });
}

// ---------------------------------------------------------------------------
// Suggested changes

export const SUGGESTION_BLOCK_START = "```suggestion";
const SUGGESTION_BLOCK_END = "```";

/**
 * Whether a comment holds a suggested change (its range cannot be adjusted in the diff).
 * @public
 */
export const containsSuggestedChange = (markdown: string) =>
  markdown.split(/\r?\n/).some((l) => l.startsWith(SUGGESTION_BLOCK_START));

export type BodyBlock = { type: "markdown"; text: string } | { type: "suggestion"; lines: string[] };

/**
 * A comment body split into Markdown and ```` ```suggestion ```` blocks (`getSuggestions`:
 * a block starts with a line starting with the fence and ends at the next line ending with
 * ```` ``` ````). An unterminated block stays Markdown.
 */
export function splitSuggestions(body: string): BodyBlock[] {
  const rows = body.replace(/\r\n?/g, "\n").split("\n");
  const out: BodyBlock[] = [];
  let text: string[] = [];
  let block: string[] | null = null;
  let opening = "";
  const flushText = () => {
    if (text.join("\n").trim()) out.push({ type: "markdown", text: text.join("\n") });
    text = [];
  };
  for (const row of rows) {
    if (block === null && row.startsWith(SUGGESTION_BLOCK_START)) {
      block = [];
      opening = row;
      continue;
    }
    if (block !== null && row.endsWith(SUGGESTION_BLOCK_END)) {
      flushText();
      out.push({ type: "suggestion", lines: block });
      block = null;
      continue;
    }
    if (block !== null) block.push(row);
    else text.push(row);
  }
  if (block !== null) text.push(opening, ...block);
  flushText();
  return out;
}

export type SuggestionApplicability = "APPLICABLE" | "RESOLVED" | "OUTDATED";

/** Where a suggestion applies: 0-based line indexes of the current and original code. */
export interface SuggestionTarget {
  path: string;
  applicability: SuggestionApplicability;
  /** The current lines (`line` / `startLine`), null when outdated. */
  startLineIndex: number | null;
  endLineIndex: number | null;
  /** The commented code as the diff hunk shows it (its RIGHT side). */
  originalLines: string[];
}

/** The lines the thread comments on and whether a suggestion in it can be applied. */
export function suggestionTarget(
  thread: Pick<
    GHPullRequestReviewThread,
    "isResolved" | "path" | "line" | "startLine" | "originalLine" | "originalStartLine"
  > & { diffHunk: string },
): SuggestionTarget {
  const originalEnd = thread.originalLine != null ? thread.originalLine - 1 : null;
  const originalStart = thread.originalStartLine != null ? thread.originalStartLine - 1 : originalEnd;
  const end = thread.line != null ? thread.line - 1 : null;
  const start = thread.startLine != null ? thread.startLine - 1 : end;
  const hunk = parsePatchHunk(thread.diffHunk);
  let originalLines: string[] = [];
  if (hunk) {
    if (originalStart != null && originalEnd != null) {
      const numbers = hunkLineNumbers(hunk);
      originalLines = hunk.lines
        .filter((l, i) => {
          const n = numbers[i]![1];
          return l.type !== "REMOVE" && n != null && n - 1 >= originalStart && n - 1 <= originalEnd;
        })
        .map((l) => l.text);
    } else {
      originalLines = hunk.lines
        .filter((l) => l.type !== "REMOVE")
        .slice(-1)
        .map((l) => l.text);
    }
  }
  const applicability: SuggestionApplicability = thread.isResolved
    ? "RESOLVED"
    : originalStart == null || originalEnd == null || start == null || end == null
      ? "OUTDATED"
      : "APPLICABLE";
  return { path: thread.path, applicability, startLineIndex: start, endLineIndex: end, originalLines };
}

/** The disabled tooltip of "Apply Locally" (null: it can be applied). */
export function suggestionDisabledReason(
  applicability: SuggestionApplicability,
  onReviewBranch: boolean,
): string | null {
  if (!onReviewBranch) return "Unable to apply the suggested change from a pull request in a different branch";
  if (applicability === "RESOLVED") return "This suggestion has been resolved";
  if (applicability === "OUTDATED") return "Outdated suggestions cannot be applied";
  return null;
}

/**
 * A git patch replacing the target lines of `text` (the local file) with `suggestion`,
 * with up to 3 lines of context, and where the new lines are (0-based start, count). The
 * lines are looked up at the thread's line first, then at the nearest place holding the
 * same code; throws when the file no longer has them.
 */
export function buildSuggestionPatch(
  text: string,
  target: SuggestionTarget,
  suggestion: readonly string[],
): { patch: string; start: number; lines: number } {
  if (target.startLineIndex == null) throw new Error("Outdated suggestions cannot be applied");
  const crlf = text.includes("\r\n");
  // Lines keep their "\r" so that the patch matches CRLF files.
  const lines = text.split("\n");
  const trailingNewline = lines[lines.length - 1] === "";
  if (trailingNewline) lines.pop();
  const bare = (l: string) => l.replace(/\r$/, "");
  const original = target.originalLines;
  const matchesAt = (at: number) =>
    at >= 0 && at + original.length <= lines.length && original.every((l, i) => bare(lines[at + i]!) === l);
  let at = -1;
  const wanted = target.startLineIndex;
  for (let d = 0; original.length && d <= lines.length + wanted && at < 0; d++) {
    if (matchesAt(wanted - d)) at = wanted - d;
    else if (d > 0 && matchesAt(wanted + d)) at = wanted + d;
  }
  if (at < 0) throw new Error(`${target.path}: the suggested change does not apply`);
  const ctxStart = Math.max(0, at - 3);
  const ctxEnd = Math.min(lines.length, at + original.length + 3);
  const before = lines.slice(ctxStart, at);
  const removed = lines.slice(at, at + original.length);
  const after = lines.slice(at + original.length, ctxEnd);
  const oldCount = before.length + removed.length + after.length;
  const newCount = before.length + suggestion.length + after.length;
  const body = [
    ...before.map((l) => ` ${l}`),
    ...removed.map((l) => `-${l}`),
    ...suggestion.map((l) => `+${l}${crlf ? "\r" : ""}`),
    ...after.map((l) => ` ${l}`),
  ];
  if (ctxEnd === lines.length && !trailingNewline) body.push("\\ No newline at end of file");
  const range = (n: number) => `${n ? ctxStart + 1 : ctxStart},${n}`;
  const header = `@@ -${range(oldCount)} +${range(newCount)} @@`;
  const patch = [`--- a/${target.path}`, `+++ b/${target.path}`, header, ...body].join("\n") + "\n";
  return { patch, start: at, lines: suggestion.length };
}

// ---------------------------------------------------------------------------
// Reactions

/** GitHub's reactions, in its order, with the emoji and name (`presentableName`). */
export const REACTIONS: ReadonlyArray<{ content: GHReactionContent; emoji: string; name: string }> = [
  { content: "THUMBS_UP", emoji: "👍", name: "thumbs up" },
  { content: "THUMBS_DOWN", emoji: "👎", name: "thumbs down" },
  { content: "LAUGH", emoji: "😄", name: "laugh" },
  { content: "HOORAY", emoji: "🎉", name: "hooray" },
  { content: "CONFUSED", emoji: "😕", name: "confused" },
  { content: "HEART", emoji: "❤️", name: "heart" },
  { content: "ROCKET", emoji: "🚀", name: "rocket" },
  { content: "EYES", emoji: "👀", name: "eyes" },
];

export interface ReactionInfo {
  content: GHReactionContent;
  users: GHUser[];
  isReactedByCurrentUser: boolean;
}

/** `reactionsWithInfo`: reactions grouped by content, in order of first appearance. */
export function groupReactions(
  reactions: readonly GHReaction[],
  currentUserId: string | null | undefined,
): ReactionInfo[] {
  const map = new Map<GHReactionContent, ReactionInfo>();
  for (const r of reactions) {
    const info = map.get(r.content) ?? { content: r.content, users: [], isReactedByCurrentUser: false };
    if (r.user) {
      info.users.push(r.user);
      if (currentUserId && r.user.id === currentUserId) info.isReactedByCurrentUser = true;
    }
    map.set(r.content, info);
  }
  return [...map.values()];
}

/** The viewer's reaction toggled locally (optimistic update before the reload). */
export function toggleReactionLocally(
  reactions: readonly GHReaction[],
  content: GHReactionContent,
  me: GHUser,
  add: boolean,
): GHReaction[] {
  return add
    ? [...reactions, { content, user: me }]
    : reactions.filter((r) => !(r.content === content && r.user?.id === me.id));
}

// ---------------------------------------------------------------------------
// @mentions

/** The `@query` being typed before the caret, with where it starts; null when not in a mention. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|[^\w`])@([\w-]*)$/.exec(before);
  if (!m) return null;
  return { start: caret - m[2]!.length - 1, query: m[2]! };
}

/** Users matching `query` (login or name, prefixes first), at most `limit`. */
export function filterMentions<U extends Pick<GHUser, "login" | "name">>(
  users: readonly U[],
  query: string,
  limit = 10,
) {
  const q = query.toLowerCase();
  const scored: Array<{ u: U; score: number }> = [];
  for (const u of users) {
    const login = u.login.toLowerCase();
    const name = (u.name ?? "").toLowerCase();
    const score = !q
      ? 2
      : login.startsWith(q)
        ? 0
        : name.split(/\s+/).some((w) => w.startsWith(q))
          ? 1
          : login.includes(q) || name.includes(q)
            ? 2
            : -1;
    if (score >= 0) scored.push({ u, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.u.login.localeCompare(b.u.login))
    .slice(0, limit)
    .map((s) => s.u);
}

/** `text` with the mention at `start…caret` replaced by `@login `; the new caret. */
export function insertMention(
  text: string,
  start: number,
  caret: number,
  login: string,
): { text: string; caret: number } {
  const insert = `@${login} `;
  return { text: text.slice(0, start) + insert + text.slice(caret), caret: start + insert.length };
}
