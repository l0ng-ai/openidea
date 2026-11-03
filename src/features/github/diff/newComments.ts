/**
 * New review comments being written in diffs (IntelliJ's `GHPRThreadsViewModels.newComments`
 * with `GHPRReviewNewCommentEditorViewModel`): kept per pull request, file and diff (the
 * cumulative one or a commit's) while the diff tabs come and go, and submitted with
 *
 * - "Start Review" / "Add Single Comment" without a pending review: `createReview` with the
 *   comment as its thread (pending, or posted at once with `event: COMMENT`); the choice
 *   becomes the preferred button;
 * - "Add Review Comment" with one: `addPullRequestReviewThread` on the cumulative diff, a
 *   commit comment at the line's diff position (merge base ↔ commit) on a commit's diff.
 */
import { create } from "zustand";
import { compareChangedFiles } from "../api/requests";
import { addCommitComment, createReview, createThread } from "../data/operations";
import { loadPullRequestData } from "../data/pullRequest";
import { diffPosition, draftThread, type CommentLocation, type SubmitAction } from "./model";
import { setReviewDiffSettings } from "./settings";

export interface NewComment {
  id: string;
  number: number;
  /** Repository-relative path. */
  path: string;
  /** The commit whose diff it is on; null for the pull request's changes. */
  commit: string | null;
  location: CommentLocation;
  text: string;
  createdAt: string;
  /** Bumped to move the focus into its editor. */
  focus: number;
}

export const useNewComments = create<{ comments: NewComment[] }>(() => ({ comments: [] }));

let seq = 0;

const sameDiff = (c: NewComment, number: number, path: string, commit: string | null) =>
  c.number === number && c.path === path && c.commit === commit;

/** The new comments of a diff. */
export function newCommentsOf(number: number, path: string, commit: string | null): NewComment[] {
  return useNewComments.getState().comments.filter((c) => sameDiff(c, number, path, commit));
}

/** `requestNewComment`: opens a new comment at `location`, or focuses the one already there. */
export function requestNewComment(
  number: number,
  path: string,
  commit: string | null,
  location: CommentLocation,
): NewComment {
  const existing = newCommentsOf(number, path, commit).find(
    (c) =>
      c.location.side === location.side &&
      c.location.line === location.line &&
      c.location.startLine === location.startLine,
  );
  if (existing) {
    updateNewComment(existing.id, { focus: existing.focus + 1 });
    return existing;
  }
  const comment: NewComment = {
    id: `new-${++seq}`,
    number,
    path,
    commit,
    location,
    text: "",
    createdAt: new Date().toISOString(),
    focus: 1,
  };
  useNewComments.setState((s) => ({ comments: [...s.comments, comment] }));
  return comment;
}

export function updateNewComment(id: string, patch: Partial<Omit<NewComment, "id">>) {
  useNewComments.setState((s) => ({ comments: s.comments.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
}

export function removeNewComment(id: string) {
  useNewComments.setState((s) => ({ comments: s.comments.filter((c) => c.id !== id) }));
}

/** Forgets every new comment (another repository). */
export function clearNewComments() {
  useNewComments.setState({ comments: [] });
}

/** The revision the comment's diff shows on the right: the commit, else the pull request's head. */
async function afterRevision(c: NewComment): Promise<string> {
  return c.commit ?? (await loadPullRequestData(c.number, "details")).headRefOid;
}

/** Sends `body` with `action`; the comment is closed once it is created. */
export async function submitNewComment(c: NewComment, action: SubmitAction, body: string): Promise<void> {
  if (action === "reviewComment") {
    const pending = await loadPullRequestData(c.number, "pendingReview");
    if (!pending) throw new Error("No pending review");
    if (c.commit === null) {
      const t = draftThread(c.path, c.location, body);
      await createThread(c.number, {
        reviewId: pending.id,
        body,
        path: c.path,
        line: t.line,
        side: t.side,
        startLine: t.startLine ?? undefined,
        startSide: t.startSide ?? undefined,
      });
    } else {
      const pr = await loadPullRequestData(c.number, "details");
      const files = await compareChangedFiles(pr.baseRefOid, c.commit);
      const patch = files.find((f) => f.filename === c.path)?.patch;
      const position = diffPosition(patch, c.location.side, c.location.line);
      if (position === null) throw new Error("Can't map file line to diff");
      await addCommitComment(c.number, {
        reviewId: pending.id,
        body,
        commitSha: c.commit,
        path: c.path,
        position,
      });
    }
  } else {
    await createReview(c.number, {
      event: action === "singleComment" ? "COMMENT" : undefined,
      commitOid: await afterRevision(c),
      threads: [draftThread(c.path, c.location, body)],
    });
    setReviewDiffSettings({ reviewCommentsPreferred: action === "startReview" });
  }
  removeNewComment(c.id);
}
