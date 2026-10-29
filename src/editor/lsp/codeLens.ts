/**
 * "N usages" code lenses above declarations (IDEA's usages inlay). Cheap by
 * construction: only declarations in (and near) the viewport are counted, one
 * debounced pass after edits / scrolling, results cached per document text
 * and symbol, and at most a few reference requests in flight. Beside each
 * count, the declaration's last author from VCS blame (`authorLens`).
 */
import { EditorSelection, MapMode, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { codeLenses, type CodeLens } from "@/editor/api";
import { executeAction } from "@/platform/actions";
import { commands, nextRequestId, type OutlineItem, type SymbolKind } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { debounce, docOf, isUnavailable, lspRequest } from "./lsp";
import { posToOffset } from "./positions";
import { featureBackoff, onLspRefresh } from "./availability";
import { editorPrefs } from "@/platform/editorSettings";
import { authorLabel, authorSummary, authorTooltip, blameFor, onBlameInvalidated } from "./authorLens";
import { tx } from "@/platform/i18n";

const LENS_KINDS = new Set<SymbolKind>([
  "class",
  "interface",
  "struct",
  "enum",
  "trait",
  "function",
  "method",
  "constructor",
  "typeAlias",
  "macro",
]);

const MAX_PER_PASS = 40;
const CONCURRENCY = 4;
/** Lines above/below the viewport that are counted too, so scrolling feels instant. */
const MARGIN_LINES = 60;
const usagesBackoff = featureBackoff();

export interface LensTarget {
  name: string;
  /** 0-based line / UTF-16 col of the identifier. */
  line: number;
  col: number;
  /** 0-based lines of the whole declaration. */
  startLine: number;
  endLine: number;
}

/** Servers name callbacks and anonymous functions (`<function>`, `map() callback`); they have no usages. */
const anonymous = (name: string) => /^<.*>$/.test(name) || / callback$/.test(name);

/** Declarations worth a usages lens, in document order. Exported for tests. */
export function lensTargets(items: readonly OutlineItem[]): LensTarget[] {
  const out: LensTarget[] = [];
  const walk = (list: readonly OutlineItem[]) => {
    for (const it of list) {
      if (LENS_KINDS.has(it.kind) && !anonymous(it.name))
        out.push({
          name: it.name,
          line: it.selection_range.start.line,
          col: it.selection_range.start.col,
          startLine: it.range.start.line,
          endLine: it.range.end.line,
        });
      if (it.children.length) walk(it.children);
    }
  };
  walk(items);
  const seen = new Set<number>();
  return out
    .sort((a, b) => a.line - b.line || a.col - b.col)
    .filter((t) => (seen.has(t.line) ? false : (seen.add(t.line), true)));
}

export function usagesLabel(n: number): string {
  if (n === 0) return "no usages";
  return n === 1 ? "1 usage" : `${n} usages`;
}

const setLenses = StateEffect.define<CodeLens[]>();

const lensField = StateField.define<CodeLens[]>({
  create: () => [],
  update(lenses, tr) {
    for (const e of tr.effects) if (e.is(setLenses)) return e.value;
    if (!tr.docChanged || !lenses.length) return lenses;
    // Keep lenses on their lines while typing; drop ones whose line was deleted.
    const out: CodeLens[] = [];
    for (const l of lenses) {
      const pos = tr.changes.mapPos(l.pos, -1, MapMode.TrackDel);
      if (pos !== null) out.push({ ...l, pos });
    }
    return out;
  },
  provide: (f) => codeLenses.from(f),
});

const usagesEnabled = () => editorPrefs().inlay.codeVisionUsages;
const authorEnabled = () => editorPrefs().inlay.codeVisionAuthor;

function openUsages(view: EditorView, offset: number) {
  view.dispatch({ selection: EditorSelection.cursor(offset), userEvent: "select.lens" });
  view.focus();
  void executeAction("find.showUsages");
}

class UsagesLensPlugin {
  private refresh = debounce(() => void this.run(), 900);
  /** `${line}:${col}:${name}` → count, valid for `cacheDoc`. */
  private cache = new Map<string, number>();
  private cacheDoc: Text | null = null;
  private outline: { doc: Text; targets: LensTarget[] } | null = null;
  private generation = 0;
  private unsubscribe: () => void;
  private offReady: () => void;
  private offBlame: () => void;

  constructor(private view: EditorView) {
    this.refresh();
    this.unsubscribe = useProject.subscribe((s, prev) => {
      if (s.settings !== prev.settings) this.refresh();
    });
    // Counts computed while the server was indexing may be incomplete.
    this.offReady = onLspRefresh("codeLens", () => {
      this.cache.clear();
      this.refresh();
    });
    this.offBlame = onBlameInvalidated(() => this.refresh());
  }

  update(u: ViewUpdate) {
    if (u.docChanged || u.viewportChanged) this.refresh();
  }

  private async run() {
    const view = this.view;
    if (!view.dom.isConnected) return;
    const doc = docOf(view);
    if (!doc) return;
    const gen = ++this.generation;
    const usages = usagesEnabled() && !usagesBackoff.active(doc.doc);
    const authors = authorEnabled() && !doc.virtual;
    if (!usages && !authors) {
      if (view.state.field(lensField).length) view.dispatch({ effects: setLenses.of([]) });
      return;
    }
    const text = view.state.doc;
    // Blame runs beside the reference requests; it never holds up the counts.
    const blame = authors ? blameFor(doc.path, text) : Promise.resolve(null);
    if (this.cacheDoc !== text) {
      this.cache = new Map();
      this.cacheDoc = text;
    }
    try {
      if (this.outline?.doc !== text) {
        const items = await lspRequest(() => commands.docOutline(doc.doc));
        if (gen !== this.generation || view.state.doc !== text) return;
        this.outline = { doc: text, targets: lensTargets(items) };
      }
      const { from, to } = view.viewport;
      const firstLine = Math.max(0, text.lineAt(from).number - 1 - MARGIN_LINES);
      const lastLine = text.lineAt(to).number - 1 + MARGIN_LINES;
      const visible = this.outline.targets
        .filter((t) => t.line >= firstLine && t.line <= lastLine)
        .slice(0, MAX_PER_PASS);
      const key = (t: LensTarget) => `${t.line}:${t.col}:${t.name}`;
      const todo = usages ? visible.filter((t) => !this.cache.has(key(t))) : [];
      let unavailable = false;
      for (let i = 0; i < todo.length && !unavailable; i += CONCURRENCY) {
        await Promise.all(
          todo.slice(i, i + CONCURRENCY).map(async (t) => {
            try {
              const { locations: refs } = await lspRequest(() =>
                commands.lspReferences(nextRequestId(), doc.doc, { line: t.line, col: t.col }, false, true),
              );
              this.cache.set(key(t), refs.length);
            } catch (e) {
              if (isUnavailable(e)) unavailable = true;
            }
          }),
        );
        if (gen !== this.generation || view.state.doc !== text) return;
      }
      if (unavailable) usagesBackoff.mark(doc.doc);
      const lines = await blame;
      if (gen !== this.generation || view.state.doc !== text) return;
      const lenses: CodeLens[] = [];
      for (const t of visible) {
        const offset = posToOffset(text, { line: t.line, col: t.col });
        const who = lines && authorSummary(lines, t.startLine, t.endLine);
        if (who)
          lenses.push({ pos: offset, title: authorLabel(who), tooltip: authorTooltip(who), icon: "user", order: 20 });
        const n = usages ? this.cache.get(key(t)) : undefined;
        if (n === undefined) continue;
        lenses.push({
          pos: offset,
          title: usagesLabel(n),
          tooltip: n ? tx`Show usages of ${t.name}` : undefined,
          order: 10,
          run: n ? (v) => openUsages(v, Math.min(offset, v.state.doc.length)) : undefined,
        });
      }
      if (!sameLenses(view.state.field(lensField), lenses)) view.dispatch({ effects: setLenses.of(lenses) });
    } catch (e) {
      if (isUnavailable(e)) usagesBackoff.mark(doc.doc);
    }
  }

  destroy() {
    this.refresh.cancel();
    this.unsubscribe();
    this.offReady();
    this.offBlame();
    this.generation++;
  }
}

function sameLenses(a: readonly CodeLens[], b: readonly CodeLens[]) {
  return (
    a.length === b.length &&
    a.every((l, i) => l.pos === b[i]!.pos && l.title === b[i]!.title && l.tooltip === b[i]!.tooltip)
  );
}

export function usagesLensExtension(): Extension {
  return [lensField, ViewPlugin.fromClass(UsagesLensPlugin)];
}
