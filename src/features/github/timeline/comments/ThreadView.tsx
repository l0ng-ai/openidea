/**
 * A review thread, in two variants:
 *
 * - `full` (`GHPRTimelineThreadComponentFactory`, the timeline): the first comment's author
 *   and date with the OUTDATED / RESOLVED / PENDING tags and its actions; the file header
 *   (opening the diff at the line) over the hunk with the anchor highlighted, then the
 *   comment. Resolved threads start collapsed: a 2-line grey preview above the file header.
 *   Replies start folded: their authors' avatars, "Reply" / "{n} replies", the last reply's
 *   date and Resolve / Unresolve; unfolded, the replies and the reply box.
 * - `compact` (`GHPRReviewThreadComponentFactory`, diff inlays): the comments (with more
 *   than 3, the first, "… {n} more replies" and the last), then "Reply" and Resolve /
 *   Unresolve; "Reply" opens the reply box.
 *
 * Mutations go through `data/operations.ts`; the thread comes from the pull request's
 * `threads` data, which they refresh.
 */
import { useState } from "react";
import { tx, useTx } from "@/platform/i18n";
import { IconButton } from "@/ui";
import { errorMessage } from "../../api/client";
import type { GHPullRequestReviewComment, GHPullRequestReviewThread } from "../../api/types";
import { openPullRequestFileDiff } from "../../data/local";
import {
  deleteReviewComment,
  replyToComment,
  resolveThread,
  toggleReaction,
  unresolveThread,
  updateReviewComment,
} from "../../data/operations";
import { AvatarStack } from "../../ui/Avatar";
import { Markdown } from "../../ui/Markdown";
import { prettyDateTime } from "../../ui/prettyDate";
import { presentableName, threadDiffHunk, threadDiffWithAnchor } from "../model";
import { ChatItem, Tag, type ChatItemVariant } from "./ChatItem";
import { CommentEditor, submitShortcut } from "./CommentEditor";
import { confirmDeleteComment, CommentItem } from "./CommentItem";
import { DiffBox, HunkView } from "./DiffHunk";
import { AddReactionButton, Reactions, useReactionsState } from "./Reactions";
import { ReviewCommentBody } from "./SuggestedChange";
import styles from "./comments.module.css";

export interface ThreadViewProps {
  /** The pull request number. */
  number: number;
  thread: GHPullRequestReviewThread;
  variant?: "full" | "compact";
}

export function ThreadView({ variant = "full", ...props }: ThreadViewProps) {
  return variant === "full" ? <FullThread {...props} /> : <CompactThread {...props} />;
}

/** "Resolve" / "Unresolve" (`getResolveToggleActionText`). */
const resolveText = (resolved: boolean) => (resolved ? "Unresolve" : "Resolve");

/** The thread's resolve toggle and busy state; `onChanged` gets the new resolved state. */
function useResolve(number: number, thread: GHPullRequestReviewThread, onChanged?: (resolved: boolean) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canChange = thread.isResolved ? thread.viewerCanUnresolve : thread.viewerCanResolve;
  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      const t = thread.isResolved ? await unresolveThread(number, thread.id) : await resolveThread(number, thread.id);
      onChanged?.(t.isResolved);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, canChange, toggle };
}

/** The reply box: "Reply" plus Resolve / Unresolve. */
function ReplyBox({
  number,
  thread,
  variant,
  resolve,
  autoFocus,
  onCancel,
}: {
  number: number;
  thread: GHPullRequestReviewThread;
  variant: ChatItemVariant;
  resolve: ReturnType<typeof useResolve>;
  autoFocus?: boolean;
  onCancel?: () => void;
}) {
  const first = thread.comments.nodes[0];
  if (!thread.viewerCanReply || !first) return null;
  return (
    <div className={styles.replyBox} data-variant={variant === "compact" ? "compact" : undefined}>
      <CommentEditor
        submitLabel="Reply"
        submitHint={tx`${submitShortcut()} to reply`}
        showAvatar
        variant={variant === "compact" ? "compact" : "secondary"}
        autoFocus={autoFocus}
        clearOnSubmit
        onCancel={onCancel}
        extraActions={
          resolve.canChange ? [{ label: resolveText(thread.isResolved), onClick: resolve.toggle }] : undefined
        }
        onSubmit={(text) => replyToComment(number, first.id, text)}
      />
    </div>
  );
}

