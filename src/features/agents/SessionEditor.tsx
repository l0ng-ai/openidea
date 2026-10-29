/** An agent task as an editor tab: the conversation, a composer and the task's changed files. */
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import clsx from "clsx";
import { useShallow } from "zustand/react/shallow";
import type { AgentChange, AgentEntry, AgentRetry, AgentTask, AgentUsage } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { call, commands, onIdeEvent } from "@/platform/ipc";
import { basename, relativeDir, useProject } from "@/platform/project";
import { editorService, notifications, type EditorInput } from "@/workbench/contributions";
import {
  Button,
  EmptyState,
  Icon,
  IconButton,
  SearchField,
  Spinner,
  T,
  Tree,
  copyMenuFor,
  copyText,
  fileIconName,
  selectableText,
  showContextMenu,
} from "@/ui";
import { useTx, tx } from "@/platform/i18n";
import { isImeKey } from "@/platform/ime";
import { TaskStatusIcon } from "./AgentsView";
import { Composer } from "./Composer";
import { canSend, emptyDraft, retryParts, usageLabel, workTime } from "./composerModel";
import { ConfigPickers } from "./ConfigPickers";
import { findRanges, formatDuration, formatSentAt } from "./conversation";
import { Markdown } from "./Markdown";
import {
  branchLabel,
  entriesKey,
  findSubagent,
  isBusy,
  providerIcon,
  statusLabel,
  subagentStatusLabel,
  subagentTitle,
  subagentWorking,
  turnNumbers,
  type SubagentEntry,
} from "./model";
import {
  archiveTask,
  cancelTask,
  loadEntries,
  markVisible,
  refreshChanges,
  editQueued,
  forkTask,
  rerunFrom,
  quoteInComposer,
  removeQueued,
  resendMessage,
  respond,
  sendMessage,
  sendQueuedNow,
  setTaskConfig,
  useAgentCommands,
  useAgents,
} from "./store";
import { setFocusedSession, focusedSession, type FocusedSession } from "./sessionFocus";
import styles from "./Session.module.css";

export function SessionEditor({ input }: { input: EditorInput }) {
  const id = (input.data as { task: string }).task;
  const task = useAgents((s) => s.tasks.get(id));
  const entries = useAgents((s) => s.entries.get(id));
  const changes = useAgents((s) => s.changes.get(id));
  const head = useLocalHead(task?.isolation === "local" ? task.status : null);
  // The subagent conversation shown, with the subagents that lead to it (empty: the task's own).
  const [path, setPath] = useState<string[]>([]);
  const view = path.at(-1) ?? null;
  const viewEntries = useAgents((s) => s.entries.get(entriesKey(id, view)));
  // Each subagent's card, from its parent's conversation.
  const cards = useAgents(
    useShallow((s) => path.map((sub, i) => findSubagent(s.entries.get(entriesKey(id, path[i - 1] ?? null)), sub))),
  );
  useEffect(() => {
    void loadEntries(id).catch(() => undefined);
    void refreshChanges(id);
    return markVisible(id);
  }, [id]);
  useEffect(() => {
    if (view) void loadEntries(id, view).catch(() => undefined);
  }, [id, view]);
  const openSubagent = (sub: string) => setPath((p) => [...p, sub]);
  const [finding, setFinding] = useState(false);
  const [findFocus, setFindFocus] = useState(0);
  const [session] = useState<FocusedSession>(() => ({
    openFind: () => {
      setFinding(true);
      setFindFocus((n) => n + 1);
    },
  }));
  useEffect(
    () => () => {
      if (focusedSession() === session) setFocusedSession(null);
    },
    [session],
  );
  if (!task) return <EmptyState title="This agent task no longer exists" />;
  return (
    <div
      className={styles.session}
      onFocusCapture={() => setFocusedSession(session)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null) && focusedSession() === session) {
          setFocusedSession(null);
        }
      }}
    >
      <div className={styles.conversation}>
        <Header task={task} entries={entries ?? null} head={head} />
        {view && <SubagentBar task={task} path={path} cards={cards} onNavigate={setPath} />}
        <PermissionBanner task={task} entries={entries ?? null} />
        <Stream
          key={view ?? ""}
          task={task}
          entries={viewEntries ?? null}
          subagent={view ? (cards.at(-1) ?? null) : null}
          onOpenSubagent={openSubagent}
          finding={finding}
          findFocus={findFocus}
          onCloseFind={() => setFinding(false)}
        />
        {view ? (
          <div className={styles.readOnly}>
            <T>Subagents take their instructions from the agent that started them.</T>
          </div>
        ) : (
          <SessionComposer task={task} entries={entries ?? null} onOpenSubagent={openSubagent} />
        )}
      </div>
      <ChangesPane task={task} changes={changes ?? null} head={head} />
    </div>
  );
}

