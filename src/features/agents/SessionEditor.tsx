/** An agent task as an editor tab: the conversation, a composer and the task's changed files. */
import {
  createContext,
  Fragment,
  memo,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import clsx from "clsx";
import { useShallow } from "zustand/react/shallow";
import type {
  AgentChange,
  AgentEntry,
  AgentImage,
  AgentLimit,
  AgentQuestion,
  AgentRetry,
  AgentTask,
  AgentUsage,
} from "@/bindings";
import { executeAction } from "@/platform/actions";
import { call, commands, onIdeEvent } from "@/platform/ipc";
import { basename, relativeDir, useProject } from "@/platform/project";
import { notifications, useEditorShown, type EditorInput } from "@/workbench/contributions";
import { confirm } from "@/workbench/messages";
import {
  Button,
  Checkbox,
  EmptyState,
  Icon,
  IconButton,
  Input,
  InlineTag,
  Radio,
  SearchField,
  Spinner,
  T,
  Tabs,
  Tree,
  copyMenuFor,
  copyText,
  fileIconName,
  selectableText,
  useSelectionBoundary,
  showContextMenu,
  type IconName,
} from "@/ui";
import { useTx, tx } from "@/platform/i18n";
import { isImeKey } from "@/platform/ime";
import { openDiff, withChain, type DiffData } from "@/features/vcs/diffInput";
import { Composer } from "./Composer";
import { selectionIn } from "./selection";
import { SubmitButton } from "./SubmitButton";
import {
  canSend,
  costLabel,
  emptyDraft,
  limitLabel,
  messageTokens,
  retryParts,
  usageLabel,
  workTime,
} from "./composerModel";
import { ConfigPickers } from "./ConfigPickers";
import { findRanges, formatDuration, formatSentAt } from "./conversation";
import { ImagePreview, imageSrc } from "./ImagePreview";
import { useAgentSettings } from "./agentSettings";
import { foldedTurns, summarizeWork, workParts, type FoldedTurn, type WorkSummary } from "./timeline";
import { useRevealedText } from "./reveal";
import { AgentReply, MessageActions, ReplyActions } from "./AgentReply";
import {
  commandPrefix,
  permissionDetails,
  permissionOption,
  permissionResult,
  type PermissionEntry,
} from "./permission";
import { Markdown } from "./Markdown";
import { useAgentErrorText } from "./loginHint";
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
  replyTurns,
  replyTimes,
  type ReplyTimes,
  type ReplyTurn,
  type SubagentEntry,
} from "./model";
import {
  cancelTask,
  stopBackgroundTask,
  loadEntries,
  markVisible,
  refreshChanges,
  rollbackChanges,
  editQueued,
  forkTask,
  rerunFrom,
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
import { taskMenu } from "./taskActions";
import styles from "./Session.module.css";

export function SessionEditor({ input, docked = false }: { input: EditorInput; docked?: boolean }) {
  const id = (input.data as { task: string }).task;
  return <TaskSession key={id} id={id} docked={docked} />;
}

function TaskSession({ id, docked }: { id: string; docked: boolean }) {
  const task = useAgents((s) => s.tasks.get(id));
  const entries = useAgents((s) => s.entries.get(id));
  const changes = useAgents((s) => s.changes.get(id));
  const project = useProject((s) => s.project);
  const head = useLocalHead(
    task?.isolation === "local" ? task.status : null,
    project?.workspace ? (task?.projectRoot ?? project.root) : null,
  );
  const [changesOpen, setChangesOpen] = useChangesOpen(id, changes ?? null, docked);
  // The subagent conversation shown, with the subagents that lead to it (empty: the task's own).
  const [path, setPath] = useState<string[]>([]);
  const view = path.at(-1) ?? null;
  const viewEntries = useAgents((s) => s.entries.get(entriesKey(id, view)));
  const loadError = useAgents((s) => s.entryLoads.get(entriesKey(id, view))?.error);
  // Each subagent's card, from its parent's conversation.
  const cards = useAgents(
    useShallow((s) => path.map((sub, i) => findSubagent(s.entries.get(entriesKey(id, path[i - 1] ?? null)), sub))),
  );
  // Connecting to the project's agents clears what was loaded before: a tab restored with the
  // project reads its conversation once that is done, not before (#2414).
  const connected = useAgents((s) => s.loaded);
  useEffect(() => {
    if (!connected) return;
    // Loaded entries are kept current by the task's events: reopening the tab needn't fetch them again.
    if (!useAgents.getState().entries.has(id)) void loadEntries(id).catch(() => undefined);
    void refreshChanges(id);
  }, [id, connected]);
  // A kept-alive tab stays mounted behind the shown one: it isn't read there, nor searched.
  const shown = useEditorShown();
  useEffect(() => {
    if (shown && (!docked || !changesOpen)) return markVisible(id);
  }, [id, docked, changesOpen, shown]);
  useEffect(() => {
    if (connected && view && !useAgents.getState().entries.has(entriesKey(id, view))) {
      void loadEntries(id, view).catch(() => undefined);
    }
  }, [id, view, connected]);
  const openSubagent = useCallback((sub: string) => setPath((p) => [...p, sub]), []);
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
      className={clsx(styles.session, docked && styles.docked)}
      onFocusCapture={() => setFocusedSession(session)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null) && focusedSession() === session) {
          setFocusedSession(null);
        }
      }}
    >
      <div className={styles.conversation} hidden={docked && changesOpen}>
        {view && <SubagentBar task={task} path={path} cards={cards} onNavigate={setPath} />}
        <FoldedContent.Provider value={finding && shown}>
          <Stream
            key={view ?? ""}
            task={task}
            entries={viewEntries ?? null}
            loadError={loadError}
            subagent={view ? (cards.at(-1) ?? null) : null}
            onOpenSubagent={openSubagent}
            finding={finding && shown}
            findFocus={findFocus}
            onCloseFind={() => setFinding(false)}
          />
        </FoldedContent.Provider>
        {view ? (
          <div className={styles.readOnly}>
            <T>Subagents take their instructions from the agent that started them.</T>
          </div>
        ) : (
          <>
            <QuestionCard task={task} entries={entries ?? null} />
            <SessionComposer
              task={task}
              entries={entries ?? null}
              head={head}
              changes={changes ?? null}
              changesOpen={changesOpen}
              onToggleChanges={() => setChangesOpen(!changesOpen)}
              onOpenSubagent={openSubagent}
            />
          </>
        )}
      </div>
      {changesOpen && (
        <ChangesPane
          task={task}
          changes={changes ?? null}
          head={head}
          docked={docked}
          onHide={() => setChangesOpen(false)}
        />
      )}
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
function useLocalHead(status: AgentTask["status"] | null, root: string | null): string | null {
  const [head, setHead] = useState<string | null>(null);
  const local = status !== null;
  useEffect(() => {
    if (!local) return;
    let live = true;
    const load = () =>
      void call(commands.vcsBranchInfo(root)).then(
        (b) => live && setHead(b.head ?? b.headCommit?.slice(0, 8) ?? null),
        () => live && setHead(null),
      );
    load();
    const off = onIdeEvent("vcsChanged", load);
    return () => {
      live = false;
      off();
    };
  }, [local, status, root]);
  return local ? head : null;
}

/** The task's terminal, at the end of its status line. */
function StatusActions({ task }: { task: AgentTask }) {
  return (
    <span className={styles.statusActions}>
      <IconButton
        size="small"
        icon="terminal"
        title="Terminal"
        onClick={() => void executeAction("terminal.openAt", task.cwd)}
      />
    </span>
  );
}

/** The task's agent, model, checkout and state, just above the composer. */
function SessionStatus({
  task,
  entries,
  head,
}: {
  task: AgentTask;
  entries: AgentEntry[] | null;
  head: string | null;
}) {
  const tx = useTx();
  const project = useProject((s) => s.project);
  const projectName = project?.workspace ? basename(task.projectRoot ?? project.root) : null;
  const where = task.isolation === "worktree" ? branchLabel(task.branch) : null;
  const pickedModel = task.status !== "archived" && task.config.some((o) => o.category === "model");
  return (
    <div
      className={styles.statusBar}
      onContextMenu={(e) => {
        e.preventDefault();
        showContextMenu(e, taskMenu([task]));
      }}
    >
      <Icon name={providerIcon(task.provider)} size={13} className={styles.providerIcon} />
      <span className={styles.statusText} title={task.cwd}>
        {providerName(task.provider)}
        {/* The composer's model picker shows the model when the agent offers one. */}
        {task.model && !pickedModel ? ` · ${task.model}` : ""}
        {projectName ? ` · ${projectName}` : ""}
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
      <Meters task={task} entries={entries} />
      <StatusActions task={task} />
    </div>
  );
}

