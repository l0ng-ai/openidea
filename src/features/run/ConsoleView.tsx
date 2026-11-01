import { copySelectionOnKeyDown } from "@/ui/selectableText";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import clsx from "clsx";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useWorkflowSettings } from "@/platform/workflowSettings";
import { Icon, showContextMenu } from "@/ui";
import { spanStyle } from "@/ui/ansi";
import ansi from "@/ui/ansi.module.css";
import type { ConsoleLine, ConsoleModel } from "./console";
import { findOutputLinks, type OutputLink } from "./links";
import { openTarget, openUrl } from "./navigate";
import { segmentLine, type SegmentMark } from "./segments";
import styles from "./Run.module.css";
import { hostBinding, formatBinding, hasPrimaryModifier, registerKeyClaim } from "@/platform/keymap";
import { tx } from "@/platform/i18n";
import { ConsoleFindBar } from "./FindBar";
import { DEFAULT_FIND_OPTIONS, findInLines, type FindOptions } from "./find";
import { sqlFromMybatisLog } from "@/features/mybatis/sqlLog";
import { notifications } from "@/workbench/contributions";

const ROW = 20;

const MARK_COLOR = "var(--bg-search-match)";
const CURRENT_MARK_COLOR = "var(--bg-search-match-current)";

const Line = memo(
  function Line({
    line,
    marks,
    cwd,
  }: {
    line: ConsoleLine;
    marks?: readonly SegmentMark[];
    length: number;
    cwd: string;
  }) {
    // Not memoised: the open (last) line mutates in place; `memo` below re-renders on length changes only.
    const segments = segmentLine(line.spans, line.kind === "system" ? [] : findOutputLinks(line.text), marks);
    const activate = (e: MouseEvent, link: OutputLink) => {
      e.preventDefault();
      if (window.getSelection()?.toString()) return;
      if (link.kind === "url") void openUrl(link.url);
      else void openTarget(link.target, cwd);
    };
    if (segments.length === 0) return <>{"​"}</>;
    return (
      <>
        {segments.map((seg, i) => {
          // A match keeps the span's colours but takes the search background (as IDEA does).
          const style = seg.mark
            ? {
                ...spanStyle(seg.style),
                backgroundColor: seg.current ? CURRENT_MARK_COLOR : MARK_COLOR,
                color: "var(--fg-search-match)",
              }
            : spanStyle(seg.style);
          const marked = seg.mark ? { "data-find-match": "", "data-find-current": seg.current ? "" : undefined } : {};
          return seg.link ? (
            <a
              key={i}
              href={seg.link.kind === "url" ? seg.link.url : undefined}
              className={styles.link}
              style={style}
              onClick={(e) => activate(e, seg.link!)}
              role="link"
              tabIndex={-1}
              {...marked}
            >
              {seg.text}
            </a>
          ) : seg.mark ? (
            <mark key={i} className={styles.match} style={style} {...marked}>
              {seg.text}
            </mark>
          ) : (
            <span key={i} style={style}>
              {seg.text}
            </span>
          );
        })}
      </>
    );
  },
  (a, b) => a.line === b.line && a.length === b.length && a.cwd === b.cwd && a.marks === b.marks,
);

/** A run of folded lines (Settings › Console › Fold lines that contain). */
export interface Fold {
  start: number;
  count: number;
  /** Id of the first folded line (stable across trimming). */
  id: number;
  expanded: boolean;
}

/**
 * A visible console row: one line (carrying the fold of the lines after it, IDEA attaches
 * the `<N internal lines>` placeholder to the previous line), or a fold with no line before it.
 */
export type DisplayRow = { kind: "line"; index: number; fold?: Fold } | { kind: "fold"; fold: Fold };

/**
 * Folds runs of consecutive output lines (one or more) that contain one of
 * `patterns`; runs whose first line id is in `expanded` stay open.
 */
export function foldRows(
  lines: readonly ConsoleLine[],
  patterns: readonly string[],
  expanded: ReadonlySet<number>,
): DisplayRow[] {
  const rows: DisplayRow[] = [];
  const matches = (l: ConsoleLine) => l.kind !== "system" && patterns.some((p) => l.text.includes(p));
  for (let i = 0; i < lines.length;) {
    if (patterns.length && matches(lines[i]!)) {
      let j = i + 1;
      while (j < lines.length && matches(lines[j]!)) j++;
      const fold: Fold = { start: i, count: j - i, id: lines[i]!.id, expanded: expanded.has(lines[i]!.id) };
      const prev = rows[rows.length - 1];
      if (prev?.kind === "line") prev.fold = fold;
      else if (!fold.expanded) rows.push({ kind: "fold", fold });
      if (fold.expanded) for (; i < j; i++) rows.push({ kind: "line", index: i });
      i = j;
      continue;
    }
    rows.push({ kind: "line", index: i });
    i++;
  }
  return rows;
}

