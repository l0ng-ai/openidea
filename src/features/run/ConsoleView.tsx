import { writeClipboardText } from "@/platform/clipboard";
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
import { useConsoleFont } from "@/platform/consoleFont";
import { Icon, showContextMenu } from "@/ui";
import { spanStyle } from "@/ui/ansi";
import { logLineColor } from "@/ui/logColors";
import { compileConsoleRules, matchConsoleRules, styleSpans, type ConsoleRuleMatch } from "@/ui/consoleRules";
import { useConsoleRules, useOccurrenceNavigator } from "@/workbench/contributions";
import type { ConsoleLine, ConsoleModel } from "./console";
import { findOutputLinks, type OutputLink } from "./links";
import { debugConsoleUrl, openTarget, openUrl } from "./navigate";
import { segmentLine, type SegmentMark } from "./segments";
import styles from "./Run.module.css";
import { useConsoleSelection } from "./useConsoleSelection";
import { hostBinding, formatBinding, hasPrimaryModifier, registerKeyClaim } from "@/platform/keymap";
import { WidestColumns } from "@/platform/consoleColumns";
import { tx } from "@/platform/i18n";
import { executeAction } from "@/platform/actions";
import { ConsoleFindBar } from "@/ui/ConsoleFindBar";
import { DEFAULT_FIND_OPTIONS, findInCutLines, marksByRow, type FindOptions } from "@/ui/consoleFind";

/** A row cut at MAX_LINE_LENGTH: the next row continues its line. */
const cut = (line: ConsoleLine) => !!line.continues;
const MARK_COLOR = "var(--bg-search-match)";
const CURRENT_MARK_COLOR = "var(--bg-search-match-current)";

const Line = memo(
  function Line({
    line,
    marks,
    rules,
    cwd,
    currentLink,
  }: {
    line: ConsoleLine;
    marks?: readonly SegmentMark[];
    rules?: ConsoleRuleMatch;
    length: number;
    cwd: string;
    /** Start of the link Previous / Next Occurrence stepped to on this line. */
    currentLink?: number;
  }) {
    // Not memoised: the open (last) line mutates in place; `memo` below re-renders on length changes only.
    const spans = rules ? styleSpans(line.spans, rules) : line.spans;
    const segments = segmentLine(spans, line.kind === "system" ? [] : findOutputLinks(line.text), marks);
    const activate = (e: MouseEvent, link: OutputLink) => {
      e.preventDefault();
      if (window.getSelection()?.toString()) return;
      if (link.kind !== "url") void openTarget(link.target, cwd);
      else if (!debugConsoleUrl(e, link.url)) void openUrl(link.url);
    };
    // A blank line is an empty row: its height comes from CSS, never from a character in the text.
    if (segments.length === 0) return null;
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
              // oxlint-disable-next-line react/no-array-index-key -- segments repeat; position in an immutable line is stable
              key={i}
              href={seg.link.kind === "url" ? seg.link.url : undefined}
              className={clsx(styles.link, seg.link.start === currentLink && styles.currentLink)}
              style={style}
              onClick={(e) => activate(e, seg.link!)}
              role="link"
              tabIndex={-1}
              {...marked}
            >
              {seg.text}
            </a>
          ) : seg.mark ? (
            // oxlint-disable-next-line react/no-array-index-key -- segments repeat; position in an immutable line is stable
            <mark key={i} className={styles.match} style={style} {...marked}>
              {seg.text}
            </mark>
          ) : (
            // oxlint-disable-next-line react/no-array-index-key -- segments repeat; position in an immutable line is stable
            <span key={i} style={style}>
              {seg.text}
            </span>
          );
        })}
      </>
    );
  },
  (a, b) =>
    a.line === b.line &&
    a.length === b.length &&
    a.cwd === b.cwd &&
    a.marks === b.marks &&
    a.rules === b.rules &&
    a.currentLink === b.currentLink,
);

/** A file link in the output, by its line's id (stable across trimming). */
export interface LinkPosition {
  lineId: number;
  start: number;
}

export interface FileLink extends LinkPosition {
  /** Index in the console's lines. */
  line: number;
  link: OutputLink & { kind: "file" };
}

/** The file links on the `shown` lines (a collapsed fold hides its links), in output order. */
/** A copy of a line the model may still append to (the open last line). */
function copyLine(line: ConsoleLine): ConsoleLine {
  return { ...line, spans: line.spans.map((span) => ({ ...span })) };
}

