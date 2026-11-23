import type { AgentEntry, AgentTask } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import {
  Button,
  copyMenuFor,
  EmptyState,
  Icon,
  IconButton,
  selectableText,
  showContextMenu,
  Spinner,
  useSelectionBoundary,
  useSelectionVisibility,
} from "@/ui";
import { useEditorShown } from "@/workbench/contributions";
import clsx from "clsx";
import {
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
import { useAgentSettings } from "../agentSettings";
import {
  entriesKey,
  isBusy,
  providerIcon,
  replyTimes,
  replyTurns,
  subagentWorking,
  turnNumbers,
  type SubagentEntry,
} from "../model";
import { selectionIn } from "../selection";
import styles from "../Session.module.css";
import { useAgents } from "../store";
import { foldedTurns, thoughtDurations } from "../timeline";
import {
  conversationRows,
  foldTurnRows,
  isProcessEntry,
  type ConversationRow,
  type EntryRow,
} from "./conversationRows";
import { FindBar } from "./FindBar";
import { KeepFoldHeader, OpenFolds } from "./Folds";
import { Entry } from "./messages";
import { ProcessRun, TurnFold } from "./ProcessRows";
import { type QuestionAnswer } from "./QuestionForm";
import { providerName } from "./shared";
import { WorkingRow } from "./WorkingRow";

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
  // Keep independent of `visible`: when a kept-alive tab hides, `data-selection` must stay until
  // the selection leaves and WebKit clears off-screen rows' highlights before skipping again.
  useSelectionVisibility(ref, enabled, `.${styles.conversationRow}`);
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
  /** Answers in flight, kept across entry reloads so a refresh doesn't lose what was typed. */
  drafts: RefObject<Map<string, QuestionAnswer[]>>;
}

/** Entries rendered at a time when a conversation opens at its end. */
const ENTRY_BATCH = 40;

function scrollsY(el: Element): boolean {
  if (el.scrollHeight - el.clientHeight <= 1) return false;
  const overflow = getComputedStyle(el).overflowY;
  return overflow === "auto" || overflow === "scroll";
}

/** The innermost container under `target` that scrolls vertically: a tool output, a run of calls, or `root`. */
function scrollOwner(target: EventTarget | null, root: HTMLElement): HTMLElement {
  for (let el = target instanceof Element ? target : null; el && el !== root; el = el.parentElement) {
    if (el instanceof HTMLElement && scrollsY(el)) return el;
  }
  return root;
}

/** Whether a container inside `root` under `target` can still scroll up. */
function scrollsUpInside(target: EventTarget | null, root: HTMLElement): boolean {
  for (let el = target instanceof Element ? target : null; el && el !== root; el = el.parentElement) {
    if (el.scrollTop > 0 && scrollsY(el)) return true;
  }
  return false;
}

/** A wheel gesture's events arrive closer together than this; a pause starts a new one. */
const WHEEL_GESTURE_MS = 150;

