import type { AgentEntry, AgentImage, AgentTask } from "@/bindings";
import { useTx } from "@/platform/i18n";
import { isImeKey } from "@/platform/ime";
import { basename } from "@/platform/project";
import { copyText, fileIconName, Icon, IconButton, T } from "@/ui";
import { notifications } from "@/workbench/contributions";
import clsx from "clsx";
import { memo, useLayoutEffect, useRef, useState } from "react";
import { AgentReply, MessageActions, ReplyActions } from "../AgentReply";
import { ImagePreview, imageSrc } from "../ImagePreview";
import { ReferencedText } from "../ReferenceChip";
import styles from "../Session.module.css";
import { SubmitButton } from "../SubmitButton";
import { useAgentSettings } from "../agentSettings";
import { messageTokens, parseMention } from "../composerModel";
import { formatDuration, formatSentAt, userMessageText } from "../conversation";
import { useAgentErrorText } from "../loginHint";
import { isBusy, type ReplyTimes, type ReplyTurn } from "../model";
import { useRevealedText } from "../reveal";
import { forkTask, rerunFrom, resendMessage } from "../store";
import { PermissionLine } from "./QuestionForm";
import { type UserEntry } from "./shared";
import { SubagentCard, ThoughtEntry, ToolEntry } from "./toolEntries";

/** When a message was sent, or when the turn behind a reply finished, and how long it took. */
function MessageTime({
  sentMs,
  doneMs,
  at = "sent",
}: {
  sentMs: number | null;
  doneMs: number | null;
  /** Replies show when they finished; messages show when they were sent. */
  at?: "sent" | "done";
}) {
  const shown = at === "done" ? doneMs : sentMs;
  if (shown == null) return null;
  return (
    <span className={styles.messageTime} title={new Date(shown).toLocaleString()}>
      {formatSentAt(shown)}
      {sentMs != null && doneMs != null && ` · ${formatDuration(Math.max(0, doneMs - sentMs))}`}
    </span>
  );
}

/** Memoized: the earlier entries rendered behind a reopened conversation leave the rest alone. */
function AgentMessage({
  task,
  text,
  turnCount,
  reply,
  time,
  working,
  onDiagramDrawn,
}: {
  task: AgentTask;
  text: string;
  turnCount: number;
  reply?: ReplyTurn;
  time?: ReplyTimes | null;
  /** The reply streams: its text is revealed at a pace. */
  working: boolean;
  onDiagramDrawn: () => void;
}) {
  const { smoothText } = useAgentSettings();
  const shown = useRevealedText(text, working && smoothText);
  // The revealed text grows the conversation between its renders: keep following the end.
  useLayoutEffect(() => {
    if (working) onDiagramDrawn();
  }, [shown, working, onDiagramDrawn]);
  return (
    <div className={styles.agentMessage}>
      <div className={styles.agentCard}>
        <AgentReply
          text={shown}
          cwd={task.cwd}
          task={task}
          reply={reply}
          turnCount={turnCount}
          onDiagramDrawn={onDiagramDrawn}
          actions={false}
        />
      </div>
      {/* Only a turn's final reply carries its time and actions, once the turn has ended. */}
      {reply && !(isBusy(task.status) && reply.turn === turnCount - 1) && (
        <div className={styles.messageFooter}>
          <MessageTime sentMs={time?.sentMs ?? null} doneMs={time?.doneMs ?? null} at="done" />
          <ReplyActions text={text} task={task} reply={reply} turnCount={turnCount} />
        </div>
      )}
    </div>
  );
}