/**
 * Context use, usage limits and cost (when the agent reports them) and the time spent on
 * the task, each as Settings › Agents › Chat allows.
 */
function Meters({ task, entries }: { task: AgentTask; entries: AgentEntry[] | null }) {
  const tx = useTx();
  const show = useProject((s) => s.settings?.agents);
  const busy = isBusy(task.status);
  const now = useNow(busy ? 1000 : 60_000);
  const usage = show?.showContextUsage !== false ? task.usage : null;
  const reported = useAgents((s) => s.limits.get(task.provider));
  const limits = show?.showUsageLimits !== false ? (reported ?? []) : [];
  const cost = show?.showCost === true ? task.usage?.cost : null;
  const work = show?.showWorkTime !== false && entries ? workTime(entries, busy ? now : null) : 0;
  return (
    <span className={styles.meters}>
      {usage && <Usage usage={usage} />}
      {limits.map((l) => (
        <Limit key={l.window} limit={l} now={now} />
      ))}
      {cost && <span title={tx("What the session has cost so far, as the agent reports it")}>{costLabel(cost)}</span>}
      {work >= 1000 && <span title={tx("Time the agent spent on this task")}>{formatDuration(work)}</span>}
    </span>
  );
}

/** A usage-limit window: "5h 19%", when it resets in the tooltip. */
function Limit({ limit, now }: { limit: AgentLimit; now: number }) {
  const label = limitLabel(limit, now);
  return (
    <span className={styles.meter} title={label.detail} aria-label={label.detail}>
      <span className={styles.usageBar} aria-hidden>
        <span style={{ width: `${label.percent}%` }} />
      </span>
      {label.short}
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
      <IconButton icon="arrow-left" title="Back" onClick={() => onNavigate(path.slice(0, -1))} />
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
        <IconButton icon="stop" title="Stop Subagent" onClick={() => void cancelTask(task.id, card.id)} />
      )}
    </div>
  );
}

/**
 * Lets the rows of a long conversation skip rendering while off screen (`data-measured`, see
 * the CSS), so showing the tab again or restyling it costs what is on screen, not the whole
 * history. A row skips only once it was laid out: it keeps its real height, and scrolling up
 * doesn't jump (WebKit has no scroll anchoring). A new width lays them out again once it
 * settles; Find in Conversation (`enabled` false) needs every row laid out.
 */
function useOffscreenRows(ref: RefObject<HTMLElement | null>, visible: boolean, enabled: boolean) {
  // The width the marked rows were laid out at.
  const width = useRef(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const unmark = () => {
      for (const row of el.querySelectorAll(`:scope > .${styles.conversationRow}[data-measured]`)) {
        row.removeAttribute("data-measured");
      }
    };
    if (!enabled) return unmark();
    if (!visible) return;
    let frame = 0;
    let timer: number | undefined;
    const mark = () => {
      cancelAnimationFrame(frame);
      // The next frame lays the new rows out (and remembers their size); mark them after it.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          for (const row of el.querySelectorAll(`:scope > .${styles.conversationRow}:not([data-measured])`)) {
            row.setAttribute("data-measured", "");
          }
        });
      });
    };
    const remeasure = () => {
      if (el.clientWidth === width.current) return;
      width.current = el.clientWidth;
      unmark();
    };
    remeasure();
    mark();
    const rows = new MutationObserver(mark);
    rows.observe(el, { childList: true });
    const resize = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        remeasure();
        mark();
      }, 200);
    });
    resize.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      rows.disconnect();
      resize.disconnect();
    };
  }, [ref, visible, enabled]);
}

interface StreamProps {
  task: AgentTask;
  entries: AgentEntry[] | null;
  loadError?: string | null;
  /** The card of the subagent whose conversation this is; `null`: the task's own. */
  subagent: SubagentEntry | null;
  onOpenSubagent: (id: string) => void;
  finding: boolean;
  /** Bumped by Find in Conversation: focus the find field again. */
  findFocus: number;
  onCloseFind: () => void;
}

/** Entries rendered at a time when a conversation opens at its end. */
const ENTRY_BATCH = 40;

function scrollsInside(target: EventTarget | null, root: HTMLElement): boolean {
  for (let el = target instanceof Element ? target : null; el && el !== root; el = el.parentElement) {
    if (el.scrollTop <= 0) continue;
    const overflow = getComputedStyle(el).overflowY;
    if (overflow === "auto" || overflow === "scroll") return true;
  }
  return false;
}