export function Stream({
  loadError,
  task,
  entries,
  subagent,
  onOpenSubagent,
  finding,
  findFocus,
  fontZoom,
  onCloseFind,
  drafts,
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
  const [away, setAway] = useState(false);
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
      if (!el || el.scrollHeight <= el.clientHeight || scrollsUpInside(target, el)) return;
      scrollingUp.current = true;
      if (!position.current.stick) return;
      position.current = { top: el.scrollTop, stick: false };
      positions.set(key, position.current);
    },
    [key, positions],
  );
  const updateJumpVisibility = useCallback((el: HTMLElement) => {
    // An upward gesture releases following before anything moves. Only offer a jump
    // when there is actual content below the viewport, excluding the fold spacer.
    setAway(
      !position.current.stick &&
        el.scrollHeight - el.clientHeight - el.scrollTop > (parseFloat(getComputedStyle(el).paddingBottom) || 0) + 1,
    );
  }, []);
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
  /**
   * Blank space after the conversation that lets a section folded near the end keep its header
   * in place. It is only ever what the view shows below the content: scrolling up or new rows
   * take it back without moving anything.
   */
  const slack = useRef(0);
  const setSlack = useCallback((px: number) => {
    slack.current = px;
    if (px) ref.current?.style.setProperty("--stream-slack", `${px}px`);
    else ref.current?.style.removeProperty("--stream-slack");
  }, []);
  const trimSlack = useCallback(() => {
    const el = ref.current;
    if (!el || slack.current === 0) return;
    const content = el.scrollHeight - slack.current;
    const next = Math.max(0, Math.min(slack.current, Math.ceil(el.scrollTop + el.clientHeight - content)));
    if (next !== slack.current) setSlack(next);
  }, [setSlack]);
  /** A diagram that drew after the last streamed chunk grows the conversation: keep following. */
  const onDiagramDrawn = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (position.current.stick && !dragging.current) el.scrollTop = el.scrollHeight;
    updateJumpVisibility(el);
  }, [updateJumpVisibility]);
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
    trimSlack();
    if (position.current.stick) {
      if (!dragging.current) el.scrollTop = el.scrollHeight;
    } else if (!restored.current) el.scrollTop = position.current.top;
    restored.current = true;
    updateJumpVisibility(el);
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
    updateJumpVisibility(scroller);
  });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      trimSlack();
      if (position.current.stick && !dragging.current) el.scrollTop = el.scrollHeight;
      updateJumpVisibility(el);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (restored.current) positions.set(key, { ...position.current, top: el.scrollTop });
    };
  }, [key, positions, trimSlack, updateJumpVisibility]);
  /**
   * The wheel scrolls the innermost container under the pointer, and only that one: a run of
   * calls from its headers, a tool output from its text, the conversation elsewhere. A container
   * at its edge doesn't hand the rest to the conversation; a gesture stays with the container
   * it started in.
   */
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let gesture: { owner: HTMLElement; at: number } | null = null;
    const onWheel = (e: WheelEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey) return;
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      const now = performance.now();
      const latched = gesture && now - gesture.at < WHEEL_GESTURE_MS && gesture.owner.isConnected;
      const owner = latched ? gesture!.owner : scrollOwner(e.target, el);
      gesture = { owner, at: now };
      if (owner !== el) {
        const room = e.deltaY < 0 ? owner.scrollTop : owner.scrollHeight - owner.clientHeight - owner.scrollTop;
        if (room <= 1) e.preventDefault();
        return;
      }
      markUserScroll();
      if (e.deltaY < 0) stopFollowing(e.target);
      else if (e.deltaY > 0) scrollingUp.current = false;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [markUserScroll, stopFollowing]);
  /**
   * The reader opened or closed a section: put its header back where it was, in the run or
   * output that scrolls it and then in the conversation. Following stops when that leaves any
   * of the end out of view, so the next chunk doesn't pull the header away.
   */
  const keepFoldHeader = useCallback(
    (header: HTMLElement, top: number) => {
      const el = ref.current;
      if (!el?.contains(header)) return;
      // Opened, the section fills the room left by an earlier fold first.
      trimSlack();
      for (let s = header.parentElement; s; s = s.parentElement) {
        const moved = header.getBoundingClientRect().top - top;
        if (Math.abs(moved) < 1) break;
        if (s === el) {
          const short = Math.ceil(el.scrollTop + moved + el.clientHeight - el.scrollHeight);
          if (short > 0) setSlack(slack.current + short);
          el.scrollTop += moved;
          break;
        }
        if (scrollsY(s)) s.scrollTop += moved;
      }
      if (position.current.stick && el.scrollHeight - el.scrollTop - el.clientHeight >= 1) {
        position.current = { top: el.scrollTop, stick: false };
        positions.set(key, position.current);
      }
      updateJumpVisibility(el);
    },
    [key, positions, setSlack, trimSlack, updateJumpVisibility],
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
  const thinking = useMemo(() => (entries ? thoughtDurations(entries) : null), [entries]);
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
        thoughtMs={thinking?.get(row.index) ?? null}
        working={row.index === lastIndex && busy}
        drafts={drafts}
        onOpenSubagent={onOpenSubagent}
        onDiagramDrawn={onDiagramDrawn}
      />
    ),
    [task, turns, replies, times, thinking, lastIndex, busy, drafts, onOpenSubagent, onDiagramDrawn],
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
      <ProcessRun
        row={row}
        task={task}
        lastIndex={lastIndex}
        busy={busy}
        thinking={thinking}
        onDiagramDrawn={onDiagramDrawn}
      />
    ) : (
      renderRow(row)
    );
  return (
    <OpenFolds.Provider value={openFolds}>
      <KeepFoldHeader.Provider value={keepFoldHeader}>
        <div className={styles.streamArea}>
          {finding && <FindBar streamRef={ref} focus={findFocus} onClose={onCloseFind} />}
          <div
            ref={ref}
            // The conversation is read and copied like a document; focusable so ⌘F reaches it.
            className={clsx(styles.stream, selectableText)}
            tabIndex={-1}
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
              trimSlack();
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
              updateJumpVisibility(el);
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
                  data-author={authorHeaders.has(row.index) || undefined}
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
      </KeepFoldHeader.Provider>
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
