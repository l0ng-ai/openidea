/** An agent task as an editor tab: the conversation, a composer and the task's changed files. */
import type { AgentChange, AgentCommit, AgentEntry, AgentRetry, AgentTask } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { tx, useTx } from "@/platform/i18n";
import { onIdeEvent } from "@/platform/ipc";
import { isSameOrInside } from "@/platform/paths";
import { useProject } from "@/platform/project";
import {
  Button,
  copyMenuFor,
  EmptyState,
  Icon,
  IconButton,
  selectableText,
  showContextMenu,
  Spinner,
  T,
  useSelectionBoundary,
  type IconName,
} from "@/ui";
import { notifications, useEditorShown, type EditorInput } from "@/workbench/contributions";
import clsx from "clsx";
import {
  Fragment,
  memo,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { useChangesWidthStyle } from "./ChangesResizer";
import { Composer } from "./Composer";
import { ConfigPickers } from "./ConfigPickers";
import { McpPicker } from "./McpPicker";
import styles from "./Session.module.css";
import { SessionAssets } from "./SessionAssets";
import { SubmitButton } from "./SubmitButton";
import { useAgentSettings } from "./agentSettings";
import { useChangesOptions } from "./changesOptions";
import { canSend, emptyDraft, retryParts } from "./composerModel";
import { formatDuration } from "./conversation";
import { useEffortFocus } from "./effortFocus";
import { useAgentFontZoomSurface } from "./fontZoom";
import {
  entriesKey,
  findSubagent,
  isBusy,
  providerIcon,
  replyTimes,
  replyTurns,
  sessionKey,
  subagentStatusLabel,
  subagentTitle,
  subagentWorking,
  turnNumbers,
  type SubagentEntry,
} from "./model";
import { asksInCard, type PermissionEntry } from "./permission";
import { selectionIn } from "./selection";
import { ChangesPane, useChangesOpen, useLocalHead } from "./session/ChangesPane";
import { FindBar } from "./session/FindBar";
import { Fold, FoldedContent, OpenFolds, RevealFold } from "./session/Folds";
import { PermissionLine, QuestionCard } from "./session/QuestionForm";
import { SessionStatus } from "./session/SessionStatus";
import {
  conversationRows,
  foldTurnRows,
  isProcessEntry,
  liveTool,
  type ConversationRow,
  type EntryRow,
  type IndexedEntry,
  type ToolEntryData,
} from "./session/conversationRows";
import { Entry } from "./session/messages";
import { providerName, shortTitle, useNow, type UserEntry } from "./session/shared";
import { ThoughtEntry, ToolEntry, WorkingSubagents } from "./session/toolEntries";
import { focusedSession, setFocusedSession, type FocusedSession } from "./sessionFocus";
import {
  cancelTask,
  editQueued,
  loadEntries,
  markVisible,
  refreshChanges,
  removeQueued,
  scheduleChanges,
  sendMessage,
  sendQueuedNow,
  setTaskConfig,
  setTaskMcpOverrides,
  stopBackgroundTask,
  useAgentCommands,
  useAgents,
} from "./store";
import { foldedTurns, summarizeWork, workParts, type WorkSummary } from "./timeline";
import {
  ACTIVITY_STATUS,
  activityOf,
  PLAYFUL_MIN_MS,
  PLAYFUL_WORD_MS,
  PLAYFUL_WORDS,
  playfulIndex,
  progressKey,
  type Activity,
} from "./workingStatus";

export function SessionEditor({ input, docked = false }: { input: EditorInput; docked?: boolean }) {
  const id = (input.data as { task: string }).task;
  return <TaskSession key={id} id={id} docked={docked} />;
}

function TaskSession({ id, docked }: { id: string; docked: boolean }) {
  const task = useAgents((s) => s.tasks.get(id));
  const entries = useAgents((s) => s.entries.get(id));
  // Grouping needs commits of the task's own: local checkouts keep the flat list.
  const isolation = useAgents((s) => s.tasks.get(id)?.isolation);
  const grouped = useChangesOptions((s) => s.groupByCommit) && isolation === "worktree";
  const sinceStart = useAgents((s) => s.changes.get(id));
  const review = useAgents((s) => s.groupedChanges.get(id));
  const changes = grouped ? (review?.uncommitted ?? null) : (sinceStart ?? null);
  const commits = grouped ? (review?.commits ?? []) : [];
  const project = useProject((s) => s.project);
  const head = useLocalHead(
    task?.isolation === "local" ? task.status : null,
    project?.workspace ? (task?.projectRoot ?? project.root) : null,
  );
  const [changesOpen, setChangesOpen] = useChangesOpen(id, changes ?? null, docked);
  const changesWidth = useChangesWidthStyle();
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
  // A commit in the task's checkout moves its HEAD: pick it up without waiting for the agent.
  // The watcher reports every repository under the project, so the main checkout and other
  // tasks' worktrees would otherwise re-read this task's changes for nothing. A worktree's
  // gitdir is `<project>/.git/worktrees/<slug>`, outside the worktree itself: the watcher only
  // reports the project there, so that is the root its events match.
  const refreshRoot =
    task?.isolation === "worktree" ? (task.projectRoot ?? project?.root ?? null) : (task?.cwd ?? null);
  useEffect(() => {
    if (!connected) return;
    return onIdeEvent("vcsChanged", (e) => {
      if (!refreshRoot || !isSameOrInside(refreshRoot, e.root)) return;
      scheduleChanges(id);
    });
  }, [id, connected, refreshRoot]);
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
  const [inputFocus, setInputFocus] = useState(0);
  const { fitWindowWidth } = useAgentSettings();
  const sessionRoot = useRef<HTMLDivElement>(null);
  const { fontZoom, zoomStyle } = useAgentFontZoomSurface(sessionRoot, sessionKey(id), docked, !!task);
  const canFocusInput = shown && !!task && task.status !== "archived" && !view;
  const session = useMemo<FocusedSession>(
    () => ({
      openFind: () => {
        setFinding(true);
        setFindFocus((n) => n + 1);
      },
      focusInput: canFocusInput
        ? () => {
            if (docked) setChangesOpen(false);
            setInputFocus((n) => n + 1);
          }
        : undefined,
    }),
    [canFocusInput, docked, setChangesOpen],
  );
  useLayoutEffect(() => {
    if (shown && sessionRoot.current?.contains(document.activeElement)) setFocusedSession(session);
    return () => {
      if (focusedSession() === session) setFocusedSession(null);
    };
  }, [session, shown]);
  if (!task) return <EmptyState title="This agent task no longer exists" />;
  return (
    <div
      ref={sessionRoot}
      className={clsx(
        styles.session,
        docked && styles.docked,
        changesOpen && !docked && styles.withChanges,
        fitWindowWidth && styles.fitWidth,
      )}
      style={{ ...changesWidth, ...zoomStyle }}
      onFocusCapture={() => shown && setFocusedSession(session)}
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
            fontZoom={fontZoom}
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
              focusRequest={inputFocus}
              focusRoot={sessionRoot}
              entries={entries ?? null}
              head={head}
              changes={changes ?? null}
              commits={commits}
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
          commits={commits}
          grouped={grouped}
          head={head}
          docked={docked}
          onHide={() => setChangesOpen(false)}
        />
      )}
    </div>
  );
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
function useOffscreenRows(
  ref: RefObject<HTMLElement | null>,
  visible: boolean,
  enabled: boolean,
  fitWindowWidth: boolean,
  fontZoom: number,
) {
  // The container width, column mode and font zoom the marked rows were laid out at.
  const measured = useRef<{ width: number; fitWindowWidth: boolean; fontZoom: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const unmark = () => {
      for (const row of el.querySelectorAll(`:scope > .${styles.conversationRow}[data-measured]`)) {
        row.removeAttribute("data-measured");
      }
    };
    if (!enabled) {
      measured.current = null;
      unmark();
      return;
    }
    if (!visible) return;
    if (
      measured.current?.width === el.clientWidth &&
      measured.current.fitWindowWidth === fitWindowWidth &&
      measured.current.fontZoom === fontZoom
    )
      return;
    measured.current = { width: el.clientWidth, fitWindowWidth, fontZoom };
    unmark();
  }, [ref, visible, enabled, fitWindowWidth, fontZoom]);
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled || !visible) return;
    let frame = 0;
    let timer: number | undefined;
    const unmark = () => {
      for (const row of el.querySelectorAll(`:scope > .${styles.conversationRow}[data-measured]`)) {
        row.removeAttribute("data-measured");
      }
    };
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
      if (
        measured.current?.width === el.clientWidth &&
        measured.current.fitWindowWidth === fitWindowWidth &&
        measured.current.fontZoom === fontZoom
      )
        return;
      measured.current = { width: el.clientWidth, fitWindowWidth, fontZoom };
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
  }, [ref, visible, enabled, fitWindowWidth, fontZoom]);
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
  fontZoom: number;
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