function Stream({ loadError, task, entries, subagent, onOpenSubagent, finding, findFocus, onCloseFind }: StreamProps) {
  const ref = useRef<HTMLDivElement>(null);
  useSelectionBoundary(ref);
  const [openFolds] = useState(() => new Map<string, boolean>());
  const key = entriesKey(task.id, subagent?.id ?? null);
  const positions = useAgents.getState().scrollPositions;
  const position = useRef(positions.get(key) ?? { top: 0, stick: true });
  const restored = useRef(false);
  const previousLength = useRef(entries?.length ?? 0);
  /** Scrolled away from the end: offer one click back to the latest message. */
  const [away, setAway] = useState(() => positions.get(key)?.stick === false);
  // Opened at the end, the last entries come first and the earlier ones follow in batches:
  // reopening a long conversation paints at once. A kept offset needs them all.
  const [shown, setShown] = useState(() => (positions.get(key)?.stick === false ? Infinity : ENTRY_BATCH));
  let start = finding || !entries ? 0 : Math.max(0, entries.length - shown);
  // Keep a process run intact so prepending never replaces the anchored row.
  while (entries && start > 0 && isProcessEntry(entries[start]!) && isProcessEntry(entries[start - 1]!)) start--;
  const dragging = useRef(false);
  // When the user last scrolled the conversation (wheel, touch, keys, the scrollbar, Find):
  // that leaves the end. WebKit also moves the offset back on its own while rows lay out,
  // which comes with a change of the content height; a scroll without one is meant too (the
  // scrollbar thumb, a jump), whatever moved it.
  const userScrolled = useRef(-Infinity);
  const seenHeight = useRef(0);
  const markUserScroll = useCallback(() => {
    userScrolled.current = performance.now();
  }, []);
  const touchY = useRef<number | null>(null);
  const scrollingUp = useRef(false);
  // Release before the browser scrolls: a streamed chunk can arrive before its scroll event.
  const stopFollowing = useCallback(
    (target: EventTarget | null) => {
      const el = ref.current;
      if (!el || el.scrollHeight <= el.clientHeight || scrollsInside(target, el)) return;
      scrollingUp.current = true;
      if (!position.current.stick) return;
      position.current = { top: el.scrollTop, stick: false };
      positions.set(key, position.current);
      setAway(true);
    },
    [key, positions],
  );
  // Earlier entries are prepended above the view: remember where the first painted row is
  // so the content stays put and the scrollbar doesn't jump under the pointer.
  const anchor = useRef<{ el: Element; top: number } | null>(null);
  const loadEarlier = useCallback(() => {
    const el = ref.current;
    if (!el || start <= 0 || dragging.current || anchor.current) return;
    const first = el.firstElementChild;
    if (!position.current.stick && first) anchor.current = { el: first, top: first.getBoundingClientRect().top };
    startTransition(() => setShown((n) => n + ENTRY_BATCH));
  }, [start]);
  const loadTimer = useRef<number | null>(null);
  /** Load the next batch once the user stops scrolling near the top. */
  const loadWhenStill = useCallback(() => {
    if (loadTimer.current !== null) window.clearTimeout(loadTimer.current);
    loadTimer.current = window.setTimeout(() => {
      loadTimer.current = null;
      loadEarlier();
    }, 120);
  }, [loadEarlier]);
  useEffect(() => {
    const down = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) return;
      dragging.current = true;
      if (loadTimer.current !== null) window.clearTimeout(loadTimer.current);
    };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      if (ref.current && (position.current.stick || ref.current.scrollTop < 120)) loadWhenStill();
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    window.addEventListener("blur", up);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      window.removeEventListener("blur", up);
      if (loadTimer.current !== null) window.clearTimeout(loadTimer.current);
    };
  }, [loadWhenStill]);
  useEffect(() => {
    // Following the end, paint the rest in the background. A user who scrolled away
    // gets them only after stopping near the top (`loadWhenStill`), so the scrollbar
    // is not resized mid-drag.
    if (start > 0 && position.current.stick && !dragging.current)
      startTransition(() => setShown((n) => n + ENTRY_BATCH));
  }, [start]);
  // Hidden behind another tab, it has no layout to scroll; shown again, it follows the end again.
  const visible = useEditorShown();
  useOffscreenRows(ref, visible, !finding);
  /** A diagram that drew after the last streamed chunk grows the conversation: keep following. */
  const onDiagramDrawn = useCallback(() => {
    const el = ref.current;
    if (el && position.current.stick && !dragging.current) el.scrollTop = el.scrollHeight;
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || entries === null || !visible) return;
    const truncated = entries.length < previousLength.current;
    // A message the user just sent: back to the end, where it shows, wherever they had scrolled.
    const sent = previousLength.current > 0 && entries.slice(previousLength.current).some((e) => e.type === "user");
    previousLength.current = entries.length;
    if (sent && !position.current.stick) {
      scrollingUp.current = false;
      position.current = { top: el.scrollTop, stick: true };
      positions.set(key, position.current);
      setAway(false);
      return;
    }
    if ((truncated || entries.length === 0) && el.scrollHeight - el.scrollTop - el.clientHeight < 40) {
      scrollingUp.current = false;
      position.current = { top: el.scrollTop, stick: true };
      positions.set(key, position.current);
      setAway(false);
    }
  }, [entries, visible, key, positions]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || entries === null || !visible) return;
    if (position.current.stick) {
      if (!dragging.current) el.scrollTop = el.scrollHeight;
    } else if (!restored.current) el.scrollTop = position.current.top;
    restored.current = true;
  });
  useLayoutEffect(() => {
    // Prepending earlier entries moved the first painted row down: follow it, so the same
    // text stays on screen. Rows appended below leave it in place and shift nothing.
    const scroller = ref.current;
    const from = anchor.current;
    if (!scroller || !from) return;
    anchor.current = null;
    if (position.current.stick || !from.el.isConnected) return;
    scroller.scrollTop += from.el.getBoundingClientRect().top - from.top;
  });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (position.current.stick && !dragging.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (restored.current) positions.set(key, { ...position.current, top: el.scrollTop });
    };
  }, [key, positions]);
  /** Back to the end of the stream; following resumes from there. */
  const jumpToLatest = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    scrollingUp.current = false;
    position.current = { top: el.scrollTop, stick: true };
    if (typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = el.scrollHeight;
    setAway(false);
    el.focus({ preventScroll: true });
  }, []);
  // Forks and undo apply to the task's own turns, not a subagent's conversation.
  const turns = useMemo(() => (entries && !subagent ? turnNumbers(entries) : null), [entries, subagent]);
  const replies = useMemo(() => (entries && !subagent ? replyTurns(entries) : null), [entries, subagent]);
  const times = useMemo(() => (entries && !subagent ? replyTimes(entries) : null), [entries, subagent]);
  const busy = subagent ? subagentWorking(subagent.status) : isBusy(task.status);
  const lastIndex = entries ? entries.length - 1 : -1;
  // Keep the row stable when earlier history is prepended; its author can move with the work.
  const { foldTurns, toolCalls } = useAgentSettings();
  const rows = useMemo(() => {
    if (!entries) return [];
    const rows = conversationRows(entries, start, toolCalls === "grouped");
    return foldTurns && !finding ? foldTurnRows(rows, foldedTurns(entries, start, busy)) : rows;
  }, [entries, start, busy, foldTurns, toolCalls, finding]);
  const authorHeaders = useMemo(() => {
    const headers = new Set<number>();
    const byAgent = (row: ConversationRow) =>
      row.kind !== "entry" ||
      (row.entry.type !== "user" &&
        row.entry.type !== "subagent" &&
        !(row.entry.type === "message" && row.entry.incoming));
    rows.forEach((row, i) => {
      const previous = rows[i - 1];
      if (byAgent(row) && (!previous || !byAgent(previous))) headers.add(row.index);
    });
    return headers;
  }, [rows]);
  const renderRow = useCallback(
    (row: EntryRow) => (
      <Entry
        key={row.index}
        task={task}
        entry={row.entry}
        turn={turns?.get(row.index) ?? null}
        turnCount={turns?.size ?? 0}
        reply={replies?.get(row.index)}
        time={times?.get(row.index) ?? null}
        working={row.index === lastIndex && busy}
        onOpenSubagent={onOpenSubagent}
        onDiagramDrawn={onDiagramDrawn}
      />
    ),
    [task, turns, replies, times, lastIndex, busy, onOpenSubagent, onDiagramDrawn],
  );
  const renderConversationRow = (row: ConversationRow): ReactNode =>
    row.kind === "turn" ? (
      <TurnFold row={row} entries={entries ?? []}>
        {row.rows.map((inner) => (
          <div key={inner.index} className={styles.conversationRow}>
            {renderConversationRow(inner)}
          </div>
        ))}
      </TurnFold>
    ) : row.kind === "process" ? (
      <ProcessRun row={row} task={task} lastIndex={lastIndex} busy={busy} onDiagramDrawn={onDiagramDrawn} />
    ) : (
      renderRow(row)
    );
  return (
    <OpenFolds.Provider value={openFolds}>
      <div className={styles.streamArea}>
        {finding && <FindBar streamRef={ref} focus={findFocus} onClose={onCloseFind} />}
        <div
          ref={ref}
          // The conversation is read and copied like a document; focusable so ⌘F reaches it.
          className={clsx(styles.stream, selectableText)}
          tabIndex={-1}
          onWheel={(e) => {
            markUserScroll();
            if (e.deltaY < 0 && !e.ctrlKey && !e.defaultPrevented) stopFollowing(e.target);
            else if (e.deltaY > 0 && !e.ctrlKey && !e.defaultPrevented) scrollingUp.current = false;
          }}
          onTouchStart={(e) => {
            touchY.current = e.touches.length === 1 ? e.touches[0]!.clientY : null;
          }}
          onTouchMove={(e) => {
            markUserScroll();
            const y = e.touches.length === 1 ? e.touches[0]!.clientY : null;
            if (y !== null && touchY.current !== null && y > touchY.current) stopFollowing(e.target);
            else if (y !== null && touchY.current !== null && y < touchY.current) scrollingUp.current = false;
            touchY.current = y;
          }}
          onKeyDown={(e) => {
            markUserScroll();
            if (e.defaultPrevented || (e.target as Element).closest("input, textarea, [contenteditable]")) return;
            if (e.key === "ArrowUp" || e.key === "PageUp" || e.key === "Home" || (e.key === " " && e.shiftKey))
              stopFollowing(e.target);
            else if (e.key === "ArrowDown" || e.key === "PageDown" || e.key === "End" || (e.key === " " && !e.shiftKey))
              scrollingUp.current = false;
          }}
          onPointerDown={() => {
            markUserScroll();
            scrollingUp.current = false;
          }}
          onScroll={(e) => {
            const el = e.currentTarget;
            const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            const laidOut = el.scrollHeight !== seenHeight.current;
            seenHeight.current = el.scrollHeight;
            const byUser = dragging.current || performance.now() - userScrolled.current < 500 || !laidOut;
            const movedDown = el.scrollTop > position.current.top;
            const stayedAtEnd = position.current.stick && el.scrollTop === position.current.top;
            const stick =
              (atEnd && !scrollingUp.current && (movedDown || stayedAtEnd)) || (position.current.stick && !byUser);
            // Still following: back to the end the offset was moved away from.
            if (stick && !atEnd && !dragging.current) el.scrollTop = el.scrollHeight;
            position.current = { top: el.scrollTop, stick };
            positions.set(key, position.current);
            setAway(!position.current.stick);
            // Reached the top of what is painted: fetch the earlier entries, but only
            // once the drag has settled.
            if (loadTimer.current !== null) window.clearTimeout(loadTimer.current);
            if (!position.current.stick && el.scrollTop < 120 && !dragging.current) loadWhenStill();
          }}
          // Copy, plus Quote for a selection: replies to it in the composer.
          onContextMenu={(e) => {
            const text = selectionIn(e.currentTarget);
            const items = copyMenuFor(e.target) ?? [];
            if (text.trim() && task.status !== "archived") {
              items.push({
                kind: "action",
                action: "agents.quoteReply",
                label: "Quote",
                arg: { task: task.id, text },
              });
            }
            if (!items.length) return;
            e.preventDefault();
            showContextMenu(e, items);
          }}
        >
          {loadError && (
            <div role="alert">
              <EmptyState
                title={tx`Couldn't load the conversation: ${loadError}`}
                actions={
                  <Button
                    onClick={() =>
                      void executeAction("agents.retryConversation", {
                        task: task.id,
                        subagent: subagent?.id ?? null,
                      })
                    }
                  >
                    Retry
                  </Button>
                }
              />
            </div>
          )}
          {entries === null ? (
            !loadError && <Spinner />
          ) : entries.length === 0 && !busy && !loadError ? (
            <EmptyState title="No conversation history" />
          ) : (
            rows.map((row) => (
              <div
                key={row.index}
                className={styles.conversationRow}
                data-message={
                  (row.kind === "entry" && (row.entry.type === "user" || row.entry.type === "agent")) || undefined
                }
                data-process={row.kind !== "entry" || row.entry.type !== "user" || undefined}
              >
                {authorHeaders.has(row.index) && (
                  <div className={styles.agentAuthor}>
                    <div className={styles.role}>
                      <Icon name={providerIcon(task.provider)} size={13} />
                      <span>{providerName(task.provider)}</span>
                    </div>
                  </div>
                )}
                {renderConversationRow(row)}
              </div>
            ))
          )}
          <WorkingRow task={task} entries={entries} subagent={subagent} />
        </div>
        {away && !!entries?.length && <JumpToLatest onJump={jumpToLatest} />}
      </div>
    </OpenFolds.Provider>
  );
}

