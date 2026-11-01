/**
 * Read-only source view around a line, with line numbers and highlighted
 * ranges: the preview pane beside result trees (TODO, Problems, Inspection
 * Results…). The caller supplies the text loader (open buffer or disk).
 *
 * Lines are syntax-coloured with the whole file parsed once (`codeHighlighter`),
 * so a line inside a block comment or multi-line string is coloured as such —
 * like the result lines of Find in Files / Show Usages (`lineTokens`). Files
 * beyond `MAX_PARSE` stay plain rather than colouring the window with the wrong
 * block-comment context. (This makes the preview the first `src/ui` component
 * to import from `@/editor`; verified no cycle — editor/lsp/markdown only
 * reaches back into `src/ui` through leaf files like selectableText.)
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { tokenSpans } from "@/editor/lineTokens";
import { codeHighlighter, languageForPath, type CodeToken } from "@/editor/lsp/markdown";
import { T } from "./T";
import styles from "./SourcePreview.module.css";
import { tx } from "@/platform/i18n";

export interface SourceHighlight {
  line: number;
  /** UTF-16 column ranges in the line. */
  ranges: ReadonlyArray<readonly [number, number]>;
}

/** Lines rendered on each side of the current one. */
const WINDOW = 300;

/** Files larger than this aren't parsed for colouring (same cap as `lineTokens`). */
const MAX_PARSE = 500_000;

/** Whole-file highlighter over the parsed text, or null when it stays plain. */
type Highlighter = ((from: number, to: number) => CodeToken[]) | null;

export interface SourcePreviewProps {
  path: string | null;
  /** 0-based line to centre and mark as current. */
  line: number;
  highlights?: readonly SourceHighlight[];
  /** Stable (module-level) loader; a new function reloads. */
  load: (path: string) => Promise<string>;
  /** Bump to reload the same path. */
  version?: number;
  className?: string;
}

export function SourcePreview({ path, line, highlights = [], load, version = 0, className }: SourcePreviewProps) {
  const [text, setText] = useState<{ path: string; lines: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [highlighter, setHighlighter] = useState<{ path: string; fn: Highlighter } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const current = text && text.path === path ? text : null;

  useEffect(() => {
    if (!path) return;
    let alive = true;
    // Debounced so arrowing through results doesn't load every file.
    const t = setTimeout(() => {
      load(path).then(
        (content) => {
          if (!alive) return;
          setText({ path, lines: content.split(/\r\n|\r|\n/) });
          setError(null);
        },
        (e) => alive && setError(String((e as Error)?.message ?? e)),
      );
    }, 80);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [path, version, load]);

  // One whole-file parse per loaded text: `current` changes identity only when
  // another text loads, not when the centred line moves. Grammar loading is
  // async, so the pane renders plain first and recolours when the parse lands;
  // `alive` drops late results after a fast switch to another file.
  useEffect(() => {
    if (!current) return;
    let alive = true;
    const { path } = current;
    const full = current.lines.join("\n");
    const build = full.length > MAX_PARSE ? Promise.resolve(null) : codeHighlighter(full, languageForPath(path));
    void build.then((fn) => {
      if (alive) setHighlighter({ path, fn });
    });
    return () => {
      alive = false;
    };
  }, [current]);

  useLayoutEffect(() => {
    const box = scrollRef.current;
    const el = box?.querySelector<HTMLElement>(`[data-line="${line}"]`);
    if (box && el) box.scrollTop = el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2;
  }, [current, line]);

  // Offsets of every line in the newline-normalised text, so whole-file token
  // ranges can be sliced per rendered line.
  const offsets = useMemo(() => {
    if (!current) return null;
    const o = new Array<number>(current.lines.length);
    let at = 0;
    for (let i = 0; i < current.lines.length; i++) {
      o[i] = at;
      at += current.lines[i]!.length + 1;
    }
    return o;
  }, [current]);

  // The window's whole-file token ranges, sliced per line into in-line offsets.
  const tokensByLine = useMemo(() => {
    if (!current || !offsets) return null;
    const fn = highlighter?.path === current.path ? highlighter.fn : null;
    if (!fn) return null;
    const lines = current.lines;
    const start = Math.max(0, line - WINDOW);
    const end = Math.min(lines.length, line + WINDOW);
    const last = lines.length - 1;
    const map = new Map<number, CodeToken[]>();
    let li = start;
    const from = offsets[start]!;
    const to = end < offsets.length ? offsets[end]! : offsets[last]! + (lines[last]?.length ?? 0);
    for (const t of fn(from, to)) {
      // A token may span lines (a block comment); clip it into each covered line.
      while (li + 1 < end && offsets[li + 1]! <= t.from) li++;
      for (let n = li; n < end && offsets[n]! < t.to; n++) {
        const at = offsets[n]!;
        const s = Math.max(t.from, at) - at;
        const e = Math.min(t.to, at + (lines[n]?.length ?? 0)) - at;
        if (e > s) {
          const spans = map.get(n) ?? [];
          spans.push({ from: s, to: e, cls: t.cls });
          map.set(n, spans);
        }
      }
    }
    return map;
  }, [current, offsets, highlighter, line]);

  if (!path)
    return (
      <div className={clsx(styles.preview, styles.empty, className)}>
        <T>Select an item to preview</T>
      </div>
    );
  if (error && !current) return <div className={clsx(styles.preview, styles.empty, className)}>{error}</div>;
  if (!current) return <div className={clsx(styles.preview, className)} />;

  const byLine = new Map(highlights.map((h) => [h.line, h.ranges]));
  const start = Math.max(0, line - WINDOW);
  const end = Math.min(current.lines.length, line + WINDOW);
  const rows: ReactNode[] = [];
  for (let n = start; n < end; n++) {
    const content = current.lines[n] ?? "";
    const ranges = byLine.get(n);
    const lineTokens = tokensByLine?.get(n);
    rows.push(
      <div key={n} data-line={n} className={clsx(styles.codeLine, n === line && styles.currentLine)}>
        <span className={styles.gutter}>{n + 1}</span>
        <span className={styles.code}>
          {ranges || lineTokens?.length ? highlight(content, ranges ?? [], lineTokens ?? null) : content || " "}
        </span>
      </div>,
    );
  }
  return (
    <div ref={scrollRef} className={clsx(styles.preview, className)} role="region" aria-label={tx("Preview")}>
      <pre className={styles.pre}>{rows}</pre>
    </div>
  );
}

/** `text` with `ranges` marked up; every segment coloured by the line's `tokens`. */
function highlight(
  text: string,
  ranges: ReadonlyArray<readonly [number, number]>,
  tokens: readonly CodeToken[] | null,
): ReactNode[] {
  const parts: ReactNode[] = [];
  let pos = 0;
  [...ranges]
    .sort((a, b) => a[0] - b[0])
    .forEach(([s, e], i) => {
      if (s < pos || e <= s) return;
      if (s > pos) parts.push(...tokenSpans(text, pos, s, tokens, `g${i}:`));
      parts.push(
        <mark key={i} className={styles.match}>
          {tokenSpans(text, s, e, tokens, `m${i}:`)}
        </mark>,
      );
      pos = e;
    });
  if (pos < text.length) parts.push(...tokenSpans(text, pos, text.length, tokens, "t:"));
  return parts;
}