export const Entry = memo(function Entry({
  task,
  entry,
  turn,
  turnCount,
  reply,
  time,
  working,
  onOpenSubagent,
  onDiagramDrawn,
}: {
  task: AgentTask;
  entry: AgentEntry;
  /** Number of the turn this message started (from 0), when it started one. */
  turn: number | null;
  turnCount: number;
  reply?: ReplyTurn;
  /** When the turn this reply answered was asked and finished. */
  time?: ReplyTimes | null;
  working: boolean;
  onOpenSubagent: (id: string) => void;
  onDiagramDrawn: () => void;
}) {
  switch (entry.type) {
    case "user":
      return <UserMessage task={task} entry={entry} turn={turn} turnCount={turnCount} />;
    case "agent":
      return (
        <AgentMessage
          task={task}
          text={entry.text}
          turnCount={turnCount}
          reply={reply}
          time={time}
          working={working}
          onDiagramDrawn={onDiagramDrawn}
        />
      );
    case "thought":
      return <ThoughtEntry task={task} text={entry.text} working={working} onDiagramDrawn={onDiagramDrawn} />;
    case "tool":
      return <ToolEntry task={task} entry={entry} />;
    case "plan":
      return (
        <div className={styles.plan}>
          <div className={styles.planTitle}>
            <T>Plan</T>
          </div>
          {entry.items.map((item, i) => (
            <div key={i} className={clsx(styles.planItem, item.status === "completed" && styles.planDone)}>
              <Icon
                name={item.status === "completed" ? "check" : item.status === "in_progress" ? "run" : "minus"}
                size={12}
              />
              {item.content}
            </div>
          ))}
        </div>
      );
    case "subagent":
      return (
        <SubagentCard
          task={task}
          entry={entry}
          onOpen={() => onOpenSubagent(entry.id)}
          onDiagramDrawn={onDiagramDrawn}
        />
      );
    case "message":
      return entry.incoming ? (
        <div className={styles.message}>
          <div className={styles.messageFrom}>
            <T>Task from the parent agent</T>
          </div>
          <div className={styles.user}>
            <ReferencedText text={entry.text} cwd={task.cwd} />
          </div>
        </div>
      ) : (
        <div>
          <div className={styles.messageFrom}>
            <T>Report to the parent agent</T>
          </div>
          <AgentReply text={entry.text} cwd={task.cwd} task={task} onDiagramDrawn={onDiagramDrawn} />
        </div>
      );
    case "permission":
      // Waiting for an answer, it is asked above the composer; the conversation keeps the record.
      return entry.chosen || entry.questions?.length ? <PermissionLine task={task} entry={entry} /> : null;
    case "question":
      return (
        <div className={clsx(styles.permissionLine, entry.chosen ? styles.permissionDone : styles.permissionAsking)}>
          <Icon name={!entry.chosen ? "warning" : entry.chosen === "Skipped" ? "minus" : "check"} size={14} />
          <div className={styles.permissionBody}>
            <span className={styles.permissionTitle}>{entry.title}</span>
            {entry.chosen && (
              <span className={styles.permissionRecord}>
                {entry.chosen === "Skipped" ? <T>Skipped</T> : entry.chosen}
              </span>
            )}
          </div>
        </div>
      );
    case "error":
      return (
        <div className={styles.error} role="alert">
          <Icon name="error" size={14} />
          <AgentErrorText message={entry.message} />
        </div>
      );
  }
});

function AgentErrorText({ message }: { message: string }) {
  return <span>{useAgentErrorText(message)}</span>;
}

