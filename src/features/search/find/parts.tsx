import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { EditorState, StateEffect, StateField, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { codePreviewExtensions } from "@/editor/api";
import { tokenSpans, useLineTokens, type LineSource } from "@/editor/lineTokens";
import type { SearchQuery } from "@/platform/ipc";
import { previewReplacement } from "./session";
import { loadPreviewText } from "./preview";
import type { PreviewLine } from "./replaceFlow";
import styles from "./parts.module.css";
import { T } from "@/ui";
import { tx } from "@/platform/i18n";

/**
 * A result line with matches highlighted; in replace mode shows `old → new`
 * inline. With `source`, syntax-coloured with the whole file as context.
 */
export function MatchText({
  text,
  ranges,
  active,
  replacement,
  query,
  preserveCase = false,
  source,
}: {
  text: string;
  ranges: ReadonlyArray<readonly [number, number]>;
  active?: boolean;
  replacement?: string | null;
  query?: Pick<SearchQuery, "pattern" | "isRegex" | "caseSensitive"> | null;
  preserveCase?: boolean;
  source?: LineSource;
}) {
  const tokens = useLineTokens(source, text);
  const parts: ReactNode[] = [];
  let pos = 0;
  ranges.forEach(([s, e], i) => {
    if (s < pos) return;
    if (s > pos) parts.push(...tokenSpans(text, pos, s, tokens, `g${i}:`));
    const matched = text.slice(s, e);
    if (replacement != null && query) {
      parts.push(
        <del key={`d${i}`} className={styles.removed}>
          {matched}
        </del>,
        <ins key={`i${i}`} className={styles.inserted}>
          {previewReplacement(matched, query, replacement, preserveCase)}
        </ins>,
      );
    } else {
      parts.push(
        <mark key={i} className={clsx(styles.match, active && styles.matchActive)}>
          {tokenSpans(text, s, e, tokens, "")}
        </mark>,
      );
    }
    pos = e;
  });
  if (pos < text.length) parts.push(...tokenSpans(text, pos, text.length, tokens, "end:"));
  return <span className={clsx(styles.text, styles.code)}>{parts}</span>;
}

const WINDOW = 300;

export interface PreviewHighlight {
  line: number;
  /** Columns in the real line. */
  ranges: ReadonlyArray<readonly [number, number]>;
}

const setPreviewMarks = StateEffect.define<DecorationSet>();
const previewMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (value, tr) => {
    for (const e of tr.effects) if (e.is(setPreviewMarks)) return e.value;
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});
const matchMark = Decoration.mark({ class: "cm-openidea-findMatch" });
const currentMatchMark = Decoration.mark({ class: "cm-openidea-findMatch cm-openidea-findMatch-current" });
const currentLineMark = Decoration.line({ class: "cm-activeLine" });
const readOnly = [EditorState.readOnly.of(true), EditorView.editable.of(false)];

/** Match and current-line decorations for `highlights` (0-based lines, UTF-16 columns). */
export function previewDecorations(doc: Text, line: number, highlights: readonly PreviewHighlight[]): DecorationSet {
  const out: Array<Range<Decoration>> = [];
  if (line >= 0 && line < doc.lines) out.push(currentLineMark.range(doc.line(line + 1).from));
  for (const h of highlights) {
    if (h.line < 0 || h.line >= doc.lines) continue;
    const l = doc.line(h.line + 1);
    for (const [a, b] of h.ranges) {
      const from = l.from + Math.min(a, l.length);
      const to = l.from + Math.min(b, l.length);
      if (to > from) out.push((h.line === line ? currentMatchMark : matchMark).range(from, to));
    }
  }
  return Decoration.set(out, true);
}

/**
 * Read-only, syntax-highlighted view of `path` (live editor buffer or disk)
 * scrolled to `line`, with the matches of `highlights` marked; the editor's
 * look via `codePreviewExtensions`. Text stays selectable and copyable.
 */
export function CodePreview({
  path,
  line,
  highlights,
  version = 0,
}: {
  path: string | null;
  line: number;
  highlights: readonly PreviewHighlight[];
  version?: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [loaded, setLoaded] = useState<{ path: string; version: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef({ line, highlights });
  useLayoutEffect(() => {
    latest.current = { line, highlights };
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({ parent: host, state: EditorState.create({ extensions: [previewMarks, readOnly] }) });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!path) return;
    let alive = true;
    // Debounced so arrowing through results doesn't load every file.
    const t = setTimeout(() => {
      Promise.all([loadPreviewText(path), codePreviewExtensions(path)]).then(
        ([text, extensions]) => {
          const view = viewRef.current;
          if (!alive || !view) return;
          view.setState(EditorState.create({ doc: text, extensions: [extensions, previewMarks, readOnly] }));
          setLoaded({ path, version });
          setError(null);
        },
        (e) => alive && setError(String((e as Error)?.message ?? e)),
      );
    }, 80);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [path, version]);

  const current = !!path && loaded?.path === path;
  // A new file or line scrolls to the line; new highlights alone only repaint.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !current) return;
    const { line, highlights } = latest.current;
    const doc = view.state.doc;
    const effects: StateEffect<unknown>[] = [setPreviewMarks.of(previewDecorations(doc, line, highlights))];
    if (line >= 0 && line < doc.lines)
      effects.push(EditorView.scrollIntoView(doc.line(line + 1).from, { y: "center" }));
    view.dispatch({ effects });
  }, [current, loaded, line]);
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !current) return;
    view.dispatch({ effects: setPreviewMarks.of(previewDecorations(view.state.doc, latest.current.line, highlights)) });
  }, [current, highlights]);

  const placeholder = !path ? <T>Select a result to preview</T> : error && !current ? error : null;
  return (
    <div className={styles.preview} role="region" aria-label={tx("Preview")}>
      <div ref={hostRef} className={clsx(styles.previewEditor, (!current || placeholder) && styles.previewHidden)} />
      {placeholder && <div className={styles.previewEmpty}>{placeholder}</div>}
    </div>
  );
}

/** Replace › Preview: unified line diff of the replacement around `line`. */
export function ReplaceDiffPreview({ lines, line }: { lines: readonly PreviewLine[] | null; line: number }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = scrollRef.current;
    const el = box?.querySelector<HTMLElement>("[data-focus]");
    if (box && el) box.scrollTop = el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2;
  }, [lines, line]);
  if (!lines) return <div className={styles.preview} />;
  const focus = lines.findIndex((l) => l.kind !== "same" && (l.kind === "del" ? l.line >= line : true));
  const from = Math.max(0, focus - WINDOW);
  const shown = lines.slice(from, Math.max(focus, 0) + WINDOW);
  return (
    <div ref={scrollRef} className={styles.preview} role="region" aria-label={tx("Replace preview")}>
      <pre className={styles.pre}>
        {shown.map((l, i) => (
          <div
            key={from + i}
            data-focus={from + i === focus ? "" : undefined}
            data-kind={l.kind}
            className={clsx(
              styles.codeLine,
              l.kind === "del" && styles.lineDeleted,
              l.kind === "add" && styles.lineAdded,
            )}
          >
            <span className={styles.gutter}>{l.line + 1}</span>
            <span className={styles.sign}>{l.kind === "del" ? "-" : l.kind === "add" ? "+" : " "}</span>
            <span className={styles.code}>{l.text || " "}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}