const tagsOf = (thread: GHPullRequestReviewThread, comment: GHPullRequestReviewComment | undefined, first: boolean) => (
  <>
    {first && thread.isOutdated && <Tag>OUTDATED</Tag>}
    {first && thread.isResolved && <Tag>RESOLVED</Tag>}
    {comment?.state === "PENDING" && <Tag>PENDING</Tag>}
  </>
);

/** A review comment of `thread` as a chat item, editable, deletable and reactable as allowed. */
function ReviewComment({
  number,
  thread,
  comment,
  variant,
  first,
}: {
  number: number;
  thread: GHPullRequestReviewThread;
  comment: GHPullRequestReviewComment;
  variant: ChatItemVariant;
  first?: boolean;
}) {
  return (
    <CommentItem
      variant={variant}
      author={comment.author}
      createdAt={comment.createdAt}
      body={comment.body}
      reactions={comment.reactions.nodes}
      canEdit={comment.viewerCanUpdate}
      canDelete={comment.viewerCanDelete}
      canReact={comment.viewerCanReact}
      tags={
        variant === "compact" ? tagsOf(thread, comment, !!first) : comment.state === "PENDING" && <Tag>PENDING</Tag>
      }
      renderBody={(body) => <ReviewCommentBody number={number} thread={thread} body={body} />}
      onSave={(body) => updateReviewComment(number, comment.id, body)}
      onDelete={() => deleteReviewComment(number, comment.id)}
      onToggleReaction={(content, add) => toggleReaction(number, comment.id, content, add, "threads")}
    />
  );
}

function openThreadDiff(number: number, thread: GHPullRequestReviewThread) {
  const line = thread.line != null && thread.diffSide === "RIGHT" ? thread.line - 1 : undefined;
  void openPullRequestFileDiff(number, thread.path, { line });
}

