/**
 * Colors the language servers report (`textDocument/documentColor`: Tailwind classes, CSS values…).
 * A color the built-in literal preview already shows at the same range gets no second swatch, and
 * picking a color writes it the way the server presents it (`textDocument/colorPresentation`).
 */
import { RangeSet, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { ViewPlugin, gutter, type ViewUpdate } from "@codemirror/view";
import {
  offsetsToRange,
  rangeToOffsets,
  shownAgain,
  textEditsToChanges,
  whenSynced,
  type EditorDocContext,
} from "@/editor/api";
import { onServerSettled } from "@/editor/lsp/availability";
import { comparePos } from "@/editor/lsp/positions";
import { editorPrefs } from "@/platform/editorSettings";
import { call, commands, type DocumentColor } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { lineColor } from "./gutter";
import { ProviderSwatch } from "./providerSwatch";
import styles from "./ColorPreview.module.css";

const setColors = StateEffect.define<DocumentColor[]>();
const colors = StateField.define<DocumentColor[]>({
  create: () => [],
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setColors)) return e.value;
    return tr.docChanged ? [] : v;
  },
});

/** Settings › Editor › General › Gutter Icons › Color preview. */
function colorsShown(settings?: unknown): boolean {
  const prefs = editorPrefs(settings);
  return prefs.showGutterIcons && !prefs.gutterIconsDisabled.includes("colors");
}

/**
 * The server colors without a built-in swatch for the same text, one per range when several
 * servers (CSS and Tailwind) report it.
 */
export function serverOnlyColors(state: EditorState, language: string, list: DocumentColor[]): DocumentColor[] {
  const scanned = new Set<number>();
  const taken = new Set<string>();
  return list.filter((color) => {
    const { from, to } = rangeToOffsets(state.doc, color.range);
    const { start, end } = offsetsToRange(state.doc, from, to);
    if (from === to || comparePos(start, color.range.start) || comparePos(end, color.range.end)) return false;
    const line = state.doc.lineAt(from);
    if (!scanned.has(line.number)) {
      scanned.add(line.number);
      const literal = lineColor(state, line.from, language);
      if (literal) taken.add(`${line.from + literal.from}:${line.from + literal.to}`);
    }
    const key = `${from}:${to}`;
    if (taken.has(key)) return false;
    taken.add(key);
    return true;
  });
}

export function lspColorPreview(ctx: EditorDocContext): Extension {
  if (ctx.doc < 0) return [];
  return [
    colors,
    gutter({
      class: `${styles.gutter} cm-openidea-gutter-colors cm-lsp-color-preview`,
      markers: (view) =>
        RangeSet.of(
          view.state.field(colors).map((c) =>
            new ProviderSwatch(`lsp:${c.server}`, c, view, async (chosen) => {
              const list = await call(commands.lspColorPresentations(ctx.doc, chosen));
              return list.map((p) => ({ label: p.label, changes: textEditsToChanges(view.state.doc, p.edits) }));
            }).range(view.state.doc.line(c.range.start.line + 1).from),
          ),
          true,
        ),
    }),
    ViewPlugin.define(
      (view) =>
        new (class {
          timer: ReturnType<typeof setTimeout> | undefined;
          generation = 0;
          skipped = false;
          shown = colorsShown();
          off: () => void;
          constructor() {
            const offs = [
              onServerSettled(() => this.schedule()),
              useProject.subscribe((s, prev) => {
                if (s.settings !== prev.settings && colorsShown(s.settings) !== this.shown) this.schedule();
              }),
            ];
            this.off = () => offs.forEach((f) => f());
            this.schedule();
          }
          schedule() {
            this.generation++;
            clearTimeout(this.timer);
            this.timer = setTimeout(() => void this.run(), 300);
          }
          update(u: ViewUpdate) {
            if (u.docChanged || (this.skipped && shownAgain(u))) this.schedule();
          }
          clear() {
            if (view.dom.isConnected && view.state.field(colors).length) view.dispatch({ effects: setColors.of([]) });
          }
          async run() {
            const gen = this.generation;
            const text = view.state.doc;
            this.shown = colorsShown();
            if (!this.shown) return this.clear();
            try {
              await whenSynced(view);
              const list = await call(commands.lspDocumentColors(ctx.doc));
              if (gen !== this.generation || view.state.doc !== text) return;
              this.skipped = !view.dom.isConnected;
              if (!this.skipped)
                view.dispatch({ effects: setColors.of(serverOnlyColors(view.state, ctx.language, list)) });
            } catch {
              // No server colors this document, or it went away.
              if (gen === this.generation) this.clear();
            }
          }
          destroy() {
            this.generation++;
            clearTimeout(this.timer);
            this.off();
          }
        })(),
    ),
  ];
}