type UserEntry = Extract<AgentEntry, { type: "user" }>;

/** Message text with file references and skills as tags, distinct from prose. */
function MessageText({ text }: { text: string }) {
  return (
    <>
      {messageTokens(text).map((token, i) =>
        token.kind === "text" ? (
          <Fragment key={i}>{token.value}</Fragment>
        ) : (
          <InlineTag key={i} accent={token.kind === "command"}>
            {token.value}
          </InlineTag>
        ),
      )}
    </>
  );
}

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

/** One click back to the stream's end. */
function JumpToLatest({ onJump }: { onJump: () => void }) {
  return (
    <IconButton
      className={styles.jumpToLatest}
      title="Jump to Latest"
      icon="arrow-down"
      action="agents.jumpToLatest"
      actionArg={{ onJump }}
    />
  );
}

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
    observer.observe(stream, {
      subtree: true,
      childList: true,
      characterData: true,
    });
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

/** The first line of reasoning, without its Markdown emphasis: what a folded thought was about. */
export function thoughtPreview(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line
    .replace(/^\s*(#+\s*|[-*]\s+)?/, "")
    .replace(/[*_`]+/g, "")
    .trim();
}

/** The agent's reasoning: open while it streams, folded after, as Settings › Agents › Chat says. */
function ThoughtEntry({
  task,
  text,
  working,
  onDiagramDrawn,
}: {
  task: AgentTask;
  text: string;
  working: boolean;
  onDiagramDrawn: () => void;
}) {
  const { thinking, smoothText } = useAgentSettings();
  const open = thinking === "expanded" || (thinking === "auto" && working);
  // Streaming reasoning in view is revealed at the reply's pace; folded, nothing is painted.
  const shown = useRevealedText(text, working && smoothText && open);
  useLayoutEffect(() => {
    if (working && open) onDiagramDrawn();
  }, [shown, working, open, onDiagramDrawn]);
  return (
    <div className={styles.process}>
      <Fold
        className={clsx(styles.thought, thinking === "auto" && working && styles.thoughtLive)}
        open={open}
        summary={
          <summary>
            <Icon name="chevron-right" size={12} className={styles.thoughtChevron} />
            {working ? (
              <span className={styles.shimmer}>
                <T>Thinking</T>
              </span>
            ) : (
              <span className={styles.thoughtPreview}>{thoughtPreview(text) || <T>Reasoning</T>}</span>
            )}
          </summary>
        }
      >
        <div className={styles.thoughtBody}>
          <Markdown text={shown} cwd={task.cwd} onDiagramDrawn={onDiagramDrawn} />
        </div>
      </Fold>
    </div>
  );
}

const Entry = memo(function Entry({
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
            <MessageText text={entry.text} />
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
  if (editing && turn !== null) {
    return (
      <MessageEditor
        initial={entry.text}
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
  const files = entry.attachments.slice(0, entry.attachments.length - images.length);
  return (
    <div className={clsx(styles.message, styles.userMessage)}>
      {/* Actions and the time sit beside the author on hover: the reply under it has the turn's duration. */}
      <div className={styles.messageHead}>
        <MessageActions>
          <IconButton size="small" icon="copy" title="Copy" onClick={() => void copyText(entry.text)} />
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
        <MessageText text={entry.text} />
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
            <button
              type="button"
              className={styles.removeImage}
              aria-label={tx("Remove Image")}
              onClick={() => onRemove(i)}
            >
              <Icon name="close" size={10} />
            </button>
          )}
        </span>
      ))}
      <ImagePreview image={open} onClose={() => setOpen(null)} />
    </div>
  );
}

type ToolEntryData = Extract<AgentEntry, { type: "tool" }>;

/** An entry and its index in the whole conversation (not in the painted tail). */
type IndexedEntry = { index: number; entry: AgentEntry };

/** A row of the conversation: an entry, or a run of reasoning/tool calls folded together. */
type ConversationRow =
  | { kind: "entry"; index: number; entry: AgentEntry }
  | { kind: "process"; index: number; entries: IndexedEntry[] }
  /** A finished turn's work before its reply, folded into one line under its message. */
  | { kind: "turn"; index: number; turn: FoldedTurn; rows: ConversationRow[] };

type EntryRow = Extract<ConversationRow, { kind: "entry" }>;

const liveTool = (entry: AgentEntry) =>
  entry.type === "tool" && (entry.status === "running" || entry.status === "pending");

/**
 * Reasoning and tool calls fold together, running ones included: the run keeps its place while
 * a call finishes, and its summary line says what is running.
 */
const isProcessEntry = (entry: AgentEntry) => entry.type === "thought" || entry.type === "tool";

/**
 * The conversation's rows from `from`: a run of reasoning and finished tool calls becomes
 * one folded row (the work behind a decision), so messages and decisions stay readable.
 */
export function conversationRows(entries: readonly AgentEntry[], from: number, group = true): ConversationRow[] {
  if (!group) return entries.slice(from).map((entry, i) => ({ kind: "entry", index: from + i, entry }));
  const rows: ConversationRow[] = [];
  let run: IndexedEntry[] = [];
  const flush = () => {
    if (run.length > 1) rows.push({ kind: "process", index: run[0]!.index, entries: run });
    else if (run.length === 1) rows.push({ kind: "entry", ...run[0]! });
    run = [];
  };
  entries.slice(from).forEach((entry, i) => {
    if (isProcessEntry(entry)) run.push({ index: from + i, entry });
    else {
      flush();
      rows.push({ kind: "entry", index: from + i, entry });
    }
  });
  flush();
  return rows;
}

/** `rows` with the work of each turn in `turns` (keyed by its message) folded into one row. */
export function foldTurnRows(rows: ConversationRow[], turns: ReadonlyMap<number, FoldedTurn>): ConversationRow[] {
  if (!turns.size) return rows;
  const out: ConversationRow[] = [];
  let open: Extract<ConversationRow, { kind: "turn" }> | null = null;
  for (const row of rows) {
    if (open && row.index < open.turn.reply) {
      open.rows.push(row);
      continue;
    }
    open = null;
    out.push(row);
    const turn = row.kind === "entry" ? turns.get(row.index) : undefined;
    if (turn) {
      open = { kind: "turn", index: row.index + 1, turn, rows: [] };
      out.push(open);
    }
  }
  return out;
}

/** "Edited 2 files · Read 4 files": what a run of work did; "Reasoning" when it only thought. */
function workSummaryText(work: WorkSummary, tx: ReturnType<typeof useTx>, toolCalls: number): string[] {
  const parts = workParts(work).map((p) => tx(p.text).replace("{count}", String(p.count)));
  if (!parts.length && toolCalls) parts.push(`${toolCalls} ${tx(toolCalls === 1 ? "tool call" : "tool calls")}`);
  if (!parts.length && work.thoughts) parts.push(tx("Reasoning"));
  return parts;
}

/** A finished turn's work, folded under its message: one line saying what it did and for how long. */
function TurnFold({
  row,
  entries,
  children,
}: {
  row: Extract<ConversationRow, { kind: "turn" }>;
  entries: readonly AgentEntry[];
  children: ReactNode;
}) {
  const tx = useTx();
  const { turn } = row;
  const work = summarizeWork(entries.slice(turn.user + 1, turn.reply));
  const parts = workSummaryText(work, tx, 0);
  const messages = entries.slice(turn.user + 1, turn.reply).filter((e) => e.type === "agent").length;
  if (messages) parts.push(tx(messages === 1 ? "1 message" : "{count} messages").replace("{count}", String(messages)));
  const took = turn.sentMs != null && turn.doneMs != null ? formatDuration(turn.doneMs - turn.sentMs) : null;
  return (
    <Fold
      id={`turn:${turn.user}`}
      className={clsx(styles.turnFold, styles.process)}
      summary={
        <summary className={styles.processSummary}>
          <Icon name="chevron-right" size={12} className={styles.processChevron} />
          <span className={styles.processParts}>{parts.join(" · ")}</span>
          {work.added > 0 && <span className={styles.added}>+{work.added}</span>}
          {work.removed > 0 && <span className={styles.removed}>−{work.removed}</span>}
          {took && <span className={styles.muted}>{took}</span>}
        </summary>
      }
    >
      <div className={styles.turnBody}>{children}</div>
    </Fold>
  );
}

/** Reasoning and tool calls between messages, folded into one row. */
const ProcessRun = memo(function ProcessRun({
  row,
  task,
  lastIndex,
  busy,
  onDiagramDrawn,
}: {
  row: Extract<ConversationRow, { kind: "process" }>;
  task: AgentTask;
  lastIndex: number;
  busy: boolean;
  onDiagramDrawn: () => void;
}) {
  const tx = useTx();
  const tools = row.entries.filter(
    (item): item is IndexedEntry & { entry: ToolEntryData } => item.entry.type === "tool",
  );
  const work = summarizeWork(row.entries.map(({ entry }) => entry));
  const { added, removed } = work;
  const working = busy && row.entries.some(({ index }) => index === lastIndex);
  const parts = workSummaryText(work, tx, tools.length);
  // What the run is doing now: the call still running, or the reasoning it ends with.
  const live = [...tools].reverse().find(({ entry }) => liveTool(entry))?.entry;
  const last = row.entries.at(-1)!.entry;
  const current = live
    ? shortTitle(task, live.title || live.kind)
    : working && last.type === "thought"
      ? tx("Thinking")
      : null;
  // While the run grows, its open body follows the latest call unless scrolled up.
  const body = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    const el = body.current;
    if (el && working && following.current) el.scrollTop = el.scrollHeight;
  });
  return (
    <Fold
      id={`run:${row.index}`}
      className={clsx(styles.processRun, styles.process)}
      summary={
        <summary className={styles.processSummary}>
          <Icon name="chevron-right" size={12} className={styles.processChevron} />
          <span className={clsx(styles.processParts, (working || live) && styles.shimmer)}>{parts.join(" · ")}</span>
          {added > 0 && <span className={styles.added}>+{added}</span>}
          {removed > 0 && <span className={styles.removed}>−{removed}</span>}
          {current && <span className={clsx(styles.processCurrent, styles.shimmer)}>{current}</span>}
        </summary>
      }
    >
      <div
        ref={body}
        className={styles.processBody}
        onScroll={(e) => {
          const el = e.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {row.entries.map(({ index, entry }) =>
          entry.type === "tool" ? (
            <ToolEntry key={index} task={task} entry={entry} />
          ) : entry.type === "thought" ? (
            <ThoughtEntry
              key={index}
              task={task}
              text={entry.text}
              working={busy && index === lastIndex}
              onDiagramDrawn={onDiagramDrawn}
            />
          ) : null,
        )}
      </div>
    </Fold>
  );
});

/** Set while Find in Conversation is open: folded sections render their content, so it is found. */
const FoldedContent = createContext(false);

/**
 * Which keyed folds of a conversation the reader opened. A fold's row can remount (a run
 * grows from one call to two, a finished turn folds its work away); this keeps it as it was.
 */
const OpenFolds = createContext<Map<string, boolean> | null>(null);

/**
 * A collapsed section that renders its content only once opened: most of a long conversation
 * stays folded, and keeping it out of the DOM keeps showing and restyling the tab cheap.
 */
function Fold({
  id,
  className,
  open,
  summary,
  children,
}: {
  /** Remembers whether the reader opened it across remounts (`OpenFolds`). */
  id?: string;
  className?: string;
  open?: boolean;
  summary: ReactElement;
  children: ReactNode;
}) {
  const always = useContext(FoldedContent);
  const remembered = useContext(OpenFolds);
  const [expanded, setExpanded] = useState(() => !!open || (!!id && !!remembered?.get(id)));
  return (
    <details
      className={className}
      open={open || (!!id && expanded) || undefined}
      onToggle={(e) => {
        const now = e.currentTarget.open;
        setExpanded(now);
        if (id && remembered) {
          if (now) remembered.set(id, true);
          else remembered.delete(id);
        }
      }}
    >
      {summary}
      {(expanded || open || always) && children}
    </details>
  );
}

const ToolEntry = memo(function ToolEntry({
  task,
  entry,
}: {
  task: AgentTask;
  entry: Extract<AgentEntry, { type: "tool" }>;
}) {
  const { expandToolOutput } = useAgentSettings();
  const head = (
    <>
      <Icon name={TOOL_ICONS[entry.kind] ?? "run"} size={14} />
      <span className={clsx(styles.toolTitle, liveTool(entry) && styles.shimmer)} title={entry.title || entry.kind}>
        {shortTitle(task, entry.title || entry.kind)}
      </span>
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
      {entry.status === "failed" && <Icon name="error" size={12} />}
    </>
  );
  if (!entry.output)
    return (
      <div className={styles.process}>
        <div className={styles.tool}>{head}</div>
      </div>
    );
  return (
    <div className={styles.process}>
      <Fold
        className={styles.toolDetails}
        open={liveTool(entry) || expandToolOutput}
        summary={
          <summary className={styles.tool}>
            <Icon name="chevron-right" size={12} className={styles.toolChevron} />
            {head}
          </summary>
        }
      >
        <pre className={styles.output}>{entry.output}</pre>
      </Fold>
    </div>
  );
});

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
function SubagentCard({
  task,
  entry,
  onOpen,
  onDiagramDrawn,
}: {
  task: AgentTask;
  entry: SubagentEntry;
  onOpen: () => void;
  onDiagramDrawn: () => void;
}) {
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
        <Fold
          className={styles.subagentSection}
          summary={
            <summary>
              <T>Task</T>
            </summary>
          }
        >
          <div className={styles.thoughtText}>{entry.prompt}</div>
        </Fold>
      )}
      {entry.reply && (
        <Fold
          className={styles.subagentSection}
          summary={
            <summary>
              <T>Result</T>
            </summary>
          }
        >
          <div className={styles.subagentReply}>
            <AgentReply text={entry.reply} cwd={task.cwd} task={task} onDiagramDrawn={onDiagramDrawn} />
          </div>
        </Fold>
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

/**
 * The answers to an open permission request. A request without options (some agents send
 * none) can still be cancelled, so the agent doesn't wait for an answer it can't get.
 */
function PermissionAnswers({
  task,
  entry,
  className,
}: {
  task: AgentTask;
  entry: PermissionEntry;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const { command } = permissionDetails(entry);
  const answer = (option: string | null) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    void respond(task.id, entry.id, option)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => {
        pending.current = false;
        setBusy(false);
      });
  };
  return (
    <span className={className}>
      {entry.options.length ? (
        entry.options.map((o) => {
          const { label, variant } = permissionOption(o, !!command);
          return (
            <Button
              key={o.id}
              variant={variant}
              className={styles.permissionOption}
              size="small"
              aria-label={label}
              title={o.name}
              disabled={busy}
              onClick={() => answer(o.id)}
            >
              <span className={styles.permissionOptionLabel}>{label}</span>
            </Button>
          );
        })
      ) : (
        <Button variant="ghost" disabled={busy} onClick={() => answer(null)}>
          Cancel
        </Button>
      )}
      {error && (
        <span className={styles.error} role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

/** A single inline decision, reduced to a compact record after it is answered. */
function PermissionLine({ task, entry }: { task: AgentTask; entry: PermissionEntry }) {
  const tx = useTx();
  const ref = useRef<HTMLDivElement>(null);
  const hadFocus = useRef(false);
  const { title, detail, command } = permissionDetails(entry, providerName(task.provider));
  const result = permissionResult(entry);
  useLayoutEffect(() => {
    if (entry.chosen && hadFocus.current && document.activeElement === document.body)
      ref.current?.focus({ preventScroll: true });
  }, [entry.chosen]);
  return (
    <div
      ref={ref}
      role="region"
      aria-label={title}
      tabIndex={entry.chosen ? -1 : undefined}
      onFocusCapture={() => {
        hadFocus.current = true;
      }}
      onBlurCapture={(e) => {
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) hadFocus.current = false;
      }}
      className={clsx(styles.permissionLine, entry.chosen ? styles.permissionDone : styles.permissionAsking)}
    >
      <Icon name={!entry.chosen ? "warning" : result.allowed ? "check" : "minus"} size={14} />
      <div className={styles.permissionBody}>
        {entry.chosen ? (
          <span className={styles.permissionRecord} title={detail}>
            {result.label}:{" "}
            <span className={command ? styles.permissionPrefix : undefined}>
              {command ? commandPrefix(command) : shortTitle(task, detail)}
            </span>
          </span>
        ) : (
          <>
            <span className={styles.permissionTitle}>{title}</span>
            {command ? (
              <pre className={styles.permissionCommand} tabIndex={0} aria-label={tx("Command")}>
                <code>{command}</code>
              </pre>
            ) : (
              <span className={styles.permissionDetail}>{shortTitle(task, detail)}</span>
            )}
            {!entry.questions?.length && (
              <PermissionAnswers task={task} entry={entry} className={styles.permissionAnswers} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

interface QuestionAnswer {
  question: AgentQuestion;
  picked: string[];
  /** The typed answer; `null` while "Other" isn't chosen. */
  other: string | null;
}

const answerItems = ({ picked, other }: QuestionAnswer) => [...picked, ...(other?.trim() ? [other.trim()] : [])];

const isAnswered = (answer: QuestionAnswer) => answerItems(answer).length > 0 && answer.other?.trim() !== "";

const RECOMMENDED_SUFFIX = " (Recommended)";

const isRecommended = (label: string) => label.endsWith(RECOMMENDED_SUFFIX);

const plainLabel = (label: string) => (isRecommended(label) ? label.slice(0, -RECOMMENDED_SUFFIX.length) : label);

/** An open `AskUserQuestion` request, as a card above the composer; one question at a time. */
function QuestionCard({ task, entries }: { task: AgentTask; entries: AgentEntry[] | null }) {
  const entry = entries?.find(
    (candidate): candidate is PermissionEntry =>
      candidate.type === "permission" && !candidate.chosen && !!candidate.questions?.length,
  );
  return entry?.questions ? (
    <QuestionForm key={entry.id} task={task} entry={entry} questions={entry.questions} />
  ) : null;
}

function QuestionForm({
  task,
  entry,
  questions,
}: {
  task: AgentTask;
  entry: PermissionEntry;
  questions: AgentQuestion[];
}) {
  const [answers, setAnswers] = useState<QuestionAnswer[]>(() =>
    questions.map((question) => ({ question, picked: [], other: null })),
  );
  const [position, setPosition] = useState(0);
  const [hovered, setHovered] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const questionPrefix = useId();
  const panelsRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Paging with the buttons lands the keyboard focus on the question itself.
  const focusPanel = useRef(false);
  const multiple = answers.length > 1;
  const complete = answers.every(isAnswered);
  const questionId = (part: string, index: number) => `${questionPrefix}-${part}-${index}`;
  useEffect(() => {
    if (panelsRef.current) panelsRef.current.scrollTop = 0;
    if (!focusPanel.current) return;
    focusPanel.current = false;
    panelRef.current?.focus();
  }, [position]);
  const send = (option: string) => {
    setBusy(true);
    void respond(task.id, entry.id, option).finally(() => setBusy(false));
  };
  const submit = () =>
    send(
      JSON.stringify(
        Object.fromEntries(
          answers.map((answer) => [answer.question.answerKey ?? answer.question.question, answerItems(answer)]),
        ),
      ),
    );
  const update = (previous: QuestionAnswer, next: QuestionAnswer) =>
    setAnswers(answers.map((answer) => (answer === previous ? next : answer)));
  const choose = (answer: QuestionAnswer, label: string, checked: boolean) =>
    update(
      answer,
      answer.question.multiSelect
        ? {
            ...answer,
            picked: checked ? [...answer.picked, label] : answer.picked.filter((picked) => picked !== label),
          }
        : { ...answer, picked: [label], other: null },
    );
  const chooseOther = (answer: QuestionAnswer, checked: boolean) =>
    update(
      answer,
      answer.question.multiSelect ? { ...answer, other: checked ? "" : null } : { ...answer, picked: [], other: "" },
    );
  const chooseByNumber = (number: number) => {
    const answer = answers[position];
    if (!answer) return;
    const option = answer.question.options[number - 1];
    if (option) choose(answer, option.label, !answer.picked.includes(option.label));
    else if (number === answer.question.options.length + 1) chooseOther(answer, answer.other === null);
  };
  const goTo = (next: number, moveFocus = false) => {
    if (next < 0 || next >= answers.length) return;
    focusPanel.current = moveFocus;
    setPosition(next);
    setHovered(null);
  };
  return (
    <form
      className={styles.questionCard}
      aria-label={entry.title}
      onSubmit={(event) => {
        event.preventDefault();
        if (complete) submit();
      }}
      onKeyDown={(event) => {
        const typing = event.target instanceof HTMLInputElement && event.target.type === "text";
        if (event.key === "Escape") send("reject");
        else if (!typing && !event.ctrlKey && !event.metaKey && !event.altKey && /^[1-9]$/.test(event.key)) {
          event.preventDefault();
          chooseByNumber(Number(event.key));
        }
      }}
    >
      {multiple && (
        <div inert={busy}>
          <Tabs
            variant="compact"
            layout="squeeze"
            aria-label={entry.title}
            panelIdPrefix={questionPrefix}
            activeId={String(position)}
            onSelect={(id) => {
              if (!busy) goTo(Number(id));
            }}
            items={answers.map((item, index) => ({
              id: String(index),
              label: <span>{item.question.header?.trim() || item.question.question}</span>,
              text: item.question.header?.trim() || item.question.question,
              tooltip: item.question.question,
              trailing: isAnswered(item) ? (
                <Icon name="check" size={12} className={styles.questionTabCheck} />
              ) : undefined,
            }))}
          />
        </div>
      )}
      {/* All questions stay mounted in one grid cell, so the card keeps the tallest one's height. */}
      <div ref={panelsRef} className={clsx(styles.questionPanels, multiple && styles.questionPanelsPaged)}>
        {answers.map((item, index) => {
          const current = index === position;
          const group = questionId("group", index);
          const hasPreviews = item.question.options.some((option) => option.preview);
          const targetLabel = (current ? hovered : null) ?? item.picked[0] ?? (item.other !== null ? group : undefined);
          const previewed =
            targetLabel === undefined
              ? item.question.options.find((option) => option.preview)
              : item.question.options.find((option) => option.label === targetLabel);
          const choices = [
            ...item.question.options.map((option) => ({
              key: option.label,
              checked: item.picked.includes(option.label),
              onChange: (checked: boolean) => choose(item, option.label, checked),
              label: (
                <span className={styles.questionOptionText}>
                  <span className={styles.questionLabel}>
                    {plainLabel(option.label)}
                    {isRecommended(option.label) && (
                      <span className={styles.questionTag}>
                        <T>Recommended</T>
                      </span>
                    )}
                  </span>
                  {option.description && <span className={styles.questionDescription}>{option.description}</span>}
                </span>
              ),
            })),
            {
              key: group,
              checked: item.other !== null,
              onChange: (checked: boolean) => chooseOther(item, checked),
              label: (
                <span className={styles.questionLabel}>
                  <T>Other</T>
                </span>
              ),
            },
          ];
          return (
            <div
              key={group}
              ref={current ? panelRef : undefined}
              role={multiple ? "tabpanel" : undefined}
              id={questionId("panel", index)}
              aria-labelledby={multiple ? questionId("tab", index) : undefined}
              aria-hidden={!current}
              inert={!current}
              tabIndex={multiple && current ? 0 : -1}
              className={clsx(styles.questionPanel, !current && styles.questionPanelHidden)}
            >
              <fieldset className={styles.question} disabled={busy}>
                <legend className={styles.questionText}>
                  {item.question.header && <span className={styles.questionTag}>{item.question.header}</span>}
                  {item.question.question}
                </legend>
                <div className={clsx(styles.questionBody, hasPreviews && styles.questionBodyWithPreview)}>
                  <div className={styles.questionChoices}>
                    {choices.map((choice, choiceIndex) => {
                      const label = (
                        <span className={styles.questionChoice}>
                          {choice.label}
                          <span className={styles.questionKey}>{choiceIndex + 1}</span>
                        </span>
                      );
                      return (
                        <div
                          key={choice.key}
                          onMouseEnter={() => setHovered(choice.key)}
                          onMouseLeave={() => setHovered(null)}
                        >
                          {item.question.multiSelect ? (
                            <Checkbox
                              className={styles.questionOption}
                              checked={choice.checked}
                              label={label}
                              onChange={choice.onChange}
                            />
                          ) : (
                            <Radio
                              className={styles.questionOption}
                              name={group}
                              checked={choice.checked}
                              label={label}
                              onChange={() => choice.onChange(true)}
                            />
                          )}
                        </div>
                      );
                    })}
                    {item.other !== null && (
                      <Input
                        autoFocus
                        className={styles.questionOther}
                        value={item.other}
                        placeholder="Type your answer"
                        onChange={(event) => update(item, { ...item, other: event.target.value })}
                        onKeyDown={(event) => {
                          if (event.key === "Escape" && item.other) {
                            event.stopPropagation();
                            update(item, { ...item, other: "" });
                          }
                        }}
                      />
                    )}
                  </div>
                  {hasPreviews && (
                    <div className={styles.questionPreview}>
                      {[...item.question.options, null].map((option) => {
                        const shown = option === (previewed ?? null);
                        return (
                          <div
                            key={option?.label ?? group}
                            className={clsx(styles.questionPreviewItem, shown && styles.questionPreviewActive)}
                            aria-hidden={!shown}
                          >
                            <span className={styles.questionPreviewCaption}>
                              {option ? plainLabel(option.label) : <T>Other</T>}
                            </span>
                            {option?.preview ? (
                              <pre className={styles.questionPreviewBody}>{option.preview}</pre>
                            ) : (
                              <span className={styles.questionPreviewEmpty}>
                                <T>No preview</T>
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </fieldset>
            </div>
          );
        })}
      </div>
      <div className={styles.questionActions}>
        <Button variant="ghost" disabled={busy} onClick={() => send("reject")}>
          Skip
        </Button>
        {multiple && (
          <div className={styles.questionPager}>
            <Button size="small" disabled={busy || position === 0} onClick={() => goTo(position - 1, true)}>
              Previous
            </Button>
            <span className={styles.questionPage}>
              {position + 1} / {answers.length}
            </span>
            <Button
              size="small"
              disabled={busy || position === answers.length - 1}
              onClick={() => goTo(position + 1, true)}
            >
              Next
            </Button>
          </div>
        )}
        <Button type="submit" variant="primary" disabled={busy || !complete}>
          Submit
        </Button>
      </div>
    </form>
  );
}

/**
 * What needs the user or tells where the agent is, above the composer: an approval it
 * waits for (answered with 1, 2, 3… when the focus isn't in a text field), the plan, the
 * task's changes, then what runs and what is queued, and a line saying what it does now.
 */
function Tray({
  task,
  entries,
  changes,
  changesOpen,
  onToggleChanges,
  children,
}: {
  task: AgentTask;
  entries: AgentEntry[] | null;
  changes: AgentChange[] | null;
  changesOpen: boolean;
  onToggleChanges: () => void;
  children: ReactNode;
}) {
  const tx = useTx();
  const pending = entries?.find(
    (e): e is PermissionEntry => e.type === "permission" && !e.chosen && !e.questions?.length,
  );
  const plan = entries?.findLast((e): e is Extract<AgentEntry, { type: "plan" }> => e.type === "plan");
  const [planOpen, setPlanOpen] = useState(false);
  const done = plan?.items.filter((i) => i.status === "completed").length ?? 0;
  const planShown = plan && plan.items.length > 0 && done < plan.items.length;
  const added = changes?.reduce((n, c) => n + c.added, 0) ?? 0;
  const removed = changes?.reduce((n, c) => n + c.removed, 0) ?? 0;
  return (
    <div className={styles.tray}>
      {pending && <PendingPermission task={task} entry={pending} />}
      {(planShown || !!changes?.length) && (
        <div className={styles.trayStrip}>
          {planShown && (
            <button
              type="button"
              className={styles.trayChip}
              aria-expanded={planOpen}
              onClick={() => setPlanOpen(!planOpen)}
            >
              <Icon name="todo" size={13} />
              {tx`Plan ${done}/${plan.items.length}`}
            </button>
          )}
          {!!changes?.length && (
            <button type="button" className={styles.trayChip} aria-pressed={changesOpen} onClick={onToggleChanges}>
              <Icon name="edit" size={13} />
              {tx(changes.length === 1 ? "1 changed file" : "{count} changed files").replace(
                "{count}",
                String(changes.length),
              )}
              {added > 0 && <span className={styles.added}>+{added}</span>}
              {removed > 0 && <span className={styles.removed}>−{removed}</span>}
            </button>
          )}
        </div>
      )}
      {planShown && planOpen && (
        <div className={styles.trayPlan}>
          {plan.items.map((item, i) => (
            <div
              key={i}
              className={clsx(
                styles.planItem,
                item.status === "completed" && styles.planDone,
                item.status === "in_progress" && styles.planCurrent,
              )}
            >
              <Icon
                name={item.status === "completed" ? "check" : item.status === "in_progress" ? "run" : "minus"}
                size={12}
              />
              {item.content}
            </div>
          ))}
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * The end of the conversation while the agent works on it: what it is doing (starting, working,
 * retrying the API) and for how long. Hidden while it waits for an approval, which says so itself.
 */
function WorkingRow({
  task,
  entries,
  subagent,
}: {
  task: AgentTask;
  entries: AgentEntry[] | null;
  subagent: SubagentEntry | null;
}) {
  if (subagent) {
    if (!subagentWorking(subagent.status)) return null;
    return (
      <div className={styles.working} role="status">
        <Spinner size={12} />
        <T>{subagent.status === "needsInput" ? "Waiting for your answer…" : "Working…"}</T>
        {subagent.startedMs != null && <Elapsed since={subagent.startedMs} />}
      </div>
    );
  }
  if (task.status !== "running" && task.status !== "starting") return null;
  if (entries?.some((e) => e.type === "permission" && !e.chosen && !e.questions?.length)) return null;
  const lastUser = entries?.findLast((e): e is UserEntry => e.type === "user");
  return (
    <div className={styles.working} role="status">
      <Spinner size={12} />
      {task.retry ? (
        <Retrying retry={task.retry} />
      ) : (
        <T>{task.status === "starting" ? "Starting the agent…" : "Working…"}</T>
      )}
      {lastUser?.sentMs != null && !lastUser.doneMs && <Elapsed since={lastUser.sentMs} />}
    </div>
  );
}

/** The approval the agent waits for, with its answers on 1, 2, 3… */
function PendingPermission({ task, entry }: { task: AgentTask; entry: PermissionEntry }) {
  const ref = useRef<HTMLDivElement>(null);
  const shown = useEditorShown();
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current;
      if (!el || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      // Only while this session holds the focus: keys typed elsewhere never answer for it.
      if (!target || !el.closest(`.${styles.session}`)?.contains(target)) return;
      if (target.closest("input, textarea, [contenteditable='true'], .cm-editor")) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1) return;
      const button = el.querySelectorAll<HTMLButtonElement>(`.${styles.permissionOption}`)[n - 1];
      if (!button || button.disabled) return;
      e.preventDefault();
      button.click();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown]);
  // Answered, the card goes: the focus it had moves on to the composer.
  useLayoutEffect(() => {
    const el = ref.current;
    const area = el?.closest(`.${styles.composerArea}`);
    return () => {
      if (!el?.contains(document.activeElement) && document.activeElement !== document.body) return;
      requestAnimationFrame(() => {
        if (document.activeElement === document.body || !document.activeElement?.isConnected)
          area?.querySelector<HTMLElement>("textarea")?.focus({ preventScroll: true });
      });
    };
  }, []);
  return (
    <div ref={ref} className={styles.trayAsk}>
      <PermissionLine task={task} entry={entry} />
    </div>
  );
}

function SessionComposer({
  task,
  entries,
  head,
  changes,
  changesOpen,
  onToggleChanges,
  onOpenSubagent,
}: {
  task: AgentTask;
  entries: AgentEntry[] | null;
  head: string | null;
  changes: AgentChange[] | null;
  changesOpen: boolean;
  onToggleChanges: () => void;
  onOpenSubagent: (id: string) => void;
}) {
  const { sendWith, whileRunning } = useAgentSettings();
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
  // Only a running turn of an agent that takes messages mid-turn can be steered: otherwise
  // "now" would cancel the turn, so the message waits for it instead.
  const steers =
    whileRunning === "steer" &&
    !!task.capabilities?.steer &&
    task.status === "running" &&
    (composer.images.length === 0 || !!task.capabilities.images);
  const send = (now: boolean) => {
    if (!canSend(composer) || sending || task.status === "archived") return;
    setSending(true);
    sendMessage(task.id, now && (whileRunning !== "steer" || steers))
      .catch((e: unknown) =>
        notifications().notify({
          level: "error",
          title: "Couldn't send the message",
          body: String(e),
        }),
      )
      .finally(() => setSending(false));
  };
  const setOption = (id: string, value: string) =>
    void setTaskConfig(task.id, id, value).catch((e: unknown) =>
      notifications().notify({
        level: "error",
        title: "Couldn't change the setting",
        body: String(e),
      }),
    );
  return (
    <div className={styles.composerArea}>
      <SessionStatus task={task} entries={entries} head={head} />
      {task.status === "archived" && (
        <div className={styles.banner}>
          <span className={styles.bannerText}>
            <T>This task is archived. Unarchive it to continue the conversation.</T>
          </span>
          <IconButton
            icon="undo"
            title="Unarchive"
            onClick={() => void executeAction("agents.unarchiveTasks", [task.id])}
          />
        </div>
      )}
      <Tray task={task} entries={entries} changes={changes} changesOpen={changesOpen} onToggleChanges={onToggleChanges}>
        <WorkingSubagents entries={entries} onOpen={onOpenSubagent} />
        <BackgroundTasks task={task} />
        {task.queue.length > 0 && <Queue task={task} />}
      </Tray>
      <Composer
        id={task.id}
        placeholder={
          !busy
            ? "Reply to the agent"
            : steers
              ? "Send into the agent's turn"
              : whileRunning === "steer"
                ? "Queue a message for when the agent is done"
                : sendWith === "enter"
                  ? "Queue a message for when the agent is done (⌘↵ sends it now)"
                  : "Queue a message for when the agent is done (⌘⇧↵ sends it now)"
        }
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
            {busy && <IconButton icon="stop" title="Stop" onClick={() => void cancelTask(task.id)} />}
            <SubmitButton
              label={busy ? "Queue" : "Send"}
              pending={sending}
              variant={busy ? "secondary" : "primary"}
              disabled={!canSend(composer) || sending || task.status === "archived"}
              onClick={() => send(false)}
            />
          </>
        }
      />
    </div>
  );
}

/** Messages waiting for the turn to end: send now, edit, or drop. */
const BACKGROUND_ICON: Record<string, IconName> = {
  local_bash: "terminal",
  monitor: "eye",
};

/** What the agent runs in the background; its subagents show as chips of their own. */
function BackgroundTasks({ task }: { task: AgentTask }) {
  const tx = useTx();
  const running = (task.background ?? []).filter((background) => background.kind !== "local_agent");
  if (!running.length) return null;
  const fail = (e: unknown) =>
    notifications().notify({
      level: "error",
      title: "Couldn't stop the background task",
      body: String(e),
    });
  return (
    <div className={styles.background} aria-label={tx("Running in the background")}>
      {running.map((background) => (
        <div key={background.id} className={styles.backgroundTask}>
          <Icon name={BACKGROUND_ICON[background.kind] ?? "clock"} size={12} className={styles.muted} />
          <span className={styles.backgroundText} title={background.description}>
            {background.description || background.kind}
          </span>
          {background.startedMs != null && <Elapsed since={background.startedMs} />}
          {task.capabilities?.backgroundTasks && (
            <IconButton
              icon="stop"
              title="Stop"
              size="small"
              onClick={() => void stopBackgroundTask(task.id, background.id).catch(fail)}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function Queue({ task }: { task: AgentTask }) {
  const fail = (e: unknown) =>
    notifications().notify({
      level: "error",
      title: "Couldn't update the queue",
      body: String(e),
    });
  return (
    <div className={styles.queue} aria-label={tx("Queued messages")}>
      {task.queue.map((q) => (
        <div key={q.id} className={styles.queued}>
          <Icon name="pause" size={12} className={styles.muted} />
          <span className={styles.queuedText} title={q.prompt.text}>
            {q.prompt.text || <T>Image</T>}
          </span>
          <IconButton icon="arrow-up" title="Send now" onClick={() => void sendQueuedNow(task.id, q.id).catch(fail)} />
          <IconButton icon="edit" title="Edit" onClick={() => void editQueued(task.id, q.id).catch(fail)} />
          <IconButton icon="close" title="Remove" onClick={() => void removeQueued(task.id, q.id).catch(fail)} />
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

const CHANGES_OPEN_KEY = "openidea.agents.changesOpen.v1";

function loadChangesOpen(): Record<string, boolean> {
  try {
    const raw = globalThis.localStorage?.getItem(CHANGES_OPEN_KEY);
    const v: unknown = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" ? (v as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/**
 * Whether the Changes pane is shown for `task`: the user's choice once made, else
 * only while the task has changes. Docked sessions stay in the conversation until
 * the user explicitly opens changes; navigation there does not change editor preferences.
 */
function useChangesOpen(
  task: string,
  changes: AgentChange[] | null,
  docked: boolean,
): [boolean, (open: boolean) => void] {
  const [state, setState] = useState<{
    task: string;
    open: boolean | undefined;
  }>(() => ({
    task,
    open: docked ? false : loadChangesOpen()[task],
  }));
  const chosen = state.task === task ? state.open : docked ? false : loadChangesOpen()[task];
  const set = (open: boolean) => {
    setState({ task, open });
    if (docked) return;
    try {
      globalThis.localStorage?.setItem(CHANGES_OPEN_KEY, JSON.stringify({ ...loadChangesOpen(), [task]: open }));
    } catch {
      /* storage unavailable */
    }
  };
  return [chosen ?? (changes?.length ?? 0) > 0, set];
}

function ChangesPane({
  task,
  changes,
  head,
  docked,
  onHide,
}: {
  task: AgentTask;
  changes: AgentChange[] | null;
  head: string | null;
  docked: boolean;
  onHide: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const added = changes?.reduce((n, c) => n + c.added, 0) ?? 0;
  const removed = changes?.reduce((n, c) => n + c.removed, 0) ?? 0;
  const rollback = async () => {
    const chosen = (changes ?? []).filter((c) => selected.has(c.path));
    const count = chosen.length || changes?.length || 0;
    if (!count) return;
    const ok = await confirm({
      title: "Rollback Changes",
      message: (
        <>
          <p>
            {count === 1
              ? tx`Roll back the changes to ${basename((chosen[0] ?? changes![0]!).path)}?`
              : tx`Roll back the changes to ${count} files?`}
          </p>
          <p>
            {task.isolation === "worktree"
              ? tx("They go back to how they were when the task started, in the task's worktree.")
              : tx(
                  "They go back to how they were when the task started. Edits of yours made to them since then are lost too; edits from before the task are kept.",
                )}
          </p>
        </>
      ),
      ok: "Rollback",
      icon: "warning",
    });
    if (!ok) return;
    try {
      await rollbackChanges(task.id, chosen.length ? chosen.map((c) => c.relPath) : null);
      setSelected(new Set());
    } catch (e) {
      notifications().notify({
        level: "error",
        title: tx("Cannot roll back the changes"),
        body: e instanceof Error ? e.message : String(e),
      });
    }
  };
  return (
    <aside className={styles.changes} aria-label={tx("Changes")}>
      <div className={styles.changesHeader}>
        {docked && <IconButton icon="arrow-left" title="Back to conversation" onClick={onHide} />}
        <span className={styles.changesTitle}>
          <T>Changes</T>
        </span>
        {changes && changes.length > 0 && (
          <span className={styles.muted}>
            {changes.length} <T>{changes.length === 1 ? "file" : "files"}</T>
          </span>
        )}
        <span className={styles.bannerSpacer} />
        <IconButton
          icon="revert"
          title={selected.size ? "Rollback Selected Changes…" : "Rollback All Changes…"}
          disabled={!changes?.length || task.status === "starting" || task.status === "running"}
          onClick={() => void rollback()}
        />
        <IconButton icon="refresh" title="Refresh" onClick={() => void refreshChanges(task.id)} />
        {!docked && <IconButton icon="chevron-right" title={tx("Hide changes")} size="small" onClick={onHide} />}
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
                <Icon name={fileIconName(basename(c.path), c.path)} size={16} />
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
  const changed = (useAgents.getState().changes.get(task.id) ?? []).map((change) => change.path);
  const paths = changed.includes(path) ? changed : [path];
  const baseLabel = task.base ?? "Base";
  const right = task.isolation === "worktree" ? branchLabel(task.branch) : "Working tree";
  const diffs = await Promise.all(
    paths.map(async (file): Promise<DiffData> => {
      const base = await call(commands.agentBaseText(task.id, file)).catch(() => null);
      return {
        path: file,
        left: { type: "text", text: base ?? "", label: baseLabel },
        right: { type: "file", path: file, label: right },
        title: `${basename(file)} (${baseLabel} ↔ ${right})`,
      };
    }),
  );
  await openDiff(withChain(diffs, paths.indexOf(path)));
}