function providerName(id: string) {
  return useAgents.getState().providers.find((p) => p.id === id)?.name ?? id;
}

/**
 * Current branch of the project's repository for a local-checkout task (`status` is
 * `null` otherwise); followed as git changes, since the agent or the user may switch it.
 */
function useLocalHead(status: AgentTask["status"] | null): string | null {
  const [head, setHead] = useState<string | null>(null);
  const local = status !== null;
  useEffect(() => {
    if (!local) return;
    let live = true;
    const load = () =>
      void call(commands.vcsBranchInfo(null)).then(
        (b) => live && setHead(b.head ?? b.headCommit?.slice(0, 8) ?? null),
        () => live && setHead(null),
      );
    load();
    const off = onIdeEvent("vcsChanged", load);
    return () => {
      live = false;
      off();
    };
  }, [local, status]);
  return local ? head : null;
}

function Header({ task, entries, head }: { task: AgentTask; entries: AgentEntry[] | null; head: string | null }) {
  const busy = isBusy(task.status);
  const where = task.isolation === "worktree" ? branchLabel(task.branch) : null;
  return (
    <div className={styles.header}>
      <TaskStatusIcon status={task.status} />
      <span className={styles.title} title={task.title}>
        {task.title}
      </span>
      <span className={styles.headerDetail} title={task.cwd}>
        <Icon name={providerIcon(task.provider)} size={13} className={styles.providerIcon} />
        <span className={styles.headerText}>
          {providerName(task.provider)}
          {task.model ? ` · ${task.model}` : ""}
          {" · "}
          {where ?? (
            <>
              <T>Local checkout</T>
              {head ? ` · ${head}` : ""}
            </>
          )}
          {" · "}
          <T>{statusLabel(task.status)}</T>
          {task.status === "limited" && task.resetsMs != null && ` · ${tx`resets ${formatSentAt(task.resetsMs)}`}`}
        </span>
      </span>
      <Meters task={task} entries={entries} />
      {busy && <IconButton icon="stop" title="Stop" size="small" onClick={() => void cancelTask(task.id)} />}
      <IconButton
        icon="terminal"
        title="Open in Terminal"
        size="small"
        onClick={() => void executeAction("terminal.openAt", task.cwd)}
      />
      {!busy && task.status !== "archived" && task.capabilities?.fork && (
        <IconButton
          icon="branch"
          title="Copy to a New Task"
          size="small"
          onClick={() =>
            void forkTask(task.id, null).catch((e: unknown) =>
              notifications().notify({ level: "error", title: "Couldn't copy the task", body: String(e) }),
            )
          }
        />
      )}
      {!busy && task.status !== "archived" && (
        <IconButton icon="close" title="Archive Task" size="small" onClick={() => void archiveTask(task.id)} />
      )}
    </div>
  );
}

/** Context use (when the agent reports it) and the time spent on the task. */
function Meters({ task, entries }: { task: AgentTask; entries: AgentEntry[] | null }) {
  const tx = useTx();
  const busy = isBusy(task.status);
  const now = useNow(busy ? 1000 : 60_000);
  const usage = task.usage;
  const work = entries ? workTime(entries, busy ? now : null) : 0;
  return (
    <span className={styles.meters}>
      {usage && <Usage usage={usage} />}
      {work >= 1000 && <span title={tx("Time the agent spent on this task")}>{formatDuration(work)}</span>}
    </span>
  );
}

/** Context window use: "12%", the numbers in the tooltip. */
function Usage({ usage }: { usage: AgentUsage }) {
  const label = usageLabel(usage);
  return (
    <span className={styles.meter} title={label.detail} aria-label={`Context ${label.short}, ${label.detail}`}>
      <span className={styles.usageBar} aria-hidden>
        <span style={{ width: label.short }} />
      </span>
      {label.short}
    </span>
  );
}

/** `Date.now()`, updated every `interval` ms. */
function useNow(interval: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(t);
  }, [interval]);
  return now;
}