function UserMessage({
  task,
  entry,
  turn,
  turnCount,
}: {
  task: AgentTask;
  entry: UserEntry;
  turn: number | null;
  turnCount: number;
}) {
  const [editing, setEditing] = useState(false);
  const failed = (title: string) => (e: unknown) => notifications().notify({ level: "error", title, body: String(e) });
  const fail = failed("Couldn't send the message");
  const archived = task.status === "archived";
  const idle = !archived && !isBusy(task.status) && turn !== null;
  const { fork = false, rollback = false } = task.capabilities ?? {};
  // Editing and running again from a message need an agent that can drop turns.
  const inPlace = !archived && rollback && turn !== null;
  // A copy up to an earlier turn drops the later ones from the copied session.
  const canFork = idle && fork && (rollback || turn === turnCount - 1);
  const text = userMessageText(entry.text);
  if (editing && turn !== null) {
    return (
      <MessageEditor
        initial={text}
        initialImages={entry.images ?? []}
        later={turn < turnCount - 1}
        onCancel={() => setEditing(false)}
        onSend={async (text, images) => {
          if (await rerunFrom(task.id, turn, text, images)) setEditing(false);
        }}
      />
    );
  }
  const images = entry.images ?? [];
  // Images are listed after the files in `attachments` and shown as thumbnails instead.
  // Files mentioned in the text are chips there already.
  const mentioned = new Set(
    messageTokens(text).flatMap((t) => {
      const m = t.kind === "file" ? parseMention(t.value) : null;
      return m ? [basename(m.rel.replace(/\/$/, ""))] : [];
    }),
  );
  const files = entry.attachments.slice(0, entry.attachments.length - images.length).filter((a) => !mentioned.has(a));
  return (
    <div className={clsx(styles.message, styles.userMessage)}>
      {/* Actions and the time sit beside the author on hover: the reply under it has the turn's duration. */}
      <div className={styles.messageHead}>
        <MessageActions>
          <IconButton size="small" icon="copy" title="Copy" onClick={() => void copyText(text)} />
          {inPlace && entry.text && (
            <IconButton size="small" icon="edit" title="Edit" onClick={() => setEditing(true)} />
          )}
          {inPlace && (
            <IconButton
              size="small"
              icon="diff-revert"
              iconSize={14}
              title="Retract Message"
              action="agents.retractMessage"
              actionArg={{ task: task.id, turn }}
            />
          )}
          {!archived && entry.text && entry.attachments.length === 0 && (
            <IconButton
              size="small"
              icon="refresh"
              title={inPlace ? "Run Again From Here" : "Send Again"}
              onClick={() =>
                void (
                  inPlace ? rerunFrom(task.id, turn, entry.text, images) : resendMessage(task.id, entry.text)
                ).catch(fail)
              }
            />
          )}
          {canFork && (
            <IconButton
              size="small"
              icon="branch"
              title="Fork"
              onClick={() => void forkTask(task.id, turn + 1).catch(failed("Couldn't fork the task"))}
            />
          )}
        </MessageActions>
        <MessageTime sentMs={entry.sentMs ?? null} doneMs={null} />
        <span className={styles.role}>
          <T>You</T>
        </span>
      </div>
      <div className={styles.user}>
        <ReferencedText text={text} cwd={task.cwd} />
        <ImageStrip images={images} />
        {files.length > 0 && (
          <div className={styles.attachments}>
            {files.map((a, i) => (
              <span key={i} className={styles.attachment}>
                <Icon name={fileIconName(a)} size={12} />
                {a}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** An earlier message edited where it is: sending runs the conversation again from it. */
function MessageEditor({
  initial,
  initialImages,
  later,
  onCancel,
  onSend,
}: {
  initial: string;
  initialImages: AgentImage[];
  /** Turns follow it (they are dropped on send). */
  later: boolean;
  onCancel: () => void;
  onSend: (text: string, images: AgentImage[]) => Promise<void>;
}) {
  const tx = useTx();
  const [text, setText] = useState(initial);
  const [images, setImages] = useState(initialImages);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const send = async () => {
    if ((!text.trim() && images.length === 0) || pending.current) return;
    pending.current = true;
    setSending(true);
    setError(null);
    try {
      await onSend(text.trim(), images);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      notifications().notify({
        level: "error",
        title: "Couldn't send the message",
        body: String(e),
      });
    } finally {
      pending.current = false;
      setSending(false);
    }
  };
  return (
    <div className={styles.message}>
      <textarea
        className={styles.editMessage}
        value={text}
        rows={Math.min(Math.max(text.split("\n").length, 2), 12)}
        autoFocus
        readOnly={sending}
        aria-label={tx("Message")}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.currentTarget.setSelectionRange(text.length, text.length)}
        onKeyDown={(e) => {
          if (isImeKey(e.nativeEvent)) return;
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            if (!pending.current) onCancel();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <ImageStrip images={images} onRemove={sending ? undefined : (i) => setImages(images.filter((_, j) => j !== i))} />
      {error && (
        <div className={styles.error} role="alert">
          <Icon name="error" size={14} />
          <span>
            <T>Couldn't send the message</T>: {error}
          </span>
        </div>
      )}
      <div className={styles.editBar}>
        {later && (
          <span className={styles.muted}>
            <T>The messages after this one are replaced. Files the agent changed stay as they are.</T>
          </span>
        )}
        <span className={styles.editButtons}>
          <IconButton icon="close" title="Cancel" disabled={sending} onClick={onCancel} />
          <SubmitButton
            label="Send"
            pending={sending}
            disabled={(!text.trim() && images.length === 0) || sending}
            onClick={() => void send()}
          />
        </span>
      </div>
    </div>
  );
}

/** Image thumbnails; a click opens the full image, `onRemove` adds a remove button to each. */
function ImageStrip({ images, onRemove }: { images: AgentImage[]; onRemove?: (index: number) => void }) {
  const tx = useTx();
  const [open, setOpen] = useState<AgentImage | null>(null);
  if (images.length === 0) return null;
  return (
    <div className={styles.images}>
      {images.map((img, i) => (
        <span key={i} className={styles.imageItem}>
          <button
            type="button"
            className={styles.imageButton}
            title={img.name ?? undefined}
            onClick={() => setOpen(img)}
          >
            <img className={styles.image} src={imageSrc(img)} alt={img.name ?? tx("Image")} />
          </button>
          {onRemove && (
            <IconButton
              type="button"
              className={styles.removeImage}
              aria-label={tx("Remove Image")}
              onClick={() => onRemove(i)}
              icon="close"
              size="small"
            />
          )}
        </span>
      ))}
      <ImagePreview image={open} onClose={() => setOpen(null)} />
    </div>
  );
}
