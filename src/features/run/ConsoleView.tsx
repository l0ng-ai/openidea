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
import { segmentLine } from "./segments";
import styles from "./Run.module.css";
import { tx } from "@/platform/i18n";

const ROW = 20;

const Line = memo(
  function Line({ line, cwd }: { line: ConsoleLine; length: number; cwd: string }) {
    // Not memoised: the open (last) line mutates in place; `memo` below re-renders on length changes only.
    const segments = segmentLine(line.spans, line.kind === "system" ? [] : findOutputLinks(line.text));
    const activate = (e: MouseEvent, link: OutputLink) => {
      e.preventDefault();
      if (window.getSelection()?.toString()) return;
      if (link.kind === "url") void openUrl(link.url);
      else void openTarget(link.target, cwd);
    };
    if (segments.length === 0) return <>{"​"}</>;
    return (
      <>
        {segments.map((seg, i) =>
          seg.link ? (
            <a
              key={i}
              href={seg.link.kind === "url" ? seg.link.url : undefined}
              className={styles.link}
              style={spanStyle(seg.style)}
              onClick={(e) => activate(e, seg.link!)}
              role="link"
              tabIndex={-1}
            >
              {seg.text}
            </a>
          ) : (
            <span key={i} style={spanStyle(seg.style)}>
              {seg.text}
            </span>
          ),
        )}
      </>
    );
  },
  (a, b) => a.line === b.line && a.length === b.length && a.cwd === b.cwd,
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
  ...aria
}: ConsoleViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lines = model.lines;
  const patterns = useWorkflowSettings((s) => s.console.foldPatterns);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
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

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    const selection = window.getSelection()?.toString() ?? "";
    showContextMenu(e, [
      {
        label: "Copy",
        icon: "copy",
        shortcut: "⌘C",
        disabled: !selection,
        run: () => void navigator.clipboard?.writeText(selection).catch(() => undefined),
      },
      { label: "Copy All", run: () => void navigator.clipboard?.writeText(model.text()).catch(() => undefined) },
      { kind: "separator" },
      { label: "Clear All", icon: "trash", disabled: !onClear, run: () => onClear?.() },
      ...(input
        ? [{ kind: "separator" } as const, { label: "Send EOF", shortcut: "⌃D", run: () => input.onEof() }]
        : []),
    ]);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!input || e.nativeEvent.isComposing) return;
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
              <Line line={line} length={line.text.length} cwd={cwd} />
              {row.fold && foldButton(row.fold, true)}
              {inputInline && item.index === rows.length - 1 && pendingInput}
            </div>
          );
        })}
      </div>
    </div>
  );
}