/** Where a subagent conversation sits: the way back to the task, and the subagent's state. */
function SubagentBar({
  task,
  path,
  cards,
  onNavigate,
}: {
  task: AgentTask;
  path: string[];
  cards: Array<SubagentEntry | undefined>;
  onNavigate: (path: string[]) => void;
}) {
  const tx = useTx();
  const card = cards.at(-1);
  return (
    <div className={styles.subagentBar}>
      <IconButton icon="arrow-left" title="Back" size="small" onClick={() => onNavigate(path.slice(0, -1))} />
      <nav className={styles.crumbs} aria-label={tx("Subagent")}>
        <button type="button" className={styles.crumb} onClick={() => onNavigate([])} title={task.title}>
          {task.title}
        </button>
        {path.map((sub, i) => {
          const title = cards[i] ? subagentTitle(cards[i]) : tx("Subagent");
          return (
            <Fragment key={sub}>
              <Icon name="chevron-right" size={12} className={styles.muted} />
              {i === path.length - 1 ? (
                <span className={styles.crumbCurrent} title={cards[i]?.description ?? title}>
                  {title}
                </span>
              ) : (
                <button type="button" className={styles.crumb} onClick={() => onNavigate(path.slice(0, i + 1))}>
                  {title}
                </button>
              )}
            </Fragment>
          );
        })}
      </nav>
      {card && (
        <span className={styles.muted}>
          <T>{subagentStatusLabel(card.status)}</T>
        </span>
      )}
      {card && subagentWorking(card.status) && card.cancellable && (
        <IconButton icon="stop" title="Stop Subagent" size="small" onClick={() => void cancelTask(task.id, card.id)} />
      )}
    </div>
  );
}

interface StreamProps {
  task: AgentTask;
  entries: AgentEntry[] | null;
  /** The card of the subagent whose conversation this is; `null`: the task's own. */
  subagent: SubagentEntry | null;
  onOpenSubagent: (id: string) => void;
  finding: boolean;
  /** Bumped by Find in Conversation: focus the find field again. */
  findFocus: number;
  onCloseFind: () => void;
}

function Stream({ task, entries, subagent, onOpenSubagent, finding, findFocus, onCloseFind }: StreamProps) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  const waiting = entries?.some((e) => e.type === "permission" && !e.chosen);
  const lastUser = entries?.findLast((e): e is UserEntry => e.type === "user");
  // Forks and undo apply to the task's own turns, not a subagent's conversation.
  const turns = useMemo(() => (entries && !subagent ? turnNumbers(entries) : null), [entries, subagent]);
  return (
    <div className={styles.streamArea}>
      {finding && <FindBar streamRef={ref} focus={findFocus} onClose={onCloseFind} />}
      <div
        ref={ref}
        // The conversation is read and copied like a document; focusable so ⌘F reaches it.
        className={clsx(styles.stream, selectableText)}
        tabIndex={-1}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        // Copy, plus Quote for a selection: replies to it in the composer.
        onContextMenu={(e) => {
          const text = selectionIn(e.currentTarget);
          const items = copyMenuFor(e.target) ?? [];
          if (text.trim() && task.status !== "archived") {
            items.push({ id: "quote", label: "Quote", icon: "edit", run: () => quoteInComposer(task.id, text) });
          }
          if (!items.length) return;
          e.preventDefault();
          showContextMenu(e, items);
        }}
      >
        {entries === null ? (
          <Spinner />
        ) : (
          entries.map((entry, i) => (
            <Entry
              key={i}
              task={task}
              entry={entry}
              turn={turns?.get(i) ?? null}
              turnCount={turns?.size ?? 0}
              onOpenSubagent={onOpenSubagent}
            />
          ))
        )}
        {subagent && subagentWorking(subagent.status) && (
          <div className={styles.working}>
            <Spinner size={12} />
            <T>{subagent.status === "needsInput" ? "Waiting for your answer…" : "Working…"}</T>
            {subagent.startedMs != null && <Elapsed since={subagent.startedMs} />}
          </div>
        )}
        {!subagent && (task.status === "running" || task.status === "starting") && !waiting && (
          <div className={styles.working}>
            <Spinner size={12} />
            {task.retry ? (
              <Retrying retry={task.retry} />
            ) : (
              <T>{task.status === "starting" ? "Starting the agent…" : "Working…"}</T>
            )}
            {lastUser?.sentMs != null && !lastUser.doneMs && <Elapsed since={lastUser.sentMs} />}
          </div>
        )}
      </div>
    </div>
  );
}

type UserEntry = Extract<AgentEntry, { type: "user" }>;

/** Time since `since`, ticking every second. */
/** The agent lost its API connection (or was refused) and retries on its own. */
function Retrying({ retry }: { retry: AgentRetry }) {
  const tx = useTx();
  const now = useNow(1000);
  const { attempt, wait } = retryParts(retry, now);
  return (
    <span className={styles.retrying} title={retry.error ?? undefined}>
      {wait > 0
        ? tx`API request failed, retrying in ${wait}s (attempt ${attempt})`
        : tx`API request failed, retrying (attempt ${attempt})`}
    </span>
  );
}

