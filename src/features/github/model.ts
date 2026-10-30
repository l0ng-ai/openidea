/** Pure helpers of the Pull Requests view (labels, check summaries, review threads, diff inputs). */
import type {
  ChangedFile,
  GhRepo,
  PrCheck,
  PrDiffRevisions,
  PrFile,
  PrReviewComment,
  PullRequestDetails,
  PullRequestSummary,
} from "@/platform/ipc";
import { t, tx } from "@/platform/i18n";

/** Keyed, not source text: "Open" as a state reads differently from the "Open" action in some locales. */
export function stateLabel(pr: PullRequestSummary): string {
  if (pr.state === "merged") return t("github.prState.merged");
  if (pr.state === "closed") return t("github.prState.closed");
  return pr.isDraft ? t("github.prState.draft") : t("github.prState.open");
}

export function reviewDecisionLabel(decision: string | null): string | null {
  switch (decision) {
    case "APPROVED":
      return tx("Approved");
    case "CHANGES_REQUESTED":
      return tx("Changes requested");
    case "REVIEW_REQUIRED":
      return tx("Review required");
    default:
      return null;
  }
}

export function reviewStateLabel(state: string): string {
  switch (state) {
    case "APPROVED":
      return tx("approved");
    case "CHANGES_REQUESTED":
      return tx("requested changes");
    case "COMMENTED":
      return tx("reviewed");
    case "DISMISSED":
      return tx("review dismissed");
    case "REQUESTED":
      return tx("review requested");
    default:
      return state.toLowerCase().replace(/_/g, " ");
  }
}

export interface ChecksSummary {
  failed: number;
  pending: number;
  passed: number;
  /** Skipped / neutral / cancelled. */
  other: number;
}

export function checksSummary(checks: readonly PrCheck[]): ChecksSummary {
  const s: ChecksSummary = { failed: 0, pending: 0, passed: 0, other: 0 };
  for (const c of checks) {
    if (c.status === "failure") s.failed++;
    else if (c.status === "pending") s.pending++;
    else if (c.status === "success") s.passed++;
    else s.other++;
  }
  return s;
}

export function checksText(s: ChecksSummary): string {
  const parts: string[] = [];
  if (s.failed) parts.push(tx`${s.failed} failing`);
  if (s.pending) parts.push(tx`${s.pending} pending`);
  if (s.passed) parts.push(tx`${s.passed} passed`);
  if (s.other) parts.push(tx`${s.other} skipped`);
  return parts.length ? parts.join(", ") : tx`No checks`;
}

/** "3 minutes ago"-style text for an ISO date. */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  const units: Array<[number, (n: number) => string]> = [
    [60 * 60 * 24 * 365, (n) => (n === 1 ? tx`${n} year ago` : tx`${n} years ago`)],
    [60 * 60 * 24 * 30, (n) => (n === 1 ? tx`${n} month ago` : tx`${n} months ago`)],
    [60 * 60 * 24, (n) => (n === 1 ? tx`${n} day ago` : tx`${n} days ago`)],
    [60 * 60, (n) => (n === 1 ? tx`${n} hour ago` : tx`${n} hours ago`)],
    [60, (n) => (n === 1 ? tx`${n} minute ago` : tx`${n} minutes ago`)],
  ];
  for (const [size, text] of units) {
    const n = Math.floor(s / size);
    if (n >= 1) return text(n);
  }
  return tx("just now");
}

export interface ReviewThread {
  root: PrReviewComment;
  replies: PrReviewComment[];
}

/** Groups inline comments into threads (replies under their root), roots in file / line order. */
export function reviewThreads(comments: readonly PrReviewComment[]): ReviewThread[] {
  const byId = new Map<number, ReviewThread>();
  const threads: ReviewThread[] = [];
  for (const c of comments) {
    const parent = c.inReplyTo != null ? byId.get(c.inReplyTo) : undefined;
    if (parent) {
      parent.replies.push(c);
      byId.set(c.id, parent);
    } else {
      const t = { root: c, replies: [] };
      threads.push(t);
      byId.set(c.id, t);
    }
  }
  return threads.sort(
    (a, b) =>
      a.root.path.localeCompare(b.root.path) ||
      (a.root.line ?? a.root.originalLine ?? 0) - (b.root.line ?? b.root.originalLine ?? 0),
  );
}

/** Annotation shape of the diff viewer (`vcs.openDiff` → DiffData.annotations). */
export interface DiffNote {
  side: "left" | "right";
  line: number;
  author: string;
  body: string;
  date?: string;
}

/** Current (not outdated) review comments of `path`, as diff notes. */
export function diffNotes(path: string, comments: readonly PrReviewComment[]): DiffNote[] {
  return comments
    .filter((c) => c.path === path && c.line != null)
    .map((c) => ({
      side: c.side === "LEFT" ? "left" : "right",
      line: c.line! - 1,
      author: c.author,
      body: c.body,
      date: c.createdAt,
    }));
}

type Side = { type: "rev"; rev: string; path?: string; label?: string } | { type: "text"; text: string; label: string };

