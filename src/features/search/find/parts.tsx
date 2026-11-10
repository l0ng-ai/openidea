import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { EditorState, StateEffect, StateField, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, keymap, drawSelection, type DecorationSet } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { attachDocument, codePreviewExtensions, type DocumentAttachment } from "@/editor/api";
import { tokenSpans, useLineTokens, type LineSource } from "@/editor/lineTokens";
import { effectiveBindings, registerKeyClaim } from "@/platform/keymap";
import { getAction } from "@/platform/actions";
import type { SearchQuery } from "@/platform/ipc";
import { previewReplacement } from "./session";
import { releasePreview, takePreview } from "./preview";
import { notifications } from "@/workbench/contributions";
import type { PreviewLine } from "./replaceFlow";
import styles from "./parts.module.css";
import { T } from "@/ui";
import { t, tx } from "@/platform/i18n";

/**
 * A result line with matches highlighted; in replace mode shows `old → new`
 * inline. With `source`, syntax-coloured with the whole file as context.
 */
export function MatchText({
  text,
  ranges,
  replacement,
  query,
  preserveCase = false,
  source,
}: {
  text: string;
  ranges: ReadonlyArray<readonly [number, number]>;
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
        <mark key={i} className={styles.match}>
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
 * A secondary editor of `path`, sharing the document and its save pipeline,
 * scrolled to `line`, with the matches of `highlights` marked; the editor's
 * look via `codePreviewExtensions`. Read-only documents stay selectable.
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
    if (!path) return;
    let alive = true;
    let view: EditorView | null = null;
    let attachment: DocumentAttachment | null = null;
    let unclaim = () => {};
    const timer = setTimeout(async () => {
      try {
        const held = takePreview(path);
        attachment = held ?? (await attachDocument(path, { sharedHistory: true }));
        if (!alive) {
          attachment.release();
          return;
        }
        const att = attachment;
        const extensions = await codePreviewExtensions(path, !att.readOnly);
        if (!alive) {
          releasePreview(att);
          return;
        }
        const fail = (error: unknown) =>
          notifications().notify({ level: "error", title: t("app.unsaved.saveFailed"), body: String(error) });
        view = new EditorView({
          parent: hostRef.current!,
          state:
            att.editorState() ??
            EditorState.create({
              doc: att.text(),
              extensions: [
                extensions,
                previewMarks,
                att.extension,
                drawSelection(),
                keymap.of([
                  { key: "Mod-z", run: () => att.undo(), preventDefault: true },
                  { key: "Mod-Shift-z", run: () => att.redo(), preventDefault: true },
                  { key: "Mod-y", run: () => att.redo(), preventDefault: true },
                  {
                    key: "Mod-s",
                    run: () => {
                      void att.save().catch(fail);
                      return true;
                    },
                  },
                  ...defaultKeymap.filter((binding) => binding.key !== "Escape"),
                ]),
                att.readOnly ? readOnly : [],
              ],
            }),
          dispatchTransactions: (transactions, editor) => att.dispatchTransactions(transactions, editor),
        });
        // Text-editor actions otherwise target the tab behind the popup. Let this view's keymap own editing.
        unclaim = registerKeyClaim(
          (event, stroke) =>
            !!view?.dom.contains(event.target as Node) &&
            effectiveBindings().some(
              ([binding, id]) => binding === stroke && !!getAction(id)?.when?.includes("editorTextFocus"),
            ),
        );
        viewRef.current = view;
        setLoaded({ path, version });
        setError(null);
      } catch (error) {
        if (attachment) releasePreview(attachment);
        attachment = null;
        if (alive) setError(String((error as Error)?.message ?? error));
      }
    }, 80);
    return () => {
      alive = false;
      clearTimeout(timer);
      unclaim();
      viewRef.current = null;
      if (view) {
        view.destroy();
        if (attachment) releasePreview(attachment);
      }
    };
  }, [path, version]);

  const current = !!path && loaded?.path === path && loaded.version === version;
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
    <div
      className={styles.preview}
      role="region"
      aria-label={tx("Preview")}
      onKeyDown={(event) => {
        if (event.key !== "Escape") event.stopPropagation();
      }}
    >
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