function Elapsed({ since }: { since: number }) {
  const now = useNow(1000);
  return <span className={styles.muted}>{formatDuration(now - since)}</span>;
}

/** Text selected in `stream`, or "" when the selection is elsewhere. */
function selectionIn(stream: HTMLElement): string {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return "";
  return stream.contains(sel.getRangeAt(0).commonAncestorContainer) ? sel.toString() : "";
}

interface RangeSet {
  clear(): void;
  add(range: Range): void;
}
const highlights = (globalThis as { CSS?: { highlights?: Map<string, RangeSet> } }).CSS?.highlights;
const HighlightCtor = (globalThis as { Highlight?: new () => RangeSet }).Highlight;

/**
 * Sets the ranges of highlight `name`. One registered highlight per name, changed in
 * place: WebKit doesn't repaint where a replaced highlight object was.
 */
function setHighlight(name: string, ranges: Range[]) {
  if (!highlights || !HighlightCtor) return;
  let set = highlights.get(name);
  if (!set) {
    set = new HighlightCtor();
    highlights.set(name, set);
  }
  set.clear();
  for (const r of ranges) set.add(r);
}

/** Scrolls `range` into view in `stream`, opening the collapsed tool output or thought holding it. */
function revealRange(range: Range, stream: HTMLElement) {
  for (let el = range.startContainer.parentElement; el && el !== stream; el = el.parentElement) {
    if (el instanceof HTMLDetailsElement) el.open = true;
  }
  const r = range.getBoundingClientRect();
  const box = stream.getBoundingClientRect();
  if (r.top < box.top + 24 || r.bottom > box.bottom - 24) {
    stream.scrollTop += r.top - box.top - box.height / 3;
  }
}

/** Find in Conversation: every match highlighted, Enter / ⇧Enter step through them. */
function FindBar({
  streamRef,
  focus,
  onClose,
}: {
  streamRef: RefObject<HTMLDivElement | null>;
  focus: number;
  onClose: () => void;
}) {
  const tx = useTx();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [ranges, setRanges] = useState<Range[]>([]);
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focus]);

  // Matches follow the conversation as it streams in (and as code gets highlighted).
  useEffect(() => {
    const stream = streamRef.current;
    if (!stream) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setRanges(findRanges(stream, query.trim())));
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(stream, { subtree: true, childList: true, characterData: true });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [query, streamRef]);

  const index = ranges.length ? Math.min(current, ranges.length - 1) : -1;
  // Expanding or collapsing a tool output shows or hides its matches.
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const stream = streamRef.current;
    const toggled = () => setShown((n) => n + 1);
    stream?.addEventListener("toggle", toggled, true);
    return () => stream?.removeEventListener("toggle", toggled, true);
  }, [streamRef]);
  useEffect(() => {
    // Only rendered matches: WebKit paints those in collapsed <details> over the text next to them.
    const visible = (r: Range) => r.getClientRects().length > 0;
    const current = index >= 0 ? ranges[index]! : null;
    setHighlight("agent-find", ranges.filter(visible));
    setHighlight("agent-find-current", current && visible(current) ? [current] : []);
  }, [ranges, index, shown]);
  useEffect(
    () => () => {
      setHighlight("agent-find", []);
      setHighlight("agent-find-current", []);
    },
    [],
  );

  const step = (dir: 1 | -1) => {
    const stream = streamRef.current;
    if (!ranges.length || !stream) return;
    const next = (index + dir + ranges.length) % ranges.length;
    setCurrent(next);
    revealRange(ranges[next]!, stream);
  };
  const close = () => {
    onClose();
    streamRef.current?.focus();
  };

  return (
    <div className={styles.findBar} role="search">
      <SearchField
        ref={input}
        value={query}
        onChange={(v) => {
          setQuery(v);
          setCurrent(0);
        }}
        aria-label={tx("Find in Conversation")}
        placeholder={tx("Find in conversation")}
        className={styles.findField}
        trailing={
          query.trim() ? (
            <span className={styles.findCount}>
              {ranges.length ? `${index + 1}/${ranges.length}` : tx("0 results")}
            </span>
          ) : null
        }
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
      />
      <IconButton
        icon="arrow-up"
        title={tx("Previous Occurrence")}
        size="small"
        disabled={!ranges.length}
        onClick={() => step(-1)}
      />
      <IconButton
        icon="arrow-down"
        title={tx("Next Occurrence")}
        size="small"
        disabled={!ranges.length}
        onClick={() => step(1)}
      />
      <IconButton icon="close" title={tx("Close")} size="small" onClick={close} />
    </div>
  );
}