/** Typed console input (IDEA: type into the console, Enter sends the line). */
export interface ConsoleInput {
  /** Typed, not yet sent. */
  pending: string;
  onChange(pending: string): void;
  /** Sends one line (without the newline). */
  onSubmit(line: string): void;
  /** Closes stdin (EOF). */
  onEof(): void;
}

export interface ConsoleViewProps {
  model: ConsoleModel;
  version: number;
  softWrap: boolean;
  follow: boolean;
  onFollowChange: (follow: boolean) => void;
  /** Directory relative paths in the output resolve against. */
  cwd: string;
  onClear?: () => void;
  /** Set while the process accepts input. */
  input?: ConsoleInput;
  /** The run executes on a JVM: shows the MyBatis SQL conversion item for log selections. */
  mybatisSql?: boolean;
  /** Controlled find bar (the Run toolbar button); without it ⌘F opens it locally. */
  findOpen?: boolean;
  onFindOpenChange?: (open: boolean) => void;
  "aria-label"?: string;
}

export function ConsoleView({
  model,
  version,
  softWrap,
  follow,
  onFollowChange,
  cwd,
  onClear,
  input,
  mybatisSql,
  findOpen: controlledFindOpen,
  onFindOpenChange,
  ...aria
}: ConsoleViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lines = model.lines;
  const patterns = useWorkflowSettings((s) => s.console.foldPatterns);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const [internalFindOpen, setInternalFindOpen] = useState(false);
  const findOpen = controlledFindOpen ?? internalFindOpen;
  const setFindOpen = (open: boolean) => {
    onFindOpenChange?.(open);
    if (controlledFindOpen === undefined) setInternalFindOpen(open);
  };
  const [query, setQuery] = useState("");
  const [findOptions, setFindOptions] = useState<FindOptions>(DEFAULT_FIND_OPTIONS);
  const [active, setActive] = useState(0);
  const findInput = useRef<HTMLInputElement>(null);
  /** Line the next search starts from (the top of the viewport when the query changed). */
  const findAnchor = useRef(0);
  const scrolledMatch = useRef<string | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` marks in-place appends to `lines`
  const folded = useMemo(() => foldRows(lines, patterns, expanded), [lines, version, patterns, expanded]);
  // Pending input continues the open line (a prompt), or starts a row of its own.
  const lastRow = folded[folded.length - 1];
  const inputInline =
    !!input && !!model.openLine && lastRow?.kind === "line" && !lastRow.fold && lines[lastRow.index] === model.openLine;
  const inputRow = !!input && !inputInline;
  const rows = folded;
  const count = rows.length + (inputRow ? 1 : 0);
  const toggleFold = (id: number) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const programmatic = useRef(false);

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 30,
    getItemKey: (i) => {
      const r = rows[i];
      if (!r) return "input";
      return r.kind === "fold" ? `f${r.fold.id}` : (lines[r.index]?.id ?? i);
    },
  });

  // Soft wrap changes row heights; re-measure everything.
  useEffect(() => {
    virtualizer.measure();
  }, [softWrap, virtualizer]);

  useLayoutEffect(() => {
    if (!follow || count === 0) return;
    programmatic.current = true;
    virtualizer.scrollToIndex(count - 1, { align: "end" });
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => (programmatic.current = false));
  }, [version, count, follow, virtualizer]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || programmatic.current) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < ROW;
    if (atBottom !== follow) onFollowChange(atBottom);
  };

  // Find (⌘F): search the whole buffer, not just the rendered rows.
  const found = useMemo(
    () => (findOpen ? findInLines(lines, query, findOptions) : { matches: [], overflow: false, invalid: false }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` marks in-place appends to `lines`
    [findOpen, lines, version, query, findOptions],
  );
  const activeIndex = found.matches.length ? Math.min(Math.max(active, 0), found.matches.length - 1) : -1;
  const activeMatch = activeIndex >= 0 ? found.matches[activeIndex] : undefined;
  const marksByLine = useMemo(() => {
    const byLine = new Map<number, SegmentMark[]>();
    found.matches.forEach((match, i) => {
      const mark: SegmentMark = { start: match.start, end: match.end, current: i === activeIndex };
      const marks = byLine.get(match.line);
      if (marks) marks.push(mark);
      else byLine.set(match.line, [mark]);
    });
    return byLine;
  }, [found, activeIndex]);
  const rowOfLine = useMemo(() => {
    const rowsByLine = new Map<number, number>();
    rows.forEach((row, i) => {
      if (row.kind === "line") rowsByLine.set(row.index, i);
    });
    return rowsByLine;
  }, [rows]);

  /** The line at the top of the viewport: typing searches from there, as IDEA does. */
  const topLine = () => {
    const offset = scrollRef.current?.scrollTop ?? 0;
    const items = virtualizer.getVirtualItems();
    // The virtualizer also renders overscan rows above the viewport.
    const first = items.find((item) => item.start + item.size > offset) ?? items[0];
    const row = first ? rows[first.index] : undefined;
    if (!row) return 0;
    return row.kind === "line" ? row.index : row.fold.start;
  };
  const selectedText = () => {
    const el = scrollRef.current;
    const selection = window.getSelection();
    if (!el || !selection || !selection.anchorNode || !el.contains(selection.anchorNode)) return "";
    const text = selection.toString();
    return text && !text.includes("\n") ? text.trim() : "";
  };
  const openFind = () => {
    findAnchor.current = topLine();
    // Opening with selected output searches for it (a single line, like the terminal).
    if (!findOpen) {
      const selection = selectedText();
      if (selection) setQuery(selection);
    }
    scrolledMatch.current = null;
    setFindOpen(true);
    onFollowChange(false);
    findInput.current?.focus();
    findInput.current?.select();
  };
  const closeFind = () => {
    scrolledMatch.current = null;
    setFindOpen(false);
    scrollRef.current?.focus();
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
    setActive((current) => {
      const from = current >= 0 && current < total ? current : activeIndex;
      return (from + direction + total) % total;
    });
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
      scrollRef.current?.focus();
    }
  }, [findOpen]);

  // The bar owns Escape / Enter / F3 / ⌘G while it is focused; keep the IDE keymap out.
  useEffect(() => {
    if (!findOpen) return;
    return registerKeyClaim((e) => !!(e.target as Element | null)?.closest?.("[data-run-find]"));
  }, [findOpen]);

  // A new query (or option) starts from the viewport, not from the top of the output.
  useEffect(() => {
    if (!findOpen) return;
    const next = found.matches.findIndex((match) => match.line >= findAnchor.current);
    setActive(next >= 0 ? next : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- new output keeps the current match
  }, [findOpen, query, findOptions]);

  // Bring the current match into view; expand a collapsed fold that hides it.
  useEffect(() => {
    if (!findOpen || !activeMatch) return;
    const key = `${activeMatch.lineId}:${activeMatch.start}`;
    if (scrolledMatch.current === key) return;
    const rowIndex = rowOfLine.get(activeMatch.line);
    if (rowIndex === undefined) {
      for (const row of rows) {
        const fold = row.fold;
        if (fold && activeMatch.line >= fold.start && activeMatch.line < fold.start + fold.count) {
          setExpanded((s) => {
            const next = new Set(s);
            next.add(fold.id);
            return next;
          });
          break;
        }
      }
      return;
    }
    virtualizer.scrollToIndex(rowIndex, { align: "center" });
    scrolledMatch.current = key;
  }, [findOpen, activeMatch, rowOfLine, rows, virtualizer]);

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    const selection = window.getSelection()?.toString() ?? "";
    showContextMenu(e, [
      {
        label: "Copy",
        icon: "copy",
        shortcut: formatBinding(hostBinding("Meta+C")),
        disabled: !selection,
        run: () => void navigator.clipboard?.writeText(selection).catch(() => undefined),
      },
      ...(mybatisSql && selection.includes("==>  Preparing")
        ? [
            {
              label: tx("Copy MyBatis SQL"),
              icon: "gutter-mybatis",
              run: () => {
                const sql = sqlFromMybatisLog(selection);
                if (!sql) {
                  notifications().notify({
                    group: "run",
                    level: "warning",
                    key: "mybatis-sql-convert",
                    title: "MyBatis SQL",
                    body: tx("The selection has no MyBatis SQL log to convert"),
                  });
                  return;
                }
                navigator.clipboard
                  ?.writeText(sql)
                  .catch(() =>
                    notifications().notify({
                      group: "run",
                      level: "error",
                      key: "mybatis-sql-copy",
                      title: "MyBatis SQL",
                      body: tx("Could not copy to the clipboard"),
                    }),
                  );
              },
            },
          ]
        : []),
      { label: "Copy All", run: () => void navigator.clipboard?.writeText(model.text()).catch(() => undefined) },
      {
        label: "Find…",
        icon: "search",
        shortcut: formatBinding(hostBinding("Meta+F")),
        run: openFind,
      },
      { kind: "separator" },
      { label: "Clear All", icon: "trash", disabled: !onClear, run: () => onClear?.() },
      ...(input
        ? [{ kind: "separator" } as const, { label: "Send EOF", shortcut: "⌃D", run: () => input.onEof() }]
        : []),
    ]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (hasPrimaryModifier(e) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      openFind();
      return;
    }
    if (copySelectionOnKeyDown(e)) return;
    if (!input) return;
    if (e.key === "d" && e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      input.onEof();
    } else if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      input.onSubmit(input.pending);
      input.onChange("");
    } else if (e.key === "Backspace" && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      input.onChange(e.altKey ? input.pending.replace(/\S*\s*$/, "") : [...input.pending].slice(0, -1).join(""));
    } else if (e.key.length === 1 && [...e.key].length === 1 && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      input.onChange(input.pending + e.key);
    }
  };

  const onPaste = (e: ClipboardEvent) => {
    if (!input) return;
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    const parts = (input.pending + text).replace(/\r\n?/g, "\n").split("\n");
    const rest = parts.pop() ?? "";
    for (const line of parts) input.onSubmit(line);
    input.onChange(rest);
  };

  const pendingInput = input && (
    <span className={styles.userInput}>
      {input.pending}
      <span className={styles.inputCaret} aria-hidden />
    </span>
  );
  const foldButton = (fold: Fold, attached: boolean) =>
    fold.expanded ? (
      <button
        type="button"
        className={styles.foldToggle}
        title={tx("Collapse folded lines")}
        aria-label={tx("Collapse folded lines")}
        onClick={() => toggleFold(fold.id)}
      >
        <Icon name="chevron-up" size={10} />
      </button>
    ) : (
      <button
        type="button"
        className={styles.fold}
        title={tx("Expand folded lines")}
        onClick={() => toggleFold(fold.id)}
      >
        {`${attached ? " " : ""}${fold.count === 1 ? tx`<${fold.count} internal line>` : tx`<${fold.count} internal lines>`}`}
      </button>
    );

  const items = virtualizer.getVirtualItems();
  return (
    <div className={styles.consoleWrap}>
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
        ref={scrollRef}
        className={clsx(styles.console, ansi.palette, softWrap && styles.wrap)}
        role="log"
        aria-live="off"
        aria-label={aria["aria-label"] ?? "Console"}
        tabIndex={0}
        onScroll={onScroll}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        data-autofocus=""
      >
        <div className={styles.consoleInner} style={{ height: virtualizer.getTotalSize() }}>
          {items.map((item) => {
            const row = rows[item.index];
            if (!row) {
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={softWrap ? virtualizer.measureElement : undefined}
                  className={styles.line}
                  style={{ transform: `translateY(${item.start}px)`, height: softWrap ? undefined : ROW }}
                >
                  {pendingInput}
                </div>
              );
            }
            if (row.kind === "fold") {
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={softWrap ? virtualizer.measureElement : undefined}
                  className={styles.line}
                  style={{ transform: `translateY(${item.start}px)`, height: softWrap ? undefined : ROW }}
                >
                  {foldButton(row.fold, false)}
                </div>
              );
            }
            const line = lines[row.index];
            if (!line) return null;
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={softWrap ? virtualizer.measureElement : undefined}
                className={clsx(styles.line, styles[line.kind])}
                style={{ transform: `translateY(${item.start}px)`, height: softWrap ? undefined : ROW }}
              >
                <Line line={line} marks={marksByLine.get(row.index)} length={line.text.length} cwd={cwd} />
                {row.fold && foldButton(row.fold, true)}
                {inputInline && item.index === rows.length - 1 && pendingInput}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
