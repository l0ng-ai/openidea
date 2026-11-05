import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import clsx from "clsx";
import { useVirtualizer } from "@tanstack/react-virtual";
import { copySelectionOnKeyDown, copyText } from "@/ui/selectableText";
import { EmptyState, IconButton, showContextMenu, T, type MenuItem } from "@/ui";
import { formatBinding, hasPrimaryModifier, hostBinding, registerKeyClaim } from "@/platform/keymap";
import { tx } from "@/platform/i18n";
import { useWorkflowSettings } from "@/platform/workflowSettings";
import { spanStyle, type Span, type SpanStyle } from "@/ui/ansi";
import ansi from "@/ui/ansi.module.css";
import { ConsoleFindBar } from "@/ui/ConsoleFindBar";
import {
  DEFAULT_FIND_OPTIONS,
  findInLines,
  type ConsoleMatch,
  type FindOptions,
  type FindResult,
} from "@/ui/consoleFind";
import { appendConsole, clearConsole, evaluate, isLive, useDebug, type DebugSession } from "../state";
import { pushHistory, readHistory, setConsoleHistoryBrowser } from "./expressionHistory";
import { useExpressionCompletion } from "./ExpressionCompletion";
import styles from "./DebugToolWindow.module.css";

const EMPTY_FIND: FindResult = { matches: [], overflow: false, invalid: false };

const MARK_COLOR = "var(--bg-search-match)";
const CURRENT_MARK_COLOR = "var(--bg-search-match-current)";

interface Segment {
  text: string;
  style: SpanStyle;
  /** The piece is inside a find match. */
  mark: boolean;
  /** …and inside the current one. */
  current: boolean;
}

/** Splits a line's styled spans at find-match boundaries (the Run console's `segmentLine`, without links). */
function findSegments(spans: readonly Span[], marks: readonly ConsoleMatch[], active?: ConsoleMatch): Segment[] {
  const out: Segment[] = [];
  let pos = 0;
  let mi = 0;
  for (const span of spans) {
    const { text, ...style } = span;
    let offset = 0;
    while (offset < text.length) {
      const abs = pos + offset;
      while (mi < marks.length && marks[mi]!.end <= abs) mi++;
      const mark = marks[mi];
      if (mark && mark.start <= abs) {
        const take = Math.min(mark.end - abs, text.length - offset);
        out.push({ text: text.slice(offset, offset + take), style, mark: true, current: mark === active });
        offset += take;
      } else if (mark && mark.start < pos + text.length) {
        const take = Math.min(mark.start - abs, text.length - offset);
        out.push({ text: text.slice(offset, offset + take), style, mark: false, current: false });
        offset += take;
      } else {
        out.push({ text: text.slice(offset), style, mark: false, current: false });
        offset = text.length;
      }
    }
    pos += text.length;
  }
  return out;
}

/** A match keeps the span's colours but takes the search background (as IDEA does). */
function segmentNode(seg: Segment, key: number) {
  if (!seg.mark)
    return (
      <span key={key} style={spanStyle(seg.style)}>
        {seg.text}
      </span>
    );
  return (
    <mark
      key={key}
      className={styles.findMatch}
      style={{
        ...spanStyle(seg.style),
        backgroundColor: seg.current ? CURRENT_MARK_COLOR : MARK_COLOR,
        color: "var(--fg-search-match)",
      }}
      data-find-match=""
      data-find-current={seg.current ? "" : undefined}
    >
      {seg.text}
    </mark>
  );
}

export function DebugServiceConsole({ sessionId }: { sessionId: number }) {
  const session = useDebug((s) => s.sessions[sessionId]);
  return session ? (
    <DebugConsole key={sessionId} session={session} interactive={false} />
  ) : (
    <EmptyState title="No debug output available" />
  );
}

