/**
 * PLACEHOLDER (foundation stub) — the `#N` tab's panel. Wave 1 "details" replaces it.
 *
 * Contract: `DetailsPanel({ number })` renders the pull request `number` of the connected
 * repository inside its `#N` tab (one instance per open tab; hidden tabs are unmounted).
 * Data comes from `usePullRequestData(number, "details" | "mergeability" | "commits" |
 * "changes" | "viewedState" | "threads" | "pendingReview")` and the repository from
 * `useGhRepository()`; changes go through `data/operations.ts`, local git through
 * `data/local.ts` (checkout, worktree, file diffs). Refresh is
 * `reloadPullRequestData(number, …)` (the `github.pullRequest.refresh` action calls
 * `reloadPullRequest(number)`). "View Timeline" runs `openTimeline(number)`.
 * Provide `provideGithubHandler("submitReview" | "toggleViewed", …)` for those actions.
 */
import { Button, Spinner, T } from "@/ui";
import { usePullRequestData } from "../data/pullRequest";
import { checkoutPullRequest, openInBrowser } from "../data/local";
import { openTimeline } from "../toolwindow/timelineInput";
import { StateTag } from "../ui/chips";
import { Placeholder } from "../ui/Placeholder";
import styles from "../toolwindow/ToolWindow.module.css";

export function DetailsPanel({ number }: { number: number }) {
  const details = usePullRequestData(number, "details");
  const pr = details.value;
  return (
    <Placeholder title="Pull request details (placeholder)">
      {pr ? (
        <>
          <div className={styles.detailsTitle}>
            {pr.title} <span className={styles.secondary}>#{pr.number}</span>{" "}
            <StateTag state={pr.state} isDraft={pr.isDraft} />
          </div>
          <div className={styles.secondary}>
            {pr.baseRefName} ← {pr.headRefName}
          </div>
          <div className={styles.buttons}>
            <Button size="small" onClick={() => void openTimeline(number)}>
              <T>View Timeline</T>
            </Button>
            <Button size="small" onClick={() => void checkoutPullRequest(number)}>
              <T>Checkout</T>
            </Button>
            <Button size="small" onClick={() => void openInBrowser(pr.url)}>
              <T>View in browser</T>
            </Button>
          </div>
        </>
      ) : details.error ? (
        <div>{details.error}</div>
      ) : (
        <Spinner />
      )}
    </Placeholder>
  );
}