export function fileLinks(lines: readonly ConsoleLine[], shown: (index: number) => boolean): FileLink[] {
  const links: FileLink[] = [];
  lines.forEach((line, i) => {
    if (line.kind === "system" || !shown(i)) return;
    for (const link of findOutputLinks(line.text))
      if (link.kind === "file") links.push({ line: i, lineId: line.id, start: link.start, link });
  });
  return links;
}

/**
 * IDEA's Up / Down the Stack Trace: the 0-based index of the link after (1) / before (-1)
 * `from` among `links`, or `null` past either end. `from` need not be among them (its line
 * was trimmed or folded): line ids only grow, so its place is still known. Without `from`
 * it starts at the first / last link.
 */
export function stepFileLink(links: readonly FileLink[], from: LinkPosition | null, dir: 1 | -1): number | null {
  let index = dir === 1 ? 0 : links.length - 1;
  if (from) {
    const after = links.findIndex((l) => l.lineId > from.lineId || (l.lineId === from.lineId && l.start >= from.start));
    const at = after < 0 ? links.length : after;
    const on = links[at]?.lineId === from.lineId && links[at]?.start === from.start;
    index = dir === 1 ? at + Number(on) : at - 1;
  }
  return index >= 0 && index < links.length ? index : null;
}

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
 * IDEA's Fold Lines Like This: the selection when it stays on one line, else the clicked line;
 * trimmed, and `null` when that leaves nothing to fold on.
 */
