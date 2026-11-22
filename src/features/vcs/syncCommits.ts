/**
 * Commits behind the branch widget's incoming / outgoing markers: which sections a branch
 * has, the git range each one lists, and how a log row reads (short hash, shortened subject).
 */
import type { Commit, OutgoingCommits } from "@/bindings";

export type SyncDirection = "incoming" | "outgoing";

/** What the markers need to know about the branch: git's range endpoints and its counts. */
export interface SyncBranch {
  /** Checked-out branch; `null` when HEAD is detached. */
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  outgoing?: OutgoingCommits | null;
}

/** Older hosts report only the count against the upstream. Null from a current host means unknown. */
export function outgoingCount({ ahead, outgoing }: Pick<SyncBranch, "ahead" | "outgoing">): number {
  return outgoing === undefined ? ahead : (outgoing?.count ?? 0);
}

export function outgoingDestination(outgoing: OutgoingCommits | null | undefined): string | null {
  return outgoing ? `${outgoing.remote}/${outgoing.branch}` : null;
}

export interface SyncSection {
  direction: SyncDirection;
  /** Commits the branch info reports for this side. */
  count: number;
  /** A revision range such as `main..origin/main`; git lists it newest first. */
  range: string;
}

export interface SyncRow {
  id: string;
  hash: string;
  subject: string;
  author: string;
}

/** Subjects are shortened in the row model; the list also ellipsizes them to its width. */
const SUBJECT_LIMIT = 72;

/** Commits reachable from `to` but not from `from`: git's `from..to`. */
export function syncRange(direction: SyncDirection, branch: string, upstream: string): string {
  return direction === "incoming" ? `${branch}..${upstream}` : `${upstream}..${branch}`;
}

/**
 * The sections to show: both sides of the branch, only `direction` when a marker asks for one.
 * Incoming commits compare with the upstream. Outgoing commits compare with the Push destination.
 */
export function syncSections(branch: SyncBranch, direction?: SyncDirection | null): SyncSection[] {
  const { branch: name, upstream } = branch;
  if (!name) return [];
  const sections: SyncSection[] = [];
  if (direction !== "outgoing" && upstream && branch.behind > 0)
    sections.push({ direction: "incoming", count: branch.behind, range: syncRange("incoming", name, upstream) });
  const count = outgoingCount(branch);
  const base = branch.outgoing === undefined ? upstream : branch.outgoing?.reference;
  if (direction !== "incoming" && base && count > 0)
    sections.push({
      direction: "outgoing",
      count,
      range: syncRange("outgoing", branch.outgoing ? `refs/heads/${name}` : name, base),
    });
  return sections;
}

/** One line of the commit message, whitespace collapsed and cut at `limit` with an ellipsis. */
export function truncateSubject(subject: string, limit = SUBJECT_LIMIT): string {
  const text = subject.replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

/** A log commit as the popup's row: short hash, subject, author. Dates follow the log's format. */
export function syncRow(commit: Pick<Commit, "id" | "shortId" | "summary" | "message" | "author">): SyncRow {
  return {
    id: commit.id,
    hash: commit.shortId || commit.id.slice(0, 8),
    subject: truncateSubject(commit.summary || commit.message.split("\n")[0] || ""),
    author: commit.author,
  };
}
