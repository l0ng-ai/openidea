import { useEffect, useState } from "react";
import clsx from "clsx";
import type { AgentTask } from "@/bindings";
import { IconButton } from "@/ui";
import { Markdown } from "./Markdown";
import { copyReplyAction, type CopyReply } from "./replyActions";
import { replyOperations, type ReplyTurn } from "./model";
import styles from "./Session.module.css";

export function AgentReply({
  text,
  cwd,
  task,
  reply,
  turnCount = 0,
  onDiagramDrawn,
  actions = true,
}: {
  text: string;
  cwd: string;
  task?: AgentTask;
  reply?: ReplyTurn;
  turnCount?: number;
  onDiagramDrawn?: () => void;
  /** False when the caller shows `ReplyActions` in the message's header row. */
  actions?: boolean;
}) {
  return (
    <div className={styles.reply}>
      <Markdown text={text} cwd={cwd} onDiagramDrawn={onDiagramDrawn} />
      {actions && text.trim() && (
        <div className={styles.replyFooter}>
          <ReplyActions text={text} task={task} reply={reply} turnCount={turnCount} />
        </div>
      )}
    </div>
  );
}

/** Copy, quote, regenerate and branch for a reply; kept in its header row when it has one. */
export function ReplyActions({
  text,
  task,
  reply,
  turnCount = 0,
}: {
  text: string;
  task?: AgentTask;
  reply?: ReplyTurn;
  turnCount?: number;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const operations = task ? replyOperations(task, reply, turnCount) : { regenerate: false, fork: false };
  useEffect(() => {
    if (copied === null) return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <span className={clsx(styles.messageActions, styles.replyActions)} data-copied={copied === text || undefined}>
      <IconButton
        icon={copied === text ? "check" : "copy"}
        title={copied === text ? "Copied" : "Copy Markdown"}
        size="normal"
        action={copyReplyAction.id}
        actionArg={{ text, onCopied: () => setCopied(text) } satisfies CopyReply}
      />
      {task && task.status !== "archived" && (
        <IconButton
          icon="quote"
          title="Quote Reply"
          size="normal"
          action="agents.quoteReply"
          actionArg={{ task: task.id, text }}
        />
      )}
      {task && reply && operations.regenerate && (
        <IconButton
          icon="refresh"
          title="Regenerate Response"
          size="normal"
          action="agents.regenerateReply"
          actionArg={{ task: task.id, turn: reply.turn }}
        />
      )}
      {task && reply && operations.fork && (
        <IconButton
          icon="branch"
          title="Branch Conversation from Here"
          size="normal"
          action="agents.forkReply"
          actionArg={{ task: task.id, turn: reply.turn }}
        />
      )}
    </span>
  );
}
