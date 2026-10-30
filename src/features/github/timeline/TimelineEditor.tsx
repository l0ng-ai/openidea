/**
 * The pull request timeline editor (`GHPRFileEditorComponentFactory`): one scrolling column
 * with the title (H2, `#N` link), the description item, the merged timeline items, the
 * loading / error status, the merged banner and the new-comment composer. The timeline loads
 * page by page as it is scrolled; Refresh Timeline (⌘R / Ctrl+F5) and the context menu's
 * actions work on it. The tab title follows the details (`{title} #N`).
 *
 * `TimelineEditor({ input })` is the component of the editor kind `github.timeline`; an
 * input of another repository than the connected one shows a message instead.
 */
import { useEffect, useMemo, useRef, type MouseEvent } from "react";
import { tx, txTemplate, useTx } from "@/platform/i18n";
import { Icon, Spinner, showContextMenu } from "@/ui";
import { notifyEditorDocumentChanged, type EditorInput } from "@/workbench/contributions";
import type { GHPullRequest } from "../api/types";
import { openInBrowser } from "../data/local";
import { addIssueComment, deleteMergedBranch, toggleReaction, updateDetails } from "../data/operations";
import { loadTimelinePage, usePullRequestData, usePullRequestTimeline } from "../data/pullRequest";
import { currentUserHasPermission, sameRepository, useGhRepository } from "../data/repository";
import { timelineData, type TimelineInputData } from "../toolwindow/timelineInput";
import { BranchChip } from "../ui/chips";
import { Placeholder } from "../ui/Placeholder";
import { ChatItem, CommentEditor, CommentItem, submitShortcut } from "./comments";
import { rich } from "./comments/ChatItem";
import { TimelineItem, WebLink } from "./items";
import { mergeTimeline } from "./model";
import styles from "./Timeline.module.css";

export function TimelineEditor({ input }: { input: EditorInput }) {
  const data = timelineData(input);
  const repo = useGhRepository((s) => s.connection?.coordinates ?? null);
  if (!data || !sameRepository(repo, data))
    return <Placeholder title="Connect the Pull Requests tool window to this repository to see the timeline" />;
  return <Timeline data={data} />;
}

/** Requests the next page when the end is near (IntelliJ: on scrolling) or the column does not fill the view. */
const NEAR_END_PX = 400;

function Timeline({ data }: { data: TimelineInputData }) {
  const t = useTx();
  const n = data.number;
  const details = usePullRequestData(n, "details");
  const threads = usePullRequestData(n, "threads");
  const timeline = usePullRequestTimeline(n);
  const pr = details.value;
  const scroll = useRef<HTMLDivElement>(null);
  const entries = useMemo(() => mergeTimeline(timeline.items, import.meta.env.DEV), [timeline.items]);

  // The tab title and icon are read from the details: let the tabs re-read them.
  useEffect(() => notifyEditorDocumentChanged(), [pr?.title, pr?.state, pr?.isDraft]);

  const more = () => {
    const el = scroll.current;
    if (!el || !timeline.hasMore || timeline.loading || timeline.error || timeline.initial) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - NEAR_END_PX) void loadTimelinePage(n);
  };
  useEffect(more);

  const onContextMenu = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("textarea, input, a")) return;
    if (window.getSelection()?.toString()) return;
    e.preventDefault();
    showContextMenu(e, [
      { kind: "action", action: "github.pullRequest.timeline.refresh" },
      { kind: "action", action: "github.pullRequest.openInBrowser", arg: n },
      { kind: "action", action: "github.pullRequest.copyUrl", arg: n },
    ]);
  };

  if (!pr)
    return (
      <div className={styles.placeholder}>
        {details.error ? (
          <Placeholder title="Can't load pull request details">{details.error}</Placeholder>
        ) : (
          <Spinner />
        )}
      </div>
    );

  return (
    <div
      ref={scroll}
      className={styles.scroll}
      tabIndex={-1}
      data-github-timeline={n}
      onScroll={more}
      onContextMenu={onContextMenu}
    >
      <div className={styles.column}>
        <h2 className={styles.title}>
          {pr.title}{" "}
          <a
            className={styles.link}
            href={pr.url}
            title={t("View in browser")}
            onClick={(e) => {
              e.preventDefault();
              void openInBrowser(pr.url);
            }}
          >
            #{pr.number}
          </a>
        </h2>
        <Description pr={pr} />
        {entries.map((e) => (
          <TimelineItem key={e.key} entry={e} pr={pr} threads={threads.value} />
        ))}
        {(timeline.loading || timeline.error) && (
          <div className={styles.status}>
            {timeline.error ? (
              <>
                <span className={styles.errorTitle}>{t("Can't load timeline items")}</span>
                <span className={styles.errorText}>{timeline.error}</span>
                <button type="button" className={styles.link} onClick={() => void loadTimelinePage(n)}>
                  {t("Retry")}
                </button>
              </>
            ) : (
              <Spinner />
            )}
          </div>
        )}
        {pr.state === "MERGED" && !timeline.error && <MergedBanner pr={pr} />}
        {currentUserHasPermission("READ") && (
          <div className={styles.composer}>
            <CommentEditor
              showAvatar
              submitLabel="Comment"
              submitHint={tx`${submitShortcut()} to comment`}
              clearOnSubmit
              onSubmit={(text) => addIssueComment(n, text)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** The description item: author, date, body (or "No description provided"), reactions; Edit and Add reaction. */
function Description({ pr }: { pr: GHPullRequest }) {
  const n = pr.number;
  return (
    <CommentItem
      author={pr.author}
      createdAt={pr.createdAt}
      body={pr.body}
      emptyText="No description provided"
      reactions={pr.reactions.nodes}
      canEdit={pr.viewerCanUpdate}
      canReact={pr.viewerCanReact}
      onSave={(body) => updateDetails(n, { body })}
      onToggleReaction={(content, add) => toggleReaction(n, pr.id, content, add, "details")}
    />
  );
}

/** "Pull Request Successfully Merged": delete the head branch, or restore it on GitHub. */
function MergedBanner({ pr }: { pr: GHPullRequest }) {
  const t = useTx();
  const ref = pr.headRef;
  const canDelete = pr.viewerCanDeleteHeadRef && !!ref;
  const branch = pr.headRefName ? <BranchChip name={pr.headRefName} className={styles.branch} /> : "branch";
  return (
    <ChatItem
      author={null}
      icon={<Icon name="github-pr-merged" size={30} />}
      title={<span className={styles.mergedTitle}>{t("Pull Request Successfully Merged")}</span>}
    >
      <span className={styles.mergedBody}>
        {canDelete
          ? rich(txTemplate("You can now {delete} {branch}."), {
              delete: (
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => void deleteMergedBranch(pr.number, ref!.id)}
                >
                  {t("delete")}
                </button>
              ),
              branch,
            })
          : rich(txTemplate("{branch} has been deleted. {restore}"), {
              branch,
              restore: <WebLink url={pr.url}>{t("Restore…")}</WebLink>,
            })}
        {!canDelete && <Icon name="external-link" size={12} />}
      </span>
    </ChatItem>
  );
}