export function DebugConsole({ session, interactive = true }: { session: DebugSession; interactive?: boolean }) {
  const lines = useDebug((s) => s.console[session.id]);
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  // Scroll to End: follows new output; scrolling up turns it off, back to the end turns it on.
  const [follow, setFollow] = useState(true);
  const stick = useRef(true);
  stick.current = follow;
  // Settings › Console › Use soft wraps is the default; the toggle overrides it for this console.
  const defaultWrap = useWorkflowSettings((s) => s.console.softWrap);
  const [wrapOverride, setWrapOverride] = useState<boolean | null>(null);
  const softWrap = wrapOverride ?? defaultWrap;
  const programmatic = useRef(false);
  const [input, setInput] = useState("");
  const history = useRef<string[]>(readHistory("console"));
  const historyPos = useRef(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const completion = useExpressionCompletion(inputRef, input, setInput, session);

  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [findOptions, setFindOptions] = useState<FindOptions>(DEFAULT_FIND_OPTIONS);
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const findInput = useRef<HTMLInputElement>(null);
  /** Line the next search starts from (the top of the viewport when the query changed). */
  const findAnchor = useRef(0);
  const scrolledMatch = useRef<string | null>(null);

  const virtualizer = useVirtualizer({
    count: lines?.length ?? 0,
    getScrollElement: () => scroller.current,
    estimateSize: () => 18,
    overscan: 30,
    getItemKey: (i) => lines?.[i]?.id ?? i,
  });

  // Wrapping changes every row's height; the end is pinned again below.
  useLayoutEffect(() => virtualizer.measure?.(), [softWrap, virtualizer]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !stick.current || !lines?.length) return;
    programmatic.current = true;
    virtualizer.scrollToIndex(lines.length - 1, { align: "end" });
    el.scrollTop = el.scrollHeight;
    // Rows measured after this frame grow the content: pin the end once more.
    requestAnimationFrame(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => (programmatic.current = false));
    });
  }, [lines, virtualizer, follow, softWrap]);

  // Find (⌘F): search the whole buffer, not just the rendered rows.
  const found = useMemo(
    () => (findOpen ? findInLines(lines ?? [], query, findOptions) : EMPTY_FIND),
    [findOpen, lines, query, findOptions],
  );
  const activeIndex = found.matches.length ? Math.min(Math.max(activeMatchIndex, 0), found.matches.length - 1) : -1;
  const current = activeIndex >= 0 ? found.matches[activeIndex] : undefined;
  const marksByLine = useMemo(() => {
    const byLine = new Map<number, ConsoleMatch[]>();
    found.matches.forEach((match) => {
      const marks = byLine.get(match.line);
      if (marks) marks.push(match);
      else byLine.set(match.line, [match]);
    });
    return byLine;
  }, [found]);

  // The line at the top of the viewport: typing searches from there, as IDEA does.
  const topLine = () => {
    const offset = scroller.current?.scrollTop ?? 0;
    const items = virtualizer.getVirtualItems();
    const first = items.find((item) => item.start + item.size > offset) ?? items[0];
    return first?.index ?? 0;
  };
  const openFind = () => {
    findAnchor.current = topLine();
    // Opening with selected output searches for it (a single line, like the terminal).
    if (!findOpen) {
      const text = selectedText();
      if (text) setQuery(text);
    }
    scrolledMatch.current = null;
    setFindOpen(true);
    setFollow(false);
    findInput.current?.focus();
    findInput.current?.select();
  };
  const closeFind = () => {
    scrolledMatch.current = null;
    setFindOpen(false);
    scroller.current?.focus();
  };
  const changeQuery = (value: string) => {
    findAnchor.current = topLine();
    setQuery(value);
  };
  const changeOptions = (next: FindOptions) => {
    findAnchor.current = topLine();
    setFindOptions(next);
  };
  const goToMatch = (direction: 1 | -1) => {
    const total = found.matches.length;
    if (!total) return;
    const from = activeMatchIndex >= 0 && activeMatchIndex < total ? activeMatchIndex : activeIndex;
    setActiveMatchIndex((from + direction + total) % total);
  };

  const findWasOpen = useRef(false);
  useEffect(() => {
    if (findOpen) {
      findWasOpen.current = true;
      findInput.current?.focus();
      findInput.current?.select();
    } else if (findWasOpen.current) {
      // Closed from the toolbar rather than the bar: put the caret back in the console.
      findWasOpen.current = false;
      scroller.current?.focus();
    }
  }, [findOpen]);

  // The bar owns Escape / Enter / F3 / ⌘G while it is focused; keep the IDE keymap out.
  useEffect(() => {
    if (!findOpen) return;
    return registerKeyClaim((e) => !!(e.target as Element | null)?.closest?.("[data-console-find]"));
  }, [findOpen]);

  // A new query (or option) starts from the viewport, not from the top of the output.
  useEffect(() => {
    if (!findOpen) return;
    const next = found.matches.findIndex((match) => match.line >= findAnchor.current);
    setActiveMatchIndex(next >= 0 ? next : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- new output keeps the current match
  }, [findOpen, query, findOptions]);

  // Bring the current match into view.
  useEffect(() => {
    if (!findOpen || !current) return;
    const key = `${current.lineId}:${current.start}`;
    if (scrolledMatch.current === key) return;
    virtualizer.scrollToIndex(current.line, { align: "center" });
    scrolledMatch.current = key;
  }, [findOpen, current, virtualizer]);

  const submit = async () => {
    const e = input.trim();
    if (!e) return;
    pushHistory("console", e);
    history.current = readHistory("console");
    historyPos.current = -1;
    setInput("");
    appendConsole(session.id, "input", `> ${e}\n`);
    try {
      const v = await evaluate(e, "repl", session);
      appendConsole(session.id, "result", `${v.value}\n`);
    } catch (err) {
      appendConsole(session.id, "stderr", `${err instanceof Error ? err.message : String(err)}\n`);
    }
  };

  /** IDEA's Browse History popup: the expressions typed before, most recent first. */
  const browseHistory = () => {
    const el = inputRef.current;
    const r = el?.getBoundingClientRect();
    const items: MenuItem[] = history.current.length
      ? history.current.slice(0, 30).map((h, i) => ({
          id: String(i),
          label: h.length > 120 ? `${h.slice(0, 120)}…` : h,
          run: () => {
            setInput(h);
            historyPos.current = i;
            el?.focus();
          },
        }))
      : [{ id: "none", label: "No history", disabled: true }];
    showContextMenu({ x: r?.left ?? 120, y: (r?.top ?? 200) - 4 }, items);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (completion.onKeyDown(e)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const h = history.current;
      if (!h.length) return;
      e.preventDefault();
      const pos = Math.max(-1, Math.min(h.length - 1, historyPos.current + (e.key === "ArrowUp" ? 1 : -1)));
      historyPos.current = pos;
      setInput(pos < 0 ? "" : h[pos]!);
    }
  };

  /** Rows are virtualized, so "everything" is a selection of the container, not of the mounted rows. */
  const selectAll = () => {
    if (inner.current) window.getSelection()?.selectAllChildren(inner.current);
  };
  const allSelected = () => {
    const el = inner.current;
    const s = window.getSelection();
    return (
      !!el &&
      !!s &&
      !s.isCollapsed &&
      s.anchorNode === el &&
      s.focusNode === el &&
      s.anchorOffset === 0 &&
      s.focusOffset === el.childNodes.length
    );
  };
  const bufferText = () => (lines ?? []).map((l) => l.text).join("");
  /** The selected text; after Select All the whole buffer, including rows that are not mounted. */
  const selectedOutput = () => {
    if (allSelected()) return bufferText();
    const s = window.getSelection();
    const el = scroller.current;
    if (!s || !el || !s.anchorNode || !el.contains(s.anchorNode)) return "";
    return s.toString();
  };
  const selectedText = () => {
    const el = scroller.current;
    const selection = window.getSelection();
    if (!el || !selection || !selection.anchorNode || !el.contains(selection.anchorNode)) return "";
    const text = selection.toString();
    return text && !text.includes("\n") ? text.trim() : "";
  };

  const onOutputKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (hasPrimaryModifier(e) && !e.altKey && !e.shiftKey) {
      const key = e.key.toLowerCase();
      if (key === "f") {
        e.preventDefault();
        openFind();
        return;
      }
      if (key === "a") {
        e.preventDefault();
        selectAll();
        return;
      }
    }
    copySelectionOnKeyDown(e, selectedOutput);
  };

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    const selection = selectedOutput();
    showContextMenu(e, [
      {
        label: "Copy",
        icon: "copy",
        shortcut: formatBinding(hostBinding("Meta+C")),
        disabled: !selection,
        run: () => void copyText(selection),
      },
      { label: "Select All", shortcut: formatBinding(hostBinding("Meta+A")), run: selectAll },
      { label: "Copy All", run: () => void copyText(bufferText()) },
      { label: "Find…", icon: "search", shortcut: formatBinding(hostBinding("Meta+F")), run: openFind },
      { kind: "separator" },
      { label: "Clear All", icon: "trash", run: () => clearConsole(session.id) },
    ]);
  };

  return (
    <div className={styles.consoleArea}>
      <div
        className={styles.consoleToolbar}
        role="toolbar"
        aria-orientation="vertical"
        aria-label={tx("Console actions")}
      >
        <IconButton
          icon="search"
          iconSize={14}
          title="Find…"
          shortcut={formatBinding(hostBinding("Meta+F"))}
          pressed={findOpen}
          onClick={() => (findOpen ? closeFind() : openFind())}
        />
        <IconButton
          icon="arrow-down"
          iconSize={14}
          title="Scroll to End"
          pressed={follow}
          onClick={() => setFollow((v) => !v)}
        />
        <IconButton
          icon="soft-wrap"
          iconSize={14}
          title="Soft-Wrap"
          pressed={softWrap}
          onClick={() => setWrapOverride(!softWrap)}
        />
        <IconButton icon="trash" iconSize={14} title="Clear Console" onClick={() => clearConsole(session.id)} />
      </div>
      <div className={styles.console}>
        {findOpen && (
          <ConsoleFindBar
            query={query}
            onChange={changeQuery}
            options={findOptions}
            onOptionsChange={changeOptions}
            count={found.matches.length}
            active={activeIndex}
            overflow={found.overflow}
            invalid={found.invalid}
            inputRef={findInput}
            onNext={() => goToMatch(1)}
            onPrevious={() => goToMatch(-1)}
            onClose={closeFind}
          />
        )}
        <div
          ref={scroller}
          className={clsx(styles.consoleOutput, ansi.palette, !softWrap && styles.noWrap)}
          onScroll={(e) => {
            if (programmatic.current) return;
            const el = e.currentTarget;
            const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            if (atEnd !== stick.current) setFollow(atEnd);
          }}
          onContextMenu={onContextMenu}
          role="log"
          onKeyDown={onOutputKeyDown}
          aria-label={tx("Debug console")}
          tabIndex={0}
        >
          {!lines?.length && session.launch?.request === "attach" && (
            <T>The attached process may not provide standard output to the debugger.</T>
          )}
          <div ref={inner} className={styles.consoleInner} style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const l = lines?.[item.index];
              if (!l) return null;
              return (
                <span
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className={clsx(styles.out, styles[`cat-${l.category}`])}
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  {findSegments(l.spans, marksByLine.get(item.index) ?? [], current).map(segmentNode)}
                </span>
              );
            })}
          </div>
        </div>
        <div className={styles.repl}>
          {interactive && (
            <>
              <span className={styles.prompt} aria-hidden>
                ›
              </span>
              <input
                ref={inputRef}
                className={styles.evalInput}
                onFocus={() => setConsoleHistoryBrowser(browseHistory)}
                onBlur={() => {
                  setConsoleHistoryBrowser(null);
                  completion.close();
                }}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  completion.onInput();
                }}
                onKeyDown={onKeyDown}
                placeholder={isLive(session) ? "Evaluate in the debug console" : "Session finished"}
                disabled={!isLive(session)}
                aria-label={tx("Debug console input")}
                spellCheck={false}
                autoComplete="off"
              />
              {completion.popup}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
