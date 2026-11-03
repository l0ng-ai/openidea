/**
 * The review inlays of a diff (`GHPRReviewEditorComponentsFactory`), in the editor inlay
 * panel (`CodeReviewCommentUIUtil.createEditorInlayPanel`: rounded, the editor background):
 *
 * - a review thread, the timeline's compact `ThreadView` (more than 3 comments: the first,
 *   "… {n} more replies" and the last; Reply / Resolve);
 * - a new comment: the current user's avatar and the comment field; Escape closes it, asking
 *   first when it has text ("Discard Comment"); its buttons follow the pending review.
 */
import { tx } from "@/platform/i18n";
import { ask } from "@/workbench/messages";
import { usePullRequestData } from "../data/pullRequest";
import { CommentEditor, submitShortcut, ThreadView } from "../timeline/comments";
import { SUBMIT_ACTION_TEXT, submitActions } from "./model";
import { removeNewComment, submitNewComment, updateNewComment, useNewComments, type NewComment } from "./newComments";
import { useReviewDiffSettings } from "./settings";
import styles from "./ReviewDiff.module.css";

export function ThreadInlay({ number, threadId }: { number: number; threadId: string }) {
  const thread = usePullRequestData(number, "threads").value?.find((t) => t.id === threadId);
  if (!thread) return null;
  return (
    <div className={styles.inlay} data-thread-inlay={threadId}>
      <ThreadView number={number} thread={thread} variant="compact" />
    </div>
  );
}

/** Closes a new comment; with text, after "Are you sure you want to discard the unsaved comment?". */
export async function discardNewComment(c: NewComment): Promise<void> {
  const current = useNewComments.getState().comments.find((x) => x.id === c.id) ?? c;
  if (current.text.trim()) {
    // `MessageDialogBuilder.yesNo`.
    const r = await ask({
      title: "Discard Comment",
      body: tx("Are you sure you want to discard the unsaved comment?"),
      buttons: [
        { id: "yes", label: "Yes", primary: true },
        { id: "no", label: "No" },
      ],
      cancel: false,
    });
    if (r.button !== "yes") return;
  }
  removeNewComment(c.id);
}

export function NewCommentInlay({ id }: { id: string }) {
  const comment = useNewComments((s) => s.comments.find((c) => c.id === id));
  const pending = usePullRequestData(comment?.number ?? 0, "pendingReview");
  const preferred = useReviewDiffSettings((s) => s.reviewCommentsPreferred);
  if (!comment) return null;
  // Until the pending review is known there is nothing to submit with (`submitActions` is empty).
  const actions = pending.value === undefined ? [] : submitActions(!!pending.value, preferred);
  const [primary, ...secondary] = actions;
  const textOf = () => useNewComments.getState().comments.find((c) => c.id === id)?.text ?? "";
  return (
    <div className={styles.inlay} data-new-comment={id}>
      <div className={styles.newComment}>
        <CommentEditor
          initialText={comment.text}
          submitLabel={primary ? SUBMIT_ACTION_TEXT[primary] : "Add Review Comment"}
          submitHint={primary ? tx`${submitShortcut()} to comment` : ""}
          onSubmit={(text) => (primary ? submitNewComment(comment, primary, text) : Promise.resolve())}
          onTextChange={(text) => updateNewComment(id, { text })}
          onCancel={() => void discardNewComment(comment)}
          noCancelButton
          extraActions={secondary.map((a) => ({
            label: SUBMIT_ACTION_TEXT[a],
            disabled: !comment.text.trim(),
            onClick: () => submitNewComment(comment, a, textOf()),
          }))}
          showAvatar
          variant="compact"
          autoFocus
          focusRequest={comment.focus}
        />
      </div>
    </div>
  );
}