function Stream({
  loadError,
  task,
  entries,
  subagent,
  onOpenSubagent,
  finding,
  findFocus,
  fontZoom,
  onCloseFind,
}: StreamProps) {
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
  // which comes with a change of the content height, and pulls it back to the end when the view
  // grows taller (the composer shrinks after a send); a scroll without either is meant too (the
  // scrollbar thumb, a jump), whatever moved it.
  const userScrolled = useRef(-Infinity);
  const seenHeight = useRef({ content: 0, view: 0 });
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
  const { foldTurns, toolCalls, fitWindowWidth } = useAgentSettings();
  useOffscreenRows(ref, visible, !finding, fitWindowWidth, fontZoom);
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
  // How far the end was below the view when a section was toggled, before its content renders.
  const gapAtToggle = useRef(Infinity);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const toggled = () => {
      gapAtToggle.current = el.scrollHeight - el.scrollTop - el.clientHeight;
    };
    el.addEventListener("toggle", toggled, true);
    return () => el.removeEventListener("toggle", toggled, true);
  }, []);
  /**
   * An opened section grew the conversation below its header: with the end in view, stay at
   * it; otherwise bring what it shows into view. Either way its header stays on screen, and
   * following stops when that leaves the end out of view.
   */
  const revealFold = useCallback(
    (fold: HTMLElement) => {
      const el = ref.current;
      if (!el || dragging.current) return;
      const view = el.getBoundingClientRect();
      const box = fold.getBoundingClientRect();
      const atEnd = position.current.stick || gapAtToggle.current < 40;
      gapAtToggle.current = Infinity;
      const below = atEnd ? el.scrollHeight - el.scrollTop - el.clientHeight : box.bottom - view.bottom;
      if (below > 0) el.scrollTop += Math.max(0, Math.min(below, box.top - view.top));
      if (atEnd && el.scrollHeight - el.scrollTop - el.clientHeight >= 40) {
        position.current = { top: el.scrollTop, stick: false };
        positions.set(key, position.current);
        setAway(true);
      }
    },
    [key, positions],
  );
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
      <RevealFold.Provider value={revealFold}>
        <div className={styles.streamArea}>
          {finding && <FindBar streamRef={ref} focus={findFocus} onClose={onCloseFind} />}
          <div
            ref={ref}
            // The conversation is read and copied like a document; focusable so ⌘F reaches it.
            className={clsx(styles.stream, selectableText)}
            tabIndex={-1}
            onWheel={(e) => {
              if (e.defaultPrevented) return;
              markUserScroll();
              if (e.deltaY < 0 && !e.ctrlKey && !e.metaKey) stopFollowing(e.target);
              else if (e.deltaY > 0 && !e.ctrlKey && !e.metaKey) scrollingUp.current = false;
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
              else if (
                e.key === "ArrowDown" ||
                e.key === "PageDown" ||
                e.key === "End" ||
                (e.key === " " && !e.shiftKey)
              )
                scrollingUp.current = false;
            }}
            onPointerDown={() => {
              markUserScroll();
              scrollingUp.current = false;
            }}
            onScroll={(e) => {
              const el = e.currentTarget;
              const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
              const laidOut =
                el.scrollHeight !== seenHeight.current.content || el.clientHeight !== seenHeight.current.view;
              seenHeight.current = {
                content: el.scrollHeight,
                view: el.clientHeight,
              };
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
      </RevealFold.Provider>
    </OpenFolds.Provider>
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

/**
 * What needs the user or tells where the agent is, above the composer: an approval it
 * waits for (answered with 1, 2, 3… when the focus isn't in a text field), the plan,
 * then what runs and what is queued, and a line saying what it does now.
 */
function Tray({ task, entries, children }: { task: AgentTask; entries: AgentEntry[] | null; children: ReactNode }) {
  const tx = useTx();
  const pending = entries?.find((e): e is PermissionEntry => e.type === "permission" && !e.chosen && !asksInCard(e));
  const plan = entries?.findLast((e): e is Extract<AgentEntry, { type: "plan" }> => e.type === "plan");
  const [planOpen, setPlanOpen] = useState(false);
  const done = plan?.items.filter((i) => i.status === "completed").length ?? 0;
  const planShown = plan && plan.items.length > 0 && done < plan.items.length;
  return (
    <div className={styles.tray}>
      {pending && <PendingPermission task={task} entry={pending} />}
      {planShown && (
        <div className={styles.trayStrip}>
          <button
            type="button"
            className={styles.trayChip}
            aria-expanded={planOpen}
            onClick={() => setPlanOpen(!planOpen)}
          >
            <Icon name="todo" size={13} />
            {tx`Plan ${done}/${plan.items.length}`}
          </button>
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
        {subagent.status === "needsInput" ? (
          <T>Waiting for your answer…</T>
        ) : (
          <WorkingLabel turn={entries ?? []} seed={subagent.startedMs ?? 0} />
        )}
        {subagent.startedMs != null && <Elapsed since={subagent.startedMs} />}
      </div>
    );
  }
  if (task.status !== "running" && task.status !== "starting") return null;
  if (entries?.some((e) => e.type === "permission" && !e.chosen && !asksInCard(e))) return null;
  const userAt = entries?.findLastIndex((e) => e.type === "user") ?? -1;
  const lastUser = userAt >= 0 ? (entries![userAt] as UserEntry) : undefined;
  return (
    <div className={styles.working} role="status">
      <Spinner size={12} />
      {task.retry ? (
        <Retrying retry={task.retry} />
      ) : task.status === "starting" ? (
        <T>Starting the agent…</T>
      ) : (
        <WorkingLabel turn={entries?.slice(userAt + 1) ?? []} seed={lastUser?.sentMs ?? 0} />
      )}
      {lastUser?.sentMs != null && !lastUser.doneMs && <Elapsed since={lastUser.sentMs} />}
    </div>
  );
}

/**
 * What the agent is doing, said by the activity's playful words in turns (the user's own, else the
 * built-in ones) from the start, or once it has reported nothing new for the user's quiet time;
 * screen readers hear only the fact. A word stays its full time while it still fits what the agent
 * does, and a little while when it no longer does, so the row never flickers.
 */
function WorkingLabel({ turn, seed }: { turn: AgentEntry[]; seed: number }) {
  const tx = useTx();
  const { playfulStatus, playfulAfterSeconds, playfulWords } = useAgentSettings();
  const now = useNow(1000);
  const key = progressKey(turn);
  const [progress, setProgress] = useState({ key, at: now });
  if (progress.key !== key) setProgress({ key, at: now });
  // The word on screen, and how many the turn has shown, so the next one continues the order.
  const [playful, setPlayful] = useState<{ shown: number; word: PlayfulWord | null }>({ shown: 0, word: null });
  const activity = activityOf(turn);
  const kind = activity ?? "working";
  const fact = tx(ACTIVITY_STATUS[kind]);
  const own = playfulWords[kind];
  const words = own ?? PLAYFUL_WORDS[kind];
  const due = words.length > 0 && (!activity || now - progress.at >= playfulAfterSeconds * 1000);
  const current = playful.word;
  const fits = due && current?.kind === kind;
  const stays = current && playfulStatus && now - current.since < (fits ? PLAYFUL_WORD_MS : PLAYFUL_MIN_MS);
  let next = playful;
  if (!stays && playfulStatus && due) {
    const text = words[playfulIndex(words.length, seed, playful.shown)]!;
    next = { shown: playful.shown + 1, word: { text, kind, own: !!own, since: now } };
  } else if (!stays && current) next = { shown: playful.shown, word: null };
  if (next !== playful) setPlayful(next);
  if (!next.word) return fact;
  return (
    <>
      <span aria-hidden>{next.word.own ? next.word.text : tx(next.word.text)}</span>
      <span className={styles.srOnly}>{fact}</span>
    </>
  );
}

/** A playful word for `kind` on screen since `since`: the user's own as written, else a built-in one to translate. */
interface PlayfulWord {
  text: string;
  kind: Activity;
  own: boolean;
  since: number;
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
          area?.querySelector<HTMLElement>(".cm-content")?.focus({ preventScroll: true });
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
  focusRequest,
  focusRoot,
  entries,
  head,
  changes,
  commits,
  changesOpen,
  onToggleChanges,
  onOpenSubagent,
}: {
  task: AgentTask;
  focusRequest: number;
  focusRoot: RefObject<HTMLDivElement | null>;
  entries: AgentEntry[] | null;
  head: string | null;
  changes: AgentChange[] | null;
  commits: readonly AgentCommit[];
  changesOpen: boolean;
  onToggleChanges: () => void;
  onOpenSubagent: (id: string) => void;
}) {
  const { sendWith, whileRunning } = useAgentSettings();
  const project = useProject((s) => s.project);
  const composer = useAgents((s) => s.composers.get(task.id)) ?? emptyDraft();
  const [sending, setSending] = useState(false);
  const [mcpOpenRequest, setMcpOpenRequest] = useState(0);
  const [assetFocus, setAssetFocus] = useState(0);
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
  const openMcp = () => setMcpOpenRequest((n) => n + 1);
  const shown = useEditorShown();
  const effortAnnouncement = useEffortFocus(focusRoot, shown && task.status !== "archived", task.config, setOption);
  return (
    <div className={styles.composerArea}>
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
      <Tray task={task} entries={entries}>
        <WorkingSubagents entries={entries} onOpen={onOpenSubagent} />
        <BackgroundTasks task={task} />
        {task.queue.length > 0 && <Queue task={task} />}
      </Tray>
      <SessionAssets task={task} entries={entries} head={head} onFocusComposer={() => setAssetFocus((n) => n + 1)} />
      <Composer
        id={task.id}
        focusRequest={focusRequest + assetFocus}
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
        onOpenMcp={openMcp}
        disabled={task.status === "archived"}
        addMenu={[
          { id: "mcp", label: "MCP Servers…", icon: "plugin", disabled: task.status === "archived", run: openMcp },
        ]}
        toolbar={
          <>
            <ConfigPickers config={task.config} onChange={setOption} />
            <McpPicker
              provider={task.provider}
              overrides={task.mcpOverrides}
              disabled={task.status === "archived"}
              busy={busy}
              openRequest={mcpOpenRequest}
              hideTrigger
              onChange={(next) =>
                void setTaskMcpOverrides(task.id, next).catch((e: unknown) =>
                  notifications().notify({
                    level: "error",
                    title: "Couldn't change the setting",
                    body: String(e),
                  }),
                )
              }
            />
          </>
        }
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
      <SessionStatus
        task={task}
        entries={entries}
        head={head}
        changes={changes}
        commits={commits}
        changesOpen={changesOpen}
        onToggleChanges={onToggleChanges}
        effortAnnouncement={effortAnnouncement}
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