function FullThread({ number, thread }: Omit<ThreadViewProps, "variant">) {
  const t = useTx();
  // Only resolved threads collapse (`collapsible = isResolved`): unresolved elsewhere, it opens.
  const [collapsedState, setCollapsedState] = useState(thread.isResolved);
  const collapsed = thread.isResolved && collapsedState;
  const [repliesFolded, setRepliesFolded] = useState(true);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setCollapsed = (c: boolean) => {
    setCollapsedState(c);
    if (c) setRepliesFolded(true);
  };
  const resolve = useResolve(number, thread, setCollapsed);
  const [main, ...replies] = thread.comments.nodes;
  const reactions = useReactionsState(main?.reactions.nodes ?? [], (content, add) =>
    main ? toggleReaction(number, main.id, content, add, "threads") : Promise.resolve(),
  );
  const busy = resolve.busy || deleting;
  const diff = threadDiffWithAnchor({ ...thread, diffHunk: threadDiffHunk(thread) });
  const box = (
    <DiffBox
      path={thread.path}
      onOpen={() => openThreadDiff(number, thread)}
      collapsible={thread.isResolved}
      collapsed={collapsed}
      onToggleCollapsed={() => setCollapsed(!collapsed)}
    >
      {diff ? (
        <HunkView hunk={diff.hunk} anchor={diff.anchor} />
      ) : thread.subjectType === "FILE" ? null : (
        <div className={styles.noDiff}>{t("Could not load diff hunk for thread")}</div>
      )}
    </DiffBox>
  );

  const remove = async () => {
    if (!main || !(await confirmDeleteComment())) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteReviewComment(number, main.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setDeleting(false);
    }
  };

  const actions = main && (main.viewerCanUpdate || main.viewerCanDelete || main.viewerCanReact) && (
    <>
      {main.viewerCanUpdate && (
        <IconButton icon="edit" title="Edit" size="small" disabled={busy} onClick={() => setEditing(true)} />
      )}
      {main.viewerCanDelete && (
        <IconButton icon="trash" title="Delete" size="small" disabled={busy} onClick={() => void remove()} />
      )}
      {main.viewerCanReact && <AddReactionButton state={reactions} />}
    </>
  );

  const replyAuthors = [...new Map(replies.filter((r) => r.author).map((r) => [r.author!.login, r.author!])).values()];
  const last = replies[replies.length - 1];
  const n = replies.length;

  return (
    <div className={styles.thread} data-thread={thread.id}>
      <ChatItem
        author={main?.author ?? null}
        date={main?.createdAt}
        tags={tagsOf(thread, main, true)}
        actions={actions || undefined}
        wide
      >
        <div className={styles.threadContent}>
          {!main ? (
            box
          ) : collapsed ? (
            <>
              <div className={styles.preview}>
                <Markdown text={main.body} />
              </div>
              {box}
            </>
          ) : (
            <>
              {box}
              {editing ? (
                <CommentEditor
                  initialText={main.body}
                  submitLabel="Save Changes"
                  submitHint={tx`${submitShortcut()} to save changes`}
                  autoFocus
                  onCancel={() => setEditing(false)}
                  onSubmit={async (text) => {
                    await updateReviewComment(number, main.id, text);
                    setEditing(false);
                  }}
                />
              ) : (
                <ReviewCommentBody number={number} thread={thread} body={main.body} />
              )}
              <Reactions state={reactions} canReact={main.viewerCanReact} />
            </>
          )}
        </div>
        {(error || resolve.error) && <div className={styles.error}>{error ?? resolve.error}</div>}
        {repliesFolded && (n > 0 || thread.viewerCanReply || resolve.canChange) && (
          <div className={styles.folded}>
            {(n > 0 || thread.viewerCanReply) && (
              <span className={styles.foldedReplies}>
                {n > 0 && (
                  <AvatarStack
                    items={replyAuthors.map((a) => ({ key: a.login, url: a.avatarUrl, name: presentableName(a) }))}
                    max={replyAuthors.length}
                    size={20}
                  />
                )}
                <button
                  type="button"
                  className={styles.link}
                  disabled={busy}
                  onClick={() => {
                    setRepliesFolded(false);
                    setCollapsedState(false);
                  }}
                >
                  {n === 0 ? t("Reply") : n === 1 ? tx`${n} reply` : tx`${n} replies`}
                </button>
                {last && <span className={styles.secondary}>{prettyDateTime(last.createdAt)}</span>}
              </span>
            )}
            {resolve.canChange && (
              <button type="button" className={styles.link} disabled={busy} onClick={() => void resolve.toggle()}>
                {t(resolveText(thread.isResolved))}
              </button>
            )}
          </div>
        )}
      </ChatItem>
      {!repliesFolded && (
        <>
          {replies.map((c) => (
            <ReviewComment key={c.id} number={number} thread={thread} comment={c} variant="secondary" />
          ))}
          <ReplyBox number={number} thread={thread} variant="secondary" resolve={resolve} autoFocus />
        </>
      )}
    </div>
  );
}

function CompactThread({ number, thread }: Omit<ThreadViewProps, "variant">) {
  const t = useTx();
  const [expanded, setExpanded] = useState(false);
  const [replying, setReplying] = useState(false);
  const resolve = useResolve(number, thread);
  const comments = thread.comments.nodes;
  const folded = !expanded && comments.length > 3;
  const shown = folded ? [comments[0]!, comments[comments.length - 1]!] : comments;
  const hidden = comments.length - 2;
  return (
    <div className={styles.thread} data-thread={thread.id}>
      {shown.map((c, i) => (
        <div key={c.id}>
          <ReviewComment
            number={number}
            thread={thread}
            comment={c}
            variant="compact"
            first={c.id === comments[0]?.id}
          />
          {folded && i === 0 && (
            <div className={styles.moreReplies}>
              <button type="button" className={styles.link} onClick={() => setExpanded(true)}>
                … {tx`${hidden} more replies`}
              </button>
            </div>
          )}
        </div>
      ))}
      {resolve.error && <div className={styles.error}>{resolve.error}</div>}
      {replying ? (
        <ReplyBox
          number={number}
          thread={thread}
          variant="compact"
          resolve={resolve}
          autoFocus
          onCancel={() => setReplying(false)}
        />
      ) : (
        (thread.viewerCanReply || resolve.canChange) && (
          <div className={styles.compactFooter}>
            {thread.viewerCanReply && (
              <button type="button" className={styles.link} onClick={() => setReplying(true)}>
                {t("Reply")}
              </button>
            )}
            {resolve.canChange && (
              <button
                type="button"
                className={styles.link}
                disabled={resolve.busy}
                onClick={() => void resolve.toggle()}
              >
                {t(resolveText(thread.isResolved))}
              </button>
            )}
          </div>
        )
      )}
    </div>
  );
}
