/**
 * "N usages" code lenses above declarations (IDEA's usages inlay). Cheap by
 * construction: only declarations in (and near) the viewport are counted, one
 * debounced pass after edits / scrolling, results cached per document text
 * and symbol until the project's documents change, and at most a few reference
 * requests in flight. Counts run the same references query the Find Usages
 * panel runs (including the plugin indexers' anchors), scoped to what the
 * server analyses: opening candidate files or the libraries for every count
 * would trigger expensive server analysis, so only an explicit Find Usages
 * widens the server's scope, and a widened search can find more. Beside each
 * count, the declaration's last author from VCS blame (`authorLens`).
 */
import { Channel } from "@tauri-apps/api/core";
import { EditorSelection, MapMode, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { codeLenses, onEditorEvent, shownAgain, type CodeLens } from "@/editor/api";
import { onNavigationProvidersChanged } from "@/editor/navigationProviders";
import { executeAction, getAction } from "@/platform/actions";
import { commands, nextRequestId, onIdeEvent, type OutlineItem, type RequestId, type SymbolKind } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { debounce, docOf, isUnavailable, lspRequest } from "./lsp";
import { posToOffset } from "./positions";
import { featureBackoff, onLspRefresh, onServerSettled } from "./availability";
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
const MARGIN_LINES = 10;
/**
 * Passes that ask again for a count that came back incomplete. Servers call an empty answer
 * incomplete while any of their progress runs, and jdtls reports progress for a few
 * milliseconds around many requests without settling afterwards.
 */
const INCOMPLETE_RETRIES = 3;
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
  if (n === 0) return tx("no usages");
  return n === 1 ? tx("1 usage") : tx`${n} usages`;
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

/** The author hint opens the file's blame annotations, and leaves them open when shown. */
function showAnnotations(view: EditorView) {
  view.focus();
  if (!getAction("vcs.annotate")?.toggled?.()) void executeAction("vcs.annotate");
}

function openUsages(view: EditorView, offset: number) {
  view.dispatch({ selection: EditorSelection.cursor(offset), userEvent: "select.lens" });
  view.focus();
  void executeAction("find.showUsages");
}

class UsagesLensPlugin {
  private schedule = debounce(() => void this.run(), 900);
  /** `${line}:${col}:${name}` → count, valid for `cacheDoc`. */
  private cache = new Map<string, number>();
  private cacheDoc: Text | null = null;
  private outline: { doc: Text; targets: LensTarget[] } | null = null;
  private generation = 0;
  private pending = new Set<RequestId>();
  /** Keys whose count came back incomplete (the server was indexing): not shown, asked again once it settles. */
  private incomplete = new Set<string>();
  /** Times each key's count came back incomplete, for the passes that ask again before it settles. */
  private retries = new Map<string, number>();
  private unsubscribe: () => void;
  private offReady: () => void;
  private offSettled: () => void;
  private offBlame: () => void;
  private offChanges: () => void;
  private skipped = false;

  constructor(private view: EditorView) {
    this.refresh();
    this.unsubscribe = useProject.subscribe((s, prev) => {
      if (s.settings !== prev.settings) this.refresh();
    });
    // Counts computed while the server was indexing may be incomplete.
    this.offReady = onLspRefresh("codeLens", () => this.invalidate());
    this.offSettled = onServerSettled(() => {
      if (!this.incomplete.size) return;
      this.incomplete.clear();
      this.retries.clear();
      this.refresh();
    });
    this.offBlame = onBlameInvalidated(() => this.refresh());
    // Counts cover the whole project, so a change anywhere can outdate them
    // while this view is hidden and skips its passes: another document's edit
    // (the call sites) or a closed unsaved buffer, a backend patch (a
    // refactoring), a file changed on disk, or a plugin index batch (an XML
    // statement is indexed after its Java declaration). This view's own edits
    // already refresh through `update`.
    const offDocs = onEditorEvent((e) => {
      if (e.type === "docChanged" && e.doc !== docOf(this.view)?.doc) this.invalidate();
      else if (e.type === "docClosed") this.invalidate();
    });
    const offPatches = onIdeEvent("docPatched", (e) => {
      if (e.doc !== docOf(this.view)?.doc) this.invalidate();
    });
    const offBackend = [
      onIdeEvent("workspaceEditApplied", () => this.invalidate()),
      onIdeEvent("fsChanged", () => this.invalidate()),
      onNavigationProvidersChanged(() => this.invalidate()),
    ];
    this.offChanges = () => {
      offDocs();
      offPatches();
      offBackend.forEach((off) => off());
    };
  }

  /** Counts are cached until anything in the project may have changed them. */
  private invalidate() {
    this.cache.clear();
    this.incomplete.clear();
    this.retries.clear();
    this.refresh();
  }

  update(u: ViewUpdate) {
    // A re-shown tab ran nothing while hidden, and its counts may have been
    // invalidated meanwhile; when they are cached the pass only redraws.
    if (u.docChanged || u.viewportChanged || shownAgain(u)) this.refresh();
  }

  private cancel() {
    this.generation++;
    for (const id of this.pending) void commands.cancelRequest(id).catch(() => {});
    this.pending.clear();
  }

  private refresh() {
    this.cancel();
    this.schedule();
  }

  private async run() {
    const view = this.view;
    this.skipped = !view.dom.isConnected;
    if (this.skipped) return;
    const doc = docOf(view);
    if (!doc) return;
    const gen = this.generation;
    const usages = usagesEnabled() && !usagesBackoff.active(doc.doc);
    const authors = authorEnabled() && !doc.virtual;
    if (!usages && !authors) {
      if (view.state.field(lensField).length) view.dispatch({ effects: setLenses.of([]) });
      return;
    }
    const text = view.state.doc;
    const wanted = () => gen === this.generation && view.state.doc === text;
    // Blame runs beside the reference requests; it never holds up the counts.
    const blame = authors ? blameFor(doc.path, text) : Promise.resolve(null);
    if (this.cacheDoc !== text) {
      this.cache = new Map();
      this.incomplete = new Set();
      this.retries = new Map();
      this.cacheDoc = text;
    }
    try {
      if (this.outline?.doc !== text) {
        const items = await lspRequest(() => commands.docOutline(doc.doc), wanted);
        if (!wanted()) return;
        this.outline = { doc: text, targets: lensTargets(items) };
      }
      const { from, to } = view.viewport;
      const firstLine = Math.max(0, text.lineAt(from).number - 1 - MARGIN_LINES);
      const lastLine = text.lineAt(to).number - 1 + MARGIN_LINES;
      const visible = this.outline.targets
        .filter((t) => t.line >= firstLine && t.line <= lastLine)
        .slice(0, MAX_PER_PASS);
      const key = (t: LensTarget) => `${t.line}:${t.col}:${t.name}`;
      const todo = usages ? visible.filter((t) => !this.cache.has(key(t)) && !this.incomplete.has(key(t))) : [];
      let unavailable = false;
      let retry = false;
      for (let i = 0; i < todo.length && !unavailable; i += CONCURRENCY) {
        await Promise.all(
          todo.slice(i, i + CONCURRENCY).map(async (t) => {
            const request = nextRequestId();
            try {
              const { locations: refs, incomplete } = await lspRequest(() => {
                this.pending.add(request);
                // Opening candidate files for each count triggers expensive server analysis.
                // Only an explicit Find Usages should widen the server's scope.
                return commands.lspReferences(
                  request,
                  doc.doc,
                  { line: t.line, col: t.col },
                  false,
                  false,
                  false,
                  new Channel(),
                );
              }, wanted);
              if (wanted()) {
                if (!incomplete) this.cache.set(key(t), refs.length);
                else {
                  const tries = (this.retries.get(key(t)) ?? 0) + 1;
                  this.retries.set(key(t), tries);
                  if (tries > INCOMPLETE_RETRIES) this.incomplete.add(key(t));
                  else retry = true;
                }
              }
            } catch (e) {
              if (wanted() && isUnavailable(e)) unavailable = true;
            } finally {
              this.pending.delete(request);
            }
          }),
        );
        if (!wanted()) return;
      }
      if (unavailable) usagesBackoff.mark(doc.doc);
      if (retry) this.schedule();
      const lines = await blame;
      if (!wanted()) return;
      const lenses: CodeLens[] = [];
      for (const t of visible) {
        const offset = posToOffset(text, { line: t.line, col: t.col });
        const who = lines && authorSummary(lines, t.startLine, t.endLine);
        if (who)
          lenses.push({
            pos: offset,
            title: authorLabel(who),
            tooltip: authorTooltip(who),
            icon: "user",
            order: 20,
            kind: "author",
            run: showAnnotations,
          });
        const n = usages ? this.cache.get(key(t)) : undefined;
        if (n === undefined || (n === 0 && !editorPrefs().inlay.codeVisionNoUsages)) continue;
        lenses.push({
          pos: offset,
          title: usagesLabel(n),
          tooltip: tx`Show usages of ${t.name}`,
          order: 10,
          kind: "usages",
          run: (v) => openUsages(v, Math.min(offset, v.state.doc.length)),
        });
      }
      if (!sameLenses(view.state.field(lensField), lenses)) view.dispatch({ effects: setLenses.of(lenses) });
    } catch (e) {
      if (wanted() && isUnavailable(e)) usagesBackoff.mark(doc.doc);
    }
  }

  destroy() {
    this.schedule.cancel();
    this.unsubscribe();
    this.offReady();
    this.offSettled();
    this.offBlame();
    this.offChanges();
    this.cancel();
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
