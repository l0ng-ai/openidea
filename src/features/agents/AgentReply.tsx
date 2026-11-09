import { useEffect, useState, type ReactNode } from "react";
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
  /** False when the caller supplies the message footer. */
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

export function MessageActions({ children, copied = false }: { children: ReactNode; copied?: boolean }) {
  return (
    <span className={styles.messageActions} data-copied={copied || undefined}>
      {children}
    </span>
  );
}

/** Shared action row for a reply in either the conversation or a subagent preview. */
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
    <MessageActions copied={copied === text}>
      <IconButton
        icon={copied === text ? "check" : "copy"}
        title={copied === text ? "Copied" : "Copy Markdown"}
        size="small"
        action={copyReplyAction.id}
        actionArg={{ text, onCopied: () => setCopied(text) } satisfies CopyReply}
      />
      {task && task.status !== "archived" && (
        <IconButton
          icon="quote"
          title="Quote Reply"
          size="small"
          action="agents.quoteReply"
          actionArg={{ task: task.id, text }}
        />
      )}
      {task && reply && operations.regenerate && (
        <IconButton
          icon="refresh"
          title="Regenerate Response"
          size="small"
          action="agents.regenerateReply"
          actionArg={{ task: task.id, turn: reply.turn }}
        />
      )}
      {task && reply && operations.fork && (
        <IconButton
          icon="branch"
          title="Branch Conversation from Here"
          size="small"
          action="agents.forkReply"
          actionArg={{ task: task.id, turn: reply.turn }}
        />
      )}
    </MessageActions>
  );
}