const TOOL_ICONS: Record<string, string> = {
  read: "file",
  edit: "edit",
  delete: "minus",
  move: "edit",
  search: "search",
  execute: "terminal",
  fetch: "web",
  think: "todo",
};

function Entry({
  task,
  entry,
  turn,
  turnCount,
  onOpenSubagent,
}: {
  task: AgentTask;
  entry: AgentEntry;
  /** Number of the turn this message started (from 0), when it started one. */
  turn: number | null;
  turnCount: number;
  onOpenSubagent: (id: string) => void;
}) {
  switch (entry.type) {
    case "user":
      return <UserMessage task={task} entry={entry} turn={turn} turnCount={turnCount} />;
    case "agent":
      return <Markdown text={entry.text} cwd={task.cwd} />;
    case "thought":
      return (
        <details className={styles.thought}>
          <summary>
            <T>Thinking</T>
          </summary>
          <div className={styles.thoughtText}>{entry.text}</div>
        </details>
      );
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
      return <SubagentCard task={task} entry={entry} onOpen={() => onOpenSubagent(entry.id)} />;
    case "message":
      return entry.incoming ? (
        <div className={styles.message}>
          <div className={styles.messageFrom}>
            <T>Task from the parent agent</T>
          </div>
          <div className={styles.user}>{entry.text}</div>
        </div>
      ) : (
        <div>
          <div className={styles.messageFrom}>
            <T>Report to the parent agent</T>
          </div>
          <Markdown text={entry.text} cwd={task.cwd} />
        </div>
      );
    case "permission":
      return <PermissionLine task={task} entry={entry} />;
    case "error":
      return (
        <div className={styles.error} role="alert">
          <Icon name="error" size={14} />
          <span>{entry.message}</span>
        </div>
      );
  }
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
  const tx = useTx();
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
  if (editing && turn !== null) {
    return (
      <MessageEditor
        initial={entry.text}
        later={turn < turnCount - 1}
        onCancel={() => setEditing(false)}
        onSend={async (text) => {
          await rerunFrom(task.id, turn, text);
          setEditing(false);
        }}
      />
    );
  }
  return (
    <div className={styles.message}>
      <div className={styles.user}>
        {entry.text}
        {entry.attachments.length > 0 && (
          <div className={styles.attachments}>
            {entry.attachments.map((a, i) => (
              <span key={i} className={styles.attachment}>
                <Icon name={fileIconName(a)} size={12} />
                {a}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className={styles.messageMeta}>
        {entry.sentMs != null && (
          <span className={styles.muted} title={new Date(entry.sentMs).toLocaleString()}>
            {formatSentAt(entry.sentMs)}
          </span>
        )}
        {entry.sentMs != null && entry.doneMs != null && (
          <span className={styles.muted} title={tx("Time the agent took to answer")}>
            {` · ${formatDuration(entry.doneMs - entry.sentMs)}`}
          </span>
        )}
        <span className={styles.messageActions}>
          <IconButton icon="copy" title="Copy" size="small" onClick={() => void copyText(entry.text)} />
          {inPlace && entry.text && (
            <IconButton icon="edit" title="Edit" size="small" onClick={() => setEditing(true)} />
          )}
          {!archived && entry.text && entry.attachments.length === 0 && (
            <IconButton
              icon="refresh"
              title={inPlace ? "Run Again From Here" : "Send Again"}
              size="small"
              onClick={() =>
                void (inPlace ? rerunFrom(task.id, turn, entry.text) : resendMessage(task.id, entry.text)).catch(fail)
              }
            />
          )}
          {canFork && (
            <IconButton
              icon="branch"
              title="Copy to a New Task From Here"
              size="small"
              onClick={() => void forkTask(task.id, turn + 1).catch(failed("Couldn't copy the task"))}
            />
          )}
        </span>
      </div>
    </div>
  );
}

/** An earlier message edited where it is: sending runs the conversation again from it. */
function MessageEditor({
  initial,
  later,
  onCancel,
  onSend,
}: {
  initial: string;
  /** Turns follow it (they are dropped on send). */
  later: boolean;
  onCancel: () => void;
  onSend: (text: string) => Promise<void>;
}) {
  const tx = useTx();
  const [text, setText] = useState(initial);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const send = async () => {
    if (!text.trim() || pending.current) return;
    pending.current = true;
    setSending(true);
    setError(null);
    try {
      await onSend(text.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      notifications().notify({ level: "error", title: "Couldn't send the message", body: String(e) });
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
          <Button size="small" disabled={sending} onClick={onCancel}>
            Cancel
          </Button>
          <Button size="small" variant="primary" disabled={!text.trim() || sending} onClick={() => void send()}>
            {sending && <Spinner size={12} />}
            <T>Send</T>
          </Button>
        </span>
      </div>
    </div>
  );
}

function ToolEntry({ task, entry }: { task: AgentTask; entry: Extract<AgentEntry, { type: "tool" }> }) {
  const head = (
    <>
      <Icon name={TOOL_ICONS[entry.kind] ?? "run"} size={14} />
      <span className={styles.toolTitle}>{shortTitle(task, entry.title || entry.kind)}</span>
      {entry.diffs.map((d) => (
        <button
          key={d.path}
          type="button"
          className={styles.toolDiff}
          title={d.path}
          onClick={(e) => {
            e.preventDefault();
            void openChangeDiff(task, d.path);
          }}
        >
          <span className={styles.added}>+{d.added}</span> <span className={styles.removed}>−{d.removed}</span>
        </button>
      ))}
      {(entry.status === "running" || entry.status === "pending") && <Spinner size={12} />}
      {entry.status === "failed" && <Icon name="error" size={12} />}
    </>
  );
  if (!entry.output) return <div className={styles.tool}>{head}</div>;
  return (
    <details className={styles.toolDetails}>
      <summary className={styles.tool}>{head}</summary>
      <pre className={styles.output}>{entry.output}</pre>
    </details>
  );
}

function SubagentStatusIcon({ status }: { status: SubagentEntry["status"] }) {
  switch (status) {
    case "running":
      return <Spinner size={11} />;
    case "needsInput":
      return <Icon name="warning" size={13} label="Needs input" />;
    case "done":
      return <Icon name="check" size={13} className={styles.done} label="Done" />;
    case "cancelled":
      return <Icon name="minus" size={13} className={styles.muted} label="Stopped" />;
    case "failed":
      return <Icon name="close" size={13} className={styles.removed} label="Failed" />;
  }
}

/** A subagent in its parent's conversation: what it does, its latest step, what it was asked and answered. */
function SubagentCard({ task, entry, onOpen }: { task: AgentTask; entry: SubagentEntry; onOpen: () => void }) {
  const tx = useTx();
  const working = subagentWorking(entry.status);
  const now = useNow(working ? 1000 : 60_000);
  const time = entry.startedMs == null ? null : (entry.endedMs ?? now) - entry.startedMs;
  const title = subagentTitle(entry);
  return (
    <div className={styles.subagent}>
      <div className={styles.subagentHead}>
        <button
          type="button"
          className={styles.subagentOpen}
          onClick={onOpen}
          title={tx("Open the subagent's conversation")}
        >
          <SubagentStatusIcon status={entry.status} />
          <Icon name="toolwindow-agents" size={14} className={styles.muted} />
          <span className={styles.subagentTitle}>{title}</span>
          {entry.description && entry.description !== title && (
            <span className={styles.subagentDescription}>{entry.description}</span>
          )}
          <span className={styles.subagentMeta}>
            {[
              entry.tools > 0 && `${entry.tools} ${tx(entry.tools === 1 ? "tool call" : "tool calls")}`,
              time != null && formatDuration(Math.max(0, time)),
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <Icon name="chevron-right" size={12} className={styles.muted} />
        </button>
        {working && entry.cancellable && (
          <IconButton
            icon="stop"
            title="Stop Subagent"
            size="small"
            onClick={() => void cancelTask(task.id, entry.id)}
          />
        )}
      </div>
      {working && entry.activity && (
        <div className={styles.subagentActivity} title={entry.activity}>
          {shortTitle(task, entry.activity)}
        </div>
      )}
      {entry.error && (
        <div className={styles.error} role="alert">
          <Icon name="error" size={14} />
          <span>{entry.error}</span>
        </div>
      )}
      {entry.prompt && (
        <details className={styles.subagentSection}>
          <summary>
            <T>Task</T>
          </summary>
          <div className={styles.thoughtText}>{entry.prompt}</div>
        </details>
      )}
      {entry.reply && (
        <details className={styles.subagentSection}>
          <summary>
            <T>Result</T>
          </summary>
          <div className={styles.subagentReply}>
            <Markdown text={entry.reply} cwd={task.cwd} />
          </div>
        </details>
      )}
    </div>
  );
}

/** The subagents of the conversation still at work, to look in on. */
function WorkingSubagents({ entries, onOpen }: { entries: AgentEntry[] | null; onOpen: (id: string) => void }) {
  const tx = useTx();
  const working = (entries ?? []).filter((e): e is SubagentEntry => e.type === "subagent" && subagentWorking(e.status));
  if (!working.length) return null;
  return (
    <div className={styles.subagentStrip} aria-label={tx("Subagents at work")}>
      {working.map((e) => (
        <button
          key={e.id}
          type="button"
          className={styles.subagentChip}
          onClick={() => onOpen(e.id)}
          title={e.activity ?? undefined}
        >
          <SubagentStatusIcon status={e.status} />
          <span className={styles.subagentChipTitle}>{subagentTitle(e)}</span>
        </button>
      ))}
    </div>
  );
}

/** Agent-written titles with the task's own folder dropped from paths. */
const shortTitle = (task: AgentTask, title: string) => title.replaceAll(`${task.cwd}/`, "");

function PermissionLine({ task, entry }: { task: AgentTask; entry: Extract<AgentEntry, { type: "permission" }> }) {
  return (
    <div className={styles.permissionLine}>
      <Icon name={!entry.chosen ? "warning" : entry.chosen === "Cancelled" ? "minus" : "check"} size={13} />
      <span className={styles.permissionTitle}>{shortTitle(task, entry.title)}</span>
      <span className={styles.muted}>{entry.chosen ?? <T>Waiting for your answer</T>}</span>
    </div>
  );
}

/** The open permission request, as an editor notification banner above the conversation. */
function PermissionBanner({ task, entries }: { task: AgentTask; entries: AgentEntry[] | null }) {
  const [busy, setBusy] = useState(false);
  const entry = entries?.find(
    (e): e is Extract<AgentEntry, { type: "permission" }> => e.type === "permission" && !e.chosen,
  );
  if (!entry) return null;
  const answer = (option: string | null) => {
    setBusy(true);
    void respond(task.id, entry.id, option).finally(() => setBusy(false));
  };
  return (
    <div className={styles.banner} role="alert" aria-label={entry.title}>
      <Icon name="warning" size={16} />
      <span className={styles.bannerText} title={entry.title}>
        {shortTitle(task, entry.title)}
      </span>
      <span className={styles.bannerSpacer} />
      {entry.options.map((o) => (
        <button key={o.id} type="button" className={styles.bannerLink} disabled={busy} onClick={() => answer(o.id)}>
          {o.name}
        </button>
      ))}
    </div>
  );
}

function SessionComposer({
  task,
  entries,
  onOpenSubagent,
}: {
  task: AgentTask;
  entries: AgentEntry[] | null;
  onOpenSubagent: (id: string) => void;
}) {
  const project = useProject((s) => s.project);
  const composer = useAgents((s) => s.composers.get(task.id)) ?? emptyDraft();
  const [sending, setSending] = useState(false);
  const agentCommands = useAgentCommands(task.provider, task.id, task.commands);
  const busy = isBusy(task.status);
  // ↑ recalls this conversation's messages, newest first.
  const history = useMemo(
    () => (entries ?? []).flatMap((e) => (e.type === "user" && e.text ? [e.text] : [])).reverse(),
    [entries],
  );
  const send = (now: boolean) => {
    if (!canSend(composer) || sending || task.status === "archived") return;
    setSending(true);
    sendMessage(task.id, now)
      .catch((e: unknown) =>
        notifications().notify({ level: "error", title: "Couldn't send the message", body: String(e) }),
      )
      .finally(() => setSending(false));
  };
  const setOption = (id: string, value: string) =>
    void setTaskConfig(task.id, id, value).catch((e: unknown) =>
      notifications().notify({ level: "error", title: "Couldn't change the setting", body: String(e) }),
    );
  return (
    <div className={styles.composerArea}>
      <WorkingSubagents entries={entries} onOpen={onOpenSubagent} />
      {task.queue.length > 0 && <Queue task={task} />}
      <Composer
        id={task.id}
        placeholder={busy ? "Queue a message for when the agent is done (⌘↵ sends it now)" : "Reply to the agent"}
        root={task.cwd}
        projectRoot={project?.root ?? task.cwd}
        commands={agentCommands}
        history={history}
        config={task.config}
        onConfig={setOption}
        onSubmit={send}
        disabled={task.status === "archived"}
        toolbar={<ConfigPickers config={task.config} onChange={setOption} />}
        actions={
          <>
            {busy && (
              <Button size="small" icon="stop" onClick={() => void cancelTask(task.id)}>
                Stop
              </Button>
            )}
            <Button
              size="small"
              variant={busy ? "secondary" : "primary"}
              disabled={!canSend(composer) || sending || task.status === "archived"}
              onClick={() => send(false)}
            >
              {busy ? "Queue" : "Send"}
            </Button>
          </>
        }
      />
    </div>
  );
}

/** Messages waiting for the turn to end: send now, edit, or drop. */
function Queue({ task }: { task: AgentTask }) {
  const fail = (e: unknown) =>
    notifications().notify({ level: "error", title: "Couldn't update the queue", body: String(e) });
  return (
    <div className={styles.queue} aria-label={tx("Queued messages")}>
      {task.queue.map((q) => (
        <div key={q.id} className={styles.queued}>
          <Icon name="pause" size={12} className={styles.muted} />
          <span className={styles.queuedText} title={q.prompt.text}>
            {q.prompt.text || <T>Image</T>}
          </span>
          <button
            type="button"
            className={styles.bannerLink}
            onClick={() => void sendQueuedNow(task.id, q.id).catch(fail)}
          >
            <T>Send now</T>
          </button>
          <IconButton
            icon="edit"
            title="Edit"
            size="small"
            onClick={() => void editQueued(task.id, q.id).catch(fail)}
          />
          <IconButton
            icon="close"
            title="Remove"
            size="small"
            onClick={() => void removeQueued(task.id, q.id).catch(fail)}
          />
        </div>
      ))}
    </div>
  );
}

const KIND_COLOR: Partial<Record<AgentChange["kind"], string>> = {
  added: "var(--vcs-added)",
  untracked: "var(--vcs-untracked)",
  modified: "var(--vcs-modified)",
  renamed: "var(--vcs-modified)",
  deleted: "var(--vcs-deleted)",
  conflicted: "var(--vcs-conflict)",
};

function ChangesPane({ task, changes, head }: { task: AgentTask; changes: AgentChange[] | null; head: string | null }) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const added = changes?.reduce((n, c) => n + c.added, 0) ?? 0;
  const removed = changes?.reduce((n, c) => n + c.removed, 0) ?? 0;
  return (
    <aside className={styles.changes} aria-label={tx("Changes")}>
      <div className={styles.changesHeader}>
        <span className={styles.changesTitle}>
          <T>Changes</T>
        </span>
        {changes && changes.length > 0 && (
          <span className={styles.muted}>
            {changes.length} <T>{changes.length === 1 ? "file" : "files"}</T>
          </span>
        )}
        <span className={styles.bannerSpacer} />
        <IconButton icon="refresh" title="Refresh" size="small" onClick={() => void refreshChanges(task.id)} />
      </div>
      {(head ?? task.base) && (
        <div className={styles.changesSummary}>
          <T>vs</T> {head ?? task.base}
          {changes && changes.length > 0 && (
            <>
              {"  "}
              <span className={styles.added}>+{added}</span> <span className={styles.removed}>−{removed}</span>
            </>
          )}
        </div>
      )}
      <div className={styles.changesList}>
        {changes === null ? (
          <Spinner />
        ) : (
          <Tree<AgentChange>
            aria-label="Changed files"
            roots={changes}
            getKey={(c) => c.path}
            getLabel={(c) => basename(c.path)}
            getChildren={() => undefined}
            isExpandable={() => false}
            selected={selected}
            onSelectionChange={(sel) => setSelected(sel)}
            onActivate={(c) => void openChangeDiff(task, c.path)}
            renderNode={(c) => (
              <span className={styles.change} title={c.relPath}>
                <Icon name={fileIconName(basename(c.path))} size={16} />
                <span className={styles.changeName} style={{ color: KIND_COLOR[c.kind] }}>
                  {basename(c.path)}
                </span>
                <span className={styles.changeDir}>{relativeDir(task.cwd, c.path)}</span>
                <span className={styles.changeStat}>
                  <span className={styles.added}>+{c.added}</span> <span className={styles.removed}>−{c.removed}</span>
                </span>
              </span>
            )}
            empty={
              <div className={styles.changesEmpty}>
                <T>No changes yet</T>
              </div>
            }
          />
        )}
      </div>
    </aside>
  );
}

/** Opens the diff of `path` between the task's start and now. */
export async function openChangeDiff(task: AgentTask, path: string) {
  const base = await call(commands.agentBaseText(task.id, path)).catch(() => null);
  const baseLabel = task.base ?? "Base";
  const right = task.isolation === "worktree" ? branchLabel(task.branch) : "Working tree";
  await editorService().openInput(
    {
      kind: "diff",
      key: `diff:agent:${task.id}:${path}`,
      path,
      data: {
        path,
        left: { type: "text", text: base ?? "", label: baseLabel },
        right: { type: "file", path, label: right },
        title: `${basename(path)} (${baseLabel} ↔ ${right})`,
      },
    },
    { focus: true },
  );
}
