/**
 * The review actions of a pull request's diff toolbar (`GHPRDiffService` `CONTEXT_ACTIONS`):
 * Refresh Review Data, the Submit Review button ("Submit Review…" / "Submit Review ({n})…",
 * the details panel's popup through the `submitReview` handler), Previous / Next Comment.
 */
import { useContextKeys } from "@/platform/context";
import { tx } from "@/platform/i18n";
import { Button, IconButton } from "@/ui";
import { usePullRequestData } from "../data/pullRequest";
import { githubHandler, handlerContextKey } from "../toolwindow/handlers";
import type { ReviewDiff } from "./reviewDiff";
import styles from "./ReviewDiff.module.css";

/** `{0, choice, 0#Submit Review…|1#Submit Review ({0})…}`. */
const submitReviewText = (pending: number) => (pending > 0 ? tx`Submit Review (${pending})…` : tx("Submit Review…"));

export function ReviewToolbar({ diff }: { diff: ReviewDiff }) {
  const pending = usePullRequestData(diff.number, "pendingReview");
  const threads = usePullRequestData(diff.number, "threads");
  const canSubmit = useContextKeys((k) => !!k[handlerContextKey("submitReview")]);
  const loading = pending.loading || threads.loading;
  return (
    <>
      <span className={styles.sep} />
      <IconButton
        icon="refresh"
        title="Refresh Review Data"
        size="small"
        disabled={loading}
        onClick={() => diff.refresh()}
      />
      <Button size="small" disabled={!canSubmit} onClick={() => githubHandler("submitReview")?.(diff.number)}>
        {submitReviewText(pending.value?.commentsCount ?? 0)}
      </Button>
      <IconButton
        icon="arrow-up"
        title="Previous Comment"
        size="small"
        disabled={!diff.canNavigate}
        onClick={() => void diff.gotoComment(-1)}
      />
      <IconButton
        icon="arrow-down"
        title="Next Comment"
        size="small"
        disabled={!diff.canNavigate}
        onClick={() => void diff.gotoComment(1)}
      />
    </>
  );
}
