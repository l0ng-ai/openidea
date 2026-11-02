/**
 * The Submit Review popup (`GHPRSubmitReviewPopup`, `CodeReviewSubmitPopupHandler`): bold
 * "Submit Review" with the pending comment count, the discard (pending review with
 * comments) and close buttons, the review comment editor, the error, then Approve /
 * Request Changes (not for the author) and Comment. Shown above the button that opened
 * it, or centred in the window. 500×200, resizable.
 */
import { useState, type CSSProperties } from "react";
import { Button, IconButton, Popup, Spinner, T } from "@/ui";
import { useTx, tx } from "@/platform/i18n";
import { ask } from "@/workbench/messages";
import { errorMessage } from "../api/client";
import type { GHPullRequestReviewEvent } from "../api/types";
import { deleteReview, submitOrCreateReview } from "../data/operations";
import { loadPullRequestData, usePullRequestData } from "../data/pullRequest";
import { openDialog } from "../ui/dialogs";
import { setReviewText, useReviewText } from "./state";
import styles from "./Details.module.css";

/** Opens the popup for pull request `number`; resolves when it closes. */
export function showSubmitReview(number: number, anchor?: Element | null): Promise<unknown> {
  // The details and the pending review are needed for the buttons and the header.
  void loadPullRequestData(number, "details").catch(() => undefined);
  void loadPullRequestData(number, "pendingReview").catch(() => undefined);
  const at = anchor?.isConnected
    ? anchor
    : { x: Math.round(window.innerWidth / 2) - 250, y: Math.round(window.innerHeight / 3) };
  return openDialog<true>((done) => <SubmitReview number={number} anchor={at} onClose={() => done(null)} />);
}

function SubmitReview(props: { number: number; anchor: Element | { x: number; y: number }; onClose: () => void }) {
  const { number } = props;
  const t = useTx();
  const details = usePullRequestData(number, "details").value;
  const pending = usePullRequestData(number, "pendingReview").value;
  const text = useReviewText((s) => s.text[number] ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const comments = pending?.commentsCount ?? 0;
  const hasAnyComment = text.length > 0 || comments > 0;
  const isAuthor = details?.viewerDidAuthor ?? false;

  const submit = async (event: GHPullRequestReviewEvent) => {
    setBusy(true);
    setError(null);
    try {
      await submitOrCreateReview(number, event, text);
      setReviewText(number, "");
      props.onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const discard = async () => {
    if (!pending) return;
    const r = await ask({
      title: tx("Discard Pending Review"),
      body: tx("Are you sure you want to delete all pending comments?"),
      buttons: [
        { id: "yes", label: "Yes", primary: true },
        { id: "no", label: "No" },
      ],
      cancel: false,
    });
    if (r.button !== "yes") return;
    setBusy(true);
    try {
      await deleteReview(number, pending.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const anchored = "getBoundingClientRect" in props.anchor;
  return (
    <Popup
      open
      anchor={props.anchor}
      placement={anchored ? "top-start" : "bottom-start"}
      onClose={(reason) => {
        // A click outside does not drop a review while it is being sent.
        if (reason !== "outside" || !busy) props.onClose();
      }}
      role="dialog"
      aria-label={t("Submit Review")}
      className={styles.submitPopup}
      style={{ "--submit-width": "500px", "--submit-height": "200px" } as CSSProperties}
    >
      <div className={styles.submitHeader}>
        <span className={styles.bold}>
          <T>Submit Review</T>
        </span>
        {comments > 0 && (
          <span>{comments === 1 ? t`${comments} pending comment` : t`${comments} pending comments`}</span>
        )}
        <span className={styles.flex} />
        {pending && comments > 0 && (
          <IconButton icon="trash" size="small" title="Discard pending comments" disabled={busy} onClick={discard} />
        )}
        <IconButton icon="close" size="small" title="Close" onClick={props.onClose} />
      </div>
      <textarea
        data-autofocus
        className={styles.submitEditor}
        placeholder={t("Review comment")}
        aria-label={t("Review comment")}
        value={text}
        onChange={(e) => {
          setError(null);
          setReviewText(number, e.target.value);
        }}
      />
      {error && (
        <div className={styles.submitError}>
          <T>Failed to submit review</T>
          <div className={styles.secondary}>{error}</div>
        </div>
      )}
      <div className={styles.submitButtons}>
        {!isAuthor && (
          <>
            <Button variant="primary" disabled={busy} onClick={() => void submit("APPROVE")}>
              Approve
            </Button>
            <Button disabled={busy || !hasAnyComment} onClick={() => void submit("REQUEST_CHANGES")}>
              Request Changes
            </Button>
          </>
        )}
        <Button
          disabled={busy || !hasAnyComment}
          title="Submit general feedback without explicit approval"
          onClick={() => void submit("COMMENT")}
        >
          Comment
        </Button>
        {busy && <Spinner size={14} />}
      </div>
    </Popup>
  );
}