/** `DiffData` for one changed file of a pull request (merge base ↔ head), with its review comments. */
export function fileDiffData(
  pr: PullRequestDetails,
  file: PrFile,
  revs: PrDiffRevisions,
  comments: readonly PrReviewComment[],
) {
  const root = revs.root;
  const changed: ChangedFile | undefined = revs.files.find((f) => f.path === file.path);
  const added = file.changeType === "ADDED" || changed?.kind === "added";
  const deleted = file.changeType === "DELETED" || changed?.kind === "deleted";
  const n = pr.summary.number;
  const left: Side = added
    ? { type: "text", text: "", label: "(does not exist)" }
    : {
        type: "rev",
        rev: revs.base,
        path: changed?.oldPath ? `${root}/${changed.oldPath}` : undefined,
        label: `${pr.summary.baseRef} (${revs.base.slice(0, 8)})`,
      };
  const right: Side = deleted
    ? { type: "text", text: "", label: "(deleted)" }
    : { type: "rev", rev: revs.head, label: `#${n} ${pr.summary.headRef}` };
  const name = file.path.slice(file.path.lastIndexOf("/") + 1);
  return {
    path: `${root}/${file.path}`,
    left,
    right,
    title: `#${n}: ${name}`,
    annotations: diffNotes(file.path, comments),
  };
}

const CAN_WRITE = new Set(["ADMIN", "MAINTAIN", "WRITE"]);
const CAN_TRIAGE = new Set([...CAN_WRITE, "TRIAGE"]);
/** Merge box states GitHub lets anyone with write access merge in (IDEA's `canMerge`). */
const MERGEABLE_STATES = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);
/** States an administrator can still merge in, bypassing the requirements. */
const ADMIN_STATES = new Set(["BEHIND", "BLOCKED"]);

/** Which pull request actions apply, as IDEA's review flow decides them. */
export interface PrActions {
  merge: boolean;
  squash: boolean;
  rebase: boolean;
  /** Merging needs administrator privileges (`gh pr merge --admin`). */
  asAdmin: boolean;
  close: boolean;
  reopen: boolean;
  ready: boolean;
  requestReview: boolean;
  setMyselfAsReviewer: boolean;
}

/**
 * Actions of `pr` for the signed-in `login` in `repo`. An unknown permission is not held
 * against the user: gh reports what GitHub refuses.
 */
export function prActions(pr: PullRequestDetails, repo: GhRepo, login: string | null): PrActions {
  const s = pr.summary;
  const open = s.state === "open";
  const perm = repo.viewerPermission;
  const isAuthor = !!login && login === s.author;
  const canManage = !perm || CAN_TRIAGE.has(perm) || isAuthor;
  const canWrite = !perm || CAN_WRITE.has(perm);
  const asAdmin = perm === "ADMIN" && ADMIN_STATES.has(pr.mergeStateStatus);
  const canBeMerged = open && canWrite && (MERGEABLE_STATES.has(pr.mergeStateStatus) || asAdmin);
  return {
    merge: canBeMerged && repo.mergeCommitAllowed,
    squash: canBeMerged && repo.squashMergeAllowed,
    rebase: canBeMerged && repo.rebaseMergeAllowed && pr.mergeable === "MERGEABLE",
    asAdmin,
    close: open && canManage,
    reopen: s.state === "closed" && canManage,
    ready: open && s.isDraft && canManage,
    requestReview: open && canManage,
    setMyselfAsReviewer: open && !!login && !isAuthor && !pr.reviewers.some((r) => r.login === login),
  };
}

/** Default merge commit message: GitHub's subject, IDEA's body (the title; the commit list when squashing). */
export function mergeMessage(pr: PullRequestDetails, squash: boolean): { subject: string; body: string } {
  const s = pr.summary;
  if (squash)
    return {
      subject: `${s.title} (#${s.number})`,
      body: pr.commits.map((c) => `* ${c.headline}`).join("\n\n"),
    };
  return { subject: `Merge pull request #${s.number} from ${s.headRef}`, body: s.title };
}

export interface StatusLine {
  status: "success" | "failure" | "pending" | "warning";
  text: string;
}

/** The merge box of the details: checks, conflicts and reviews, as IDEA shows them under the changes. */
export function statusLines(pr: PullRequestDetails): StatusLine[] {
  const lines: StatusLine[] = [];
  if (pr.summary.state !== "open") return lines;
  if (pr.summary.isDraft) lines.push({ status: "warning", text: tx("This pull request is still a draft") });
  const c = checksSummary(pr.checks);
  if (c.failed) lines.push({ status: "failure", text: checksText(c) });
  else if (c.pending) lines.push({ status: "pending", text: checksText(c) });
  else if (c.passed) lines.push({ status: "success", text: tx("All checks have passed") });
  if (pr.mergeable === "CONFLICTING")
    lines.push({ status: "failure", text: tx("This branch has conflicts that must be resolved") });
  else if (pr.mergeStateStatus === "BEHIND")
    lines.push({ status: "warning", text: tx("This branch is out of date with the base branch") });
  const by = (state: string) =>
    pr.reviewers
      .filter((r) => r.state === state)
      .map((r) => r.login)
      .join(", ");
  const changes = by("CHANGES_REQUESTED");
  if (changes) lines.push({ status: "failure", text: tx`Changes requested by ${changes}` });
  const approved = by("APPROVED");
  if (approved) lines.push({ status: "success", text: tx`Approved by ${approved}` });
  const waiting = by("REQUESTED");
  if (waiting) lines.push({ status: "warning", text: tx`Waiting for review from ${waiting}` });
  if (!pr.reviewers.length && pr.summary.reviewDecision === "REVIEW_REQUIRED")
    lines.push({ status: "warning", text: tx("Review required") });
  if (pr.mergeStateStatus === "BLOCKED" && !changes && !c.failed)
    lines.push({ status: "warning", text: tx("Merging is blocked") });
  return lines;
}
