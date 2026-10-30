/**
 * PLACEHOLDER (foundation stub) — the pull request timeline editor. Wave 1 "timeline"
 * replaces it.
 *
 * Contract: `TimelineEditor({ input })` is the component of the editor kind
 * `TIMELINE_KIND` (`github.timeline`, registered in `index.ts`); `timelineData(input)`
 * (`toolwindow/timelineInput.ts`) gives `{ owner, name, number }`. When the input's
 * repository is not the connected one, show a message instead. Data: `usePullRequestData`
 * (details, threads, pendingReview), `usePullRequestTimeline(number)` with
 * `loadTimelinePage` / `updateTimeline` / `reloadTimeline`, mutations in
 * `data/operations.ts`. The `github.pullRequest.timeline.refresh` action calls
 * `reloadPullRequest(number)` (`updateAll`). This module will also export the shared
 * comment components (`CommentItem`, `CommentEditor`, `ThreadView`) the review diff uses.
 */
import { Spinner } from "@/ui";
import type { EditorInput } from "@/workbench/contributions";
import { usePullRequestData, usePullRequestTimeline } from "../data/pullRequest";
import { sameRepository, useGhRepository } from "../data/repository";
import { timelineData, type TimelineInputData } from "../toolwindow/timelineInput";
import { Markdown } from "../ui/Markdown";
import { Placeholder } from "../ui/Placeholder";
import styles from "../toolwindow/ToolWindow.module.css";

export function TimelineEditor({ input }: { input: EditorInput }) {
  const data = timelineData(input);
  const repo = useGhRepository((s) => s.connection?.coordinates ?? null);
  if (!data || !sameRepository(repo, data))
    return <Placeholder title="Connect the Pull Requests tool window to this repository to see the timeline" />;
  return <Timeline data={data} />;
}

function Timeline({ data }: { data: TimelineInputData }) {
  const details = usePullRequestData(data.number, "details");
  const timeline = usePullRequestTimeline(data.number);
  const pr = details.value;
  return (
    <div className={styles.scroll}>
      <Placeholder title="Pull request timeline (placeholder)">
        {pr ? (
          <div className={styles.timelineStub}>
            <div className={styles.detailsTitle}>
              {pr.title} <span className={styles.secondary}>#{pr.number}</span>
            </div>
            <Markdown text={pr.body} emptyText="No description provided" />
            <div className={styles.secondary}>
              {timeline.loading ? <Spinner size={12} /> : `${timeline.items.length}`}
            </div>
          </div>
        ) : (
          <Spinner />
        )}
      </Placeholder>
    </div>
  );
}