export function foldLineText(selection: string, line: string | null): string | null {
  const text = (selection || (line ?? "")).trim();
  return text && !/[\r\n]/.test(text) ? text : null;
}

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
      else if (fold.expanded) {
        rows.push({ kind: "line", index: i, fold });
        i++;
      } else rows.push({ kind: "fold", fold });
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
  /** Controlled find bar (the Run toolbar button); without it ⌘F opens it locally. */
  findOpen?: boolean;
  onFindOpenChange?: (open: boolean) => void;
  /** Tool window whose Previous / Next Occurrence step through the file links in the output. */
  occurrences?: string;
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
  findOpen: controlledFindOpen,
  onFindOpenChange,
  occurrences,
  ...aria
}: ConsoleViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  // Pause Output: the output so far stays on screen while the process keeps
  // writing; resuming shows everything that arrived meanwhile.
  const [paused, setPaused] = useState<readonly ConsoleLine[] | null>(null);
  const lines = paused ?? model.lines;
  const togglePaused = () =>
    setPaused((p) => (p ? null : model.lines.map((l, i, all) => (i === all.length - 1 ? copyLine(l) : l))));
  const patterns = useWorkflowSettings((s) => s.console.foldPatterns);
  const logColors = useWorkflowSettings((s) => s.console.logColors);
  const consoleRules = compileConsoleRules(useConsoleRules((s) => s.providers));
  // The Run console uses Tools › Terminal › Font (which can follow Editor › Font),
  // so the font and fallback configured there apply to process output too.
  const consoleFont = useConsoleFont();
  const { rowHeight } = consoleFont;
  /** A row's box: at its virtual offset, and never shorter than one line — a blank line has no text. */
  const rowStyle = (start: number) => ({
    transform: `translateY(${start}px)`,
    height: softWrap ? undefined : rowHeight,
    minHeight: rowHeight,
  });
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
    !!input && !!model.openLine && lastRow?.kind === "line" && lines[lastRow.index] === model.openLine;
  const inputRow = !!input && !inputInline;
  const [widest] = useState(() => new WidestColumns());
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` marks in-place appends to `lines`
  const columns = useMemo(() => widest.measure(lines), [widest, lines, version]);
  const rows = folded;
  const count = rows.length + (inputRow ? 1 : 0);
  const toggleFold = (id: number) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const programmatic = useRef(false);

  const { rangeExtractor, selecting } = useConsoleSelection(scrollRef, () => onFollowChange(false));
  const virtualizer = useVirtualizer({
    rangeExtractor,
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 30,
    getItemKey: (i) => {
      const r = rows[i];
      if (!r) return "input";
      return r.kind === "fold" ? r.fold.id : (lines[r.index]?.id ?? i);
    },
  });

  // Soft wrap changes row heights; re-measure everything.
  useEffect(() => {
    virtualizer.measure();
  }, [softWrap, rowHeight, virtualizer]);

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
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < rowHeight;
    if (atBottom && selecting) return;
    if (atBottom !== follow) onFollowChange(atBottom);
  };

  // Find (⌘F): search the whole buffer, not just the rendered rows.
  const found = useMemo(
    () =>
      findOpen ? findInCutLines(lines, cut, query, findOptions) : { matches: [], overflow: false, invalid: false },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` marks in-place appends to `lines`
    [findOpen, lines, version, query, findOptions],
  );
  const activeIndex = found.matches.length ? Math.min(Math.max(active, 0), found.matches.length - 1) : -1;
  const activeMatch = activeIndex >= 0 ? found.matches[activeIndex] : undefined;
  const marksByLine = useMemo(() => marksByRow(found.matches, activeIndex, lines, cut), [found, activeIndex, lines]);
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
    return registerKeyClaim((e) => !!(e.target as Element | null)?.closest?.("[data-console-find]"));
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

  const [currentLink, setCurrentLink] = useState<LinkPosition | null>(null);
  // Read by key repeat before the next render; the links are found on demand, once per output change.
  const stepFrom = useRef<LinkPosition | null>(null);
  const linksCache = useRef<{ rows: Map<number, number>; links: FileLink[] } | null>(null);
  useOccurrenceNavigator(occurrences ?? null, (dir, focus) => {
    if (linksCache.current?.rows !== rowOfLine)
      linksCache.current = { rows: rowOfLine, links: fileLinks(lines, (i) => rowOfLine.has(i)) };
    const { links } = linksCache.current;
    const index = stepFileLink(links, stepFrom.current, dir);
    if (index === null) return null;
    const hit = links[index]!;
    stepFrom.current = { lineId: hit.lineId, start: hit.start };
    setCurrentLink(stepFrom.current);
    onFollowChange(false);
    programmatic.current = true;
    virtualizer.scrollToIndex(rowOfLine.get(hit.line)!, { align: "center" });
    requestAnimationFrame(() => (programmatic.current = false));
    void openTarget(hit.link.target, cwd, focus);
    return { index: index + 1, total: links.length };
  });

  /** Rows are virtualized, so "everything" is a selection of the container, not of the mounted rows. */
  const selectAll = () => {
    const inner = innerRef.current;
    if (inner) window.getSelection()?.selectAllChildren(inner);
  };
  const allSelected = () => {
    const inner = innerRef.current;
    const s = window.getSelection();
    return (
      !!inner &&
      !!s &&
      !s.isCollapsed &&
      s.anchorNode === inner &&
      s.focusNode === inner &&
      s.anchorOffset === 0 &&
      s.focusOffset === inner.childNodes.length
    );
  };
  /** The selected text; after Select All the whole buffer, including rows that are not mounted. */
  const selectedOutput = () => (allSelected() ? model.text() : (window.getSelection()?.toString() ?? ""));

  /** The output line a context menu opened on; folds and the input row have none. */
  const lineAt = (target: EventTarget) => {
    const index = (target as Element).closest?.("[data-index]")?.getAttribute("data-index");
    const row = index == null ? undefined : rows[Number(index)];
    const line = row?.kind === "line" ? lines[row.index] : undefined;
    return line && line.kind !== "system" ? line.text : null;
  };

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    const selection = selectedOutput();
    const foldText = foldLineText(selection, lineAt(e.target));
    showContextMenu(e, [
      {
        label: "Copy",
        icon: "copy",
        shortcut: formatBinding(hostBinding("Meta+C")),
        disabled: !selection,
        run: () => void writeClipboardText(selection).catch(() => undefined),
      },
      { label: "Select All", shortcut: formatBinding(hostBinding("Meta+A")), run: selectAll },
      { label: "Copy All", run: () => void writeClipboardText(model.text()).catch(() => undefined) },
      {
        label: "Find…",
        icon: "search",
        shortcut: formatBinding(hostBinding("Meta+F")),
        run: openFind,
      },
      { kind: "separator" },
      {
        label: "Fold Lines Like This",
        disabled: !foldText,
        // Opens Settings › Console with the text added to the fold patterns, for OK / Cancel there.
        run: () => void executeAction("file.settings", `build.console#${foldText}`),
      },
      { label: "Pause Output", icon: "pause", checked: !!paused, run: togglePaused },
      {
        label: "Clear All",
        icon: "trash",
        disabled: !onClear,
        run: () => {
          setPaused(null);
          onClear?.();
        },
      },
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
    if (hasPrimaryModifier(e) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "a") {
      e.preventDefault();
      selectAll();
      return;
    }
    if (copySelectionOnKeyDown(e, selectedOutput)) return;
    if (!input || e.target instanceof HTMLButtonElement) return;
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
        key={fold.id}
        type="button"
        className={styles.foldToggle}
        style={{ height: rowHeight }}
        title={tx("Collapse folded lines")}
        aria-label={tx("Collapse folded lines")}
        aria-expanded={true}
        onClick={() => toggleFold(fold.id)}
      >
        <Icon name="chevron-down" size={10} />
      </button>
    ) : (
      <button
        key={fold.id}
        type="button"
        className={styles.fold}
        title={tx("Expand folded lines")}
        aria-expanded={false}
        onClick={() => toggleFold(fold.id)}
      >
        {`${attached ? " " : ""}${fold.count === 1 ? tx`<${fold.count} internal line>` : tx`<${fold.count} internal lines>`}`}
      </button>
    );

  const items = virtualizer.getVirtualItems();
  return (
    <div className={styles.consoleWrap}>
      {/* A console whose find bar is not driven by a toolbar (a stack-trace tab, say) still
          needs a visible way in: the same Find the Run toolbar offers, over the output. */}
      {controlledFindOpen === undefined && !findOpen && (
        <button
          type="button"
          className={styles.consoleFindOpen}
          title="Find…"
          aria-label="Find in console"
          onClick={() => setFindOpen(true)}
        >
          <Icon name="search" size={14} />
        </button>
      )}
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
        className={clsx(styles.console, softWrap && styles.wrap)}
        style={{
          fontFamily: consoleFont.family,
          fontSize: `${consoleFont.size}px`,
          fontWeight: consoleFont.weight,
          ["--fw-code-bold" as string]: String(consoleFont.boldWeight),
          lineHeight: `${rowHeight}px`,
        }}
        role="log"
        aria-live="off"
        aria-label={aria["aria-label"] ?? "Console"}
        tabIndex={0}
        onScroll={onScroll}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
        onCopy={(e) => {
          // Native copy (menu, macOS) would take only the mounted rows.
          if (!allSelected()) return;
          e.preventDefault();
          e.clipboardData.setData("text/plain", model.text());
        }}
        onPaste={onPaste}
        data-autofocus=""
      >
        <div
          ref={innerRef}
          className={styles.consoleInner}
          style={{
            height: virtualizer.getTotalSize(),
            // Rows are mounted only near the viewport; the widest line sets the scroll width.
            minWidth: softWrap ? undefined : `calc(${columns}ch + 24px)`,
          }}
        >
          {items.map((item) => {
            const row = rows[item.index];
            if (!row) {
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={softWrap ? virtualizer.measureElement : undefined}
                  className={styles.line}
                  style={rowStyle(item.start)}
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
                  style={rowStyle(item.start)}
                >
                  {foldButton(row.fold, false)}
                </div>
              );
            }
            const line = lines[row.index];
            if (!line) return null;
            // A plugin's whole-line rule replaces the level colour. The level colour is the
            // inherited fallback; spans with their own ANSI colour win (rule styles replace those).
            const ruled = matchConsoleRules(line.text, line.kind, consoleRules);
            const color = ruled?.line ? ruled.line.fg : logLineColor(line.text, line.kind, logColors);
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={softWrap ? virtualizer.measureElement : undefined}
                className={clsx(styles.line, styles[line.kind])}
                style={{ ...rowStyle(item.start), color, background: ruled?.line?.bg }}
              >
                {row.fold?.expanded && foldButton(row.fold, false)}
                <Line
                  line={line}
                  marks={marksByLine.get(row.index)}
                  rules={ruled}
                  length={line.text.length}
                  cwd={cwd}
                  currentLink={currentLink?.lineId === line.id ? currentLink.start : undefined}
                />
                {row.fold && !row.fold.expanded && foldButton(row.fold, true)}
                {inputInline && item.index === rows.length - 1 && pendingInput}
                {/* A row cut at MAX_LINE_LENGTH continues on the next: no line break in a copied selection. */}
                {!line.continues && "\n"}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
