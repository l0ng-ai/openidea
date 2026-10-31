/**
 * A comment as a chat item (`GHPRTimelineItemComponentFactory` comments,
 * `GHPRReviewThreadCommentComponentFactory`): the header actions Edit (an inline editor
 * with "Save Changes"), Delete (after "Delete Comment" / "Are you sure you want to delete
 * this comment?") and Add reaction, each shown when allowed, then the body and the
 * reactions row.
 */
import { useState, type ReactNode } from "react";
import { tx } from "@/platform/i18n";
import { IconButton } from "@/ui";
import { confirm } from "@/workbench/messages";
import { errorMessage } from "../../api/client";
import type { GHActor, GHReaction } from "../../api/types";
import { Markdown } from "../../ui/Markdown";
import { ChatItem, type ChatItemVariant } from "./ChatItem";
import { CommentEditor, submitShortcut } from "./CommentEditor";
import { AddReactionButton, Reactions, useReactionsState, type ToggleReaction } from "./Reactions";
import styles from "./comments.module.css";

/** `CodeReviewCommentUIUtil.createDeleteCommentIconButton`'s question. */
export function confirmDeleteComment(): Promise<boolean> {
  return confirm({
    title: "Delete Comment",
    message: tx("Are you sure you want to delete this comment?"),
    ok: "Delete",
    icon: "question",
  });
}

export interface CommentItemProps {
  variant?: ChatItemVariant;
  author: GHActor | null;
  createdAt: string | null;
  /** Markdown. */
  body: string;
  /** Shown in grey italics for an empty body ("No description provided"). */
  emptyText?: string;
  /** The reactions row and the Add reaction button (with `canReact`); none when absent. */
  reactions?: readonly GHReaction[];
  canEdit?: boolean;
  canDelete?: boolean;
  canReact?: boolean;
  onSave?: (body: string) => Promise<unknown>;
  onDelete?: () => Promise<unknown>;
  onToggleReaction?: ToggleReaction;
  tags?: ReactNode;
  /** Renders the body (suggested changes); Markdown by default. */
  renderBody?: (body: string) => ReactNode;
  /** Under the body (a review's status line). */
  footer?: ReactNode;
  /** Disables the actions (another request of the item runs). */
  busy?: boolean;
}

export function CommentItem(props: CommentItemProps) {
  const {
    variant = "full",
    body,
    emptyText,
    reactions,
    canEdit,
    canDelete,
    canReact,
    onSave,
    onDelete,
    onToggleReaction,
    renderBody,
  } = props;
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reactionsState = useReactionsState(reactions ?? [], onToggleReaction ?? (() => Promise.resolve()));
  const busy = props.busy || deleting;

  const remove = async () => {
    if (!onDelete || !(await confirmDeleteComment())) return;
    setDeleting(true);
    setError(null);
    try {
      await onDelete();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setDeleting(false);
    }
  };

  const actions =
    (canEdit && onSave) || (canDelete && onDelete) || (canReact && onToggleReaction && reactions) ? (
      <>
        {canEdit && onSave && (
          <IconButton icon="edit" title="Edit" size="small" disabled={busy} onClick={() => setEditing(true)} />
        )}
        {canDelete && onDelete && (
          <IconButton icon="trash" title="Delete" size="small" disabled={busy} onClick={() => void remove()} />
        )}
        {canReact && onToggleReaction && reactions && <AddReactionButton state={reactionsState} />}
      </>
    ) : undefined;

  return (
    <ChatItem variant={variant} author={props.author} date={props.createdAt} tags={props.tags} actions={actions}>
      {editing && onSave ? (
        <CommentEditor
          initialText={body}
          submitLabel="Save Changes"
          submitHint={tx`${submitShortcut()} to save changes`}
          autoFocus
          variant={variant}
          onCancel={() => setEditing(false)}
          onSubmit={async (text) => {
            await onSave(text);
            setEditing(false);
          }}
        />
      ) : renderBody ? (
        renderBody(body)
      ) : (
        <Markdown text={body} emptyText={emptyText} />
      )}
      {error && <div className={styles.error}>{error}</div>}
      {props.footer}
      {reactions && <Reactions state={reactionsState} canReact={!!canReact && !!onToggleReaction} />}
    </ChatItem>
  );
}
