/**
 * Plugin editor panels (`[[contributes.editorPanels]]`): a web page at the right edge of every
 * editor group, following the group's text editor (a minimap, say). Each group has one frame,
 * kept while the group switches tabs: the page hears `onTarget` instead of reloading. Through
 * `openidea.editor` it reads the file (read-only), the viewport, the colours (syntax and semantic), the
 * marker bar's problems, the folds and the rows of wrapped lines, the caret and selections, the VCS changes, and scrolls the editor — straight
 * from the editor, not through the plugin's code, since a minimap follows every frame of a scroll.
 */
import { foldedRanges, highlightingFor, syntaxTree } from "@codemirror/language";
import { RangeSet, type Range } from "@codemirror/state";
import { BlockType, Decoration, ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { highlightTree } from "@lezer/highlight";
import { useEffect, useMemo } from "react";
import type { Severity } from "@/bindings";
import { lineChanges, useEditorRegistry, type TextEditorHandle } from "@/editor/api";
import { markerBarProblems } from "@/editor/lsp/diagnostics";
import { semanticHighlights } from "@/editor/lsp/semantic";
import { evaluateWhen, useContextKeys } from "@/platform/context";
import { subscribeTheme } from "@/platform/themeWatch";
import { registerEditorGroupPanel } from "@/workbench/contributions";
import { usePlugins } from "../store";
import { basename } from "./customEditor";
import {
  WebView,
  type DocumentState,
  type EditorFold,
  type EditorChange,
  type EditorProblem,
  type EditorSelection,
  type EditorTarget,
  type EditorViewport,
  type FrameDocument,
  type FrameEditor,
  type FrameEditorEvent,
  type HighlightSpan,
} from "./WebView";

export interface EditorPanelDecl {
  id: string;
  web: string;
  /** Pixels, 40–400 (checked by the backend). */
  width: number;
  when?: string | null;
}

/** The marker bar's levels (IDEA's): `info` is a weak warning; hints have no mark. */
const problemLevel = (severity: Severity): EditorProblem["severity"] =>
  severity === "error" || severity === "warning" ? severity : "weakWarning";

const syntaxMarks = new Map<string, Decoration>();
const syntaxMark = (classes: string) => {
  let m = syntaxMarks.get(classes);
  if (!m) syntaxMarks.set(classes, (m = Decoration.mark({ class: classes })));
  return m;
};

/** View updates of the editors that panels follow. */
const updateListeners = new Map<EditorView, Set<(u: ViewUpdate) => void>>();

/** Every text editor's updates, for the panels following it (an editor contribution). */
export const editorPanelUpdates = ViewPlugin.define(() => ({
  update(u: ViewUpdate) {
    const listeners = updateListeners.get(u.view);
    if (listeners) for (const l of listeners) l(u);
  },
}));

/** The 0-based, fractional line at `height` (document coordinates): within a fold, across its lines. */
function lineAtHeight(view: EditorView, height: number): number {
  const doc = view.state.doc;
  const block = view.lineBlockAtHeight(Math.max(0, height));
  const first = doc.lineAt(block.from).number - 1;
  const span = doc.lineAt(block.to).number - first;
  const frac = block.height > 0 ? Math.min(1, Math.max(0, (height - block.top) / block.height)) : 0;
  return Math.min(doc.lines, first + frac * span);
}

/** What the next frame sends: nothing yet. */
const nothingPending = () => ({
  target: false,
  viewport: false,
  document: false,
  problems: false,
  layout: false,
  selections: false,
  changes: false,
  lines: null as [number, number] | null,
});

/** One panel frame's view of its group's text editor. */
export class PanelEditor implements FrameEditor {
  private handle: TextEditorHandle | null = null;
  private unbind = () => {};
  /** Bumped by every change of the document (and of the target): what `get()` and `document` report. */
  private version = 0;
  private readonly listeners = new Set<(e: FrameEditorEvent) => void>();
  private readonly documentListeners = new Set<(s: DocumentState) => void>();
  /** Highlight classes → their colour in the current scheme. */
  private readonly colors = new Map<string, string>();
  private frame = 0;
  private pending = nothingPending();

  readonly document: FrameDocument = {
    read: () => {
      const h = this.handle;
      if (!h) throw new Error("the editor group shows no file");
      return { version: this.version, text: h.view.state.doc.toString(), readOnly: true, name: basename(h.ctx.path) };
    },
    bytes: () => Promise.reject(new Error("an editor panel reads the document's text")),
    edit: () => {
      throw new Error("the document is read-only");
    },
    subscribe: (l) => {
      this.documentListeners.add(l);
      return () => this.documentListeners.delete(l);
    },
  };

  /** Follows `handle` (the group's text editor), or nothing. */
  bind(handle: TextEditorHandle | null) {
    if (handle === this.handle) return;
    this.unbind();
    this.unbind = () => {};
    this.handle = handle;
    this.version++;
    // Sent below.
    this.pending.target = false;
    if (handle) {
      const { view } = handle;
      const onScroll = () => this.schedule({ viewport: true });
      let softWrap = view.lineWrapping;
      const onUpdate = (u: ViewUpdate) => {
        const lines = u.state.doc.lines;
        if (u.docChanged) {
          this.version++;
          let from = u.state.doc.length;
          u.changes.iterChangedRanges((_fa, _ta, fromB) => void (from = Math.min(from, fromB)));
          this.schedule({ document: true, viewport: true, lines: [u.state.doc.lineAt(from).number - 1, lines] });
        } else {
          const before = syntaxTree(u.startState);
          const after = syntaxTree(u.state);
          // A parse that progressed redoes the lines from where the shorter tree ends;
          // compare the trees' fragments if pages need tighter ranges.
          if (before !== after) {
            const at = Math.min(before.length, after.length, u.state.doc.length);
            this.schedule({ lines: [u.state.doc.lineAt(at).number - 1, lines] });
          }
        }
        if (u.geometryChanged || u.heightChanged || u.viewportChanged) this.schedule({ viewport: true });
        if (markerBarProblems(u.startState) !== markerBarProblems(u.state)) this.schedule({ problems: true });
        // An edit can move a caret to another line without changing its offset.
        if (u.docChanged || !u.state.selection.eq(u.startState.selection)) this.schedule({ selections: true });
        if (u.startState.facet(lineChanges) !== u.state.facet(lineChanges)) this.schedule({ changes: true });
        // Settings or `.editorconfig` changed the file's indentation: `get()` changed.
        if (u.startState.tabSize !== u.state.tabSize) this.schedule({ target: true });
        // Wrapped rows follow the line blocks' heights.
        const wrap = u.view.lineWrapping;
        if (foldedRanges(u.startState) !== foldedRanges(u.state) || wrap !== softWrap || (wrap && u.heightChanged)) {
          softWrap = wrap;
          this.schedule({ layout: true });
        }
        const semBefore = semanticHighlights(u.startState);
        const semAfter = semanticHighlights(u.state);
        if (semBefore !== semAfter) {
          // New semantic tokens: the lines whose marks differ (in the new document).
          const changed = (from: number, to: number) => {
            const doc = u.state.doc;
            this.schedule({ lines: [doc.lineAt(from).number - 1, doc.lineAt(Math.max(from, to - 1)).number] });
          };
          RangeSet.compare([semBefore], [semAfter], u.changes, { compareRange: changed, comparePoint: changed });
        }
      };
      view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
      let set = updateListeners.get(view);
      if (!set) updateListeners.set(view, (set = new Set()));
      set.add(onUpdate);
      this.unbind = () => {
        view.scrollDOM.removeEventListener("scroll", onScroll);
        set.delete(onUpdate);
        if (!set.size) updateListeners.delete(view);
      };
      this.schedule({ viewport: true, problems: true, layout: true, selections: true, changes: true });
    }
    this.emit({ editor: "target", value: this.get() });
  }

  /** The scheme's colours changed: every line's highlights may have. */
  themeChanged() {
    this.colors.clear();
    const view = this.handle?.view;
    if (view) this.schedule({ lines: [0, view.state.doc.lines] });
  }

  dispose() {
    this.bind(null);
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  subscribe(listener: (e: FrameEditorEvent) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  get(): EditorTarget | null {
    const h = this.handle;
    if (!h) return null;
    const { state } = h.view;
    return {
      path: h.ctx.path,
      language: h.ctx.language,
      version: this.version,
      lineCount: state.doc.lines,
      tabSize: state.tabSize,
    };
  }

  viewport(): EditorViewport | null {
    const view = this.handle?.view;
    if (!view) return null;
    const s = view.scrollDOM;
    // The document height at the top edge of the visible area.
    const top = s.getBoundingClientRect().top - view.documentTop;
    return {
      firstLine: lineAtHeight(view, top),
      lastLine: lineAtHeight(view, top + s.clientHeight),
      lineCount: view.state.doc.lines,
      scrollTop: s.scrollTop,
      scrollHeight: s.scrollHeight,
      clientHeight: s.clientHeight,
    };
  }

  scrollTo(line: number) {
    const view = this.handle?.view;
    if (!view) return;
    const doc = view.state.doc;
    const at = Math.min(Math.max(0, line), doc.lines);
    const block = view.lineBlockAt(doc.line(Math.min(doc.lines, Math.floor(at) + 1)).from);
    const first = doc.lineAt(block.from).number - 1;
    const span = doc.lineAt(block.to).number - first;
    const y = block.top + ((at - first) / span) * block.height;
    const s = view.scrollDOM;
    // Document coordinates → the scroller's.
    s.scrollTop = y + view.documentTop - s.getBoundingClientRect().top + s.scrollTop;
  }

  scrollBy(pixels: number) {
    const view = this.handle?.view;
    if (view) view.scrollDOM.scrollTop += pixels;
  }

  highlights(fromLine: number, toLine: number): HighlightSpan[][] {
    const view = this.handle?.view;
    if (!view) return [];
    const { state } = view;
    const doc = state.doc;
    const to = Math.min(toLine, doc.lines);
    if (fromLine >= to) return [];
    const out: HighlightSpan[][] = Array.from({ length: to - fromLine }, () => []);
    const start = doc.line(fromLine + 1).from;
    const end = doc.line(to).to;
    const syntax: Range<Decoration>[] = [];
    highlightTree(
      syntaxTree(state),
      { style: (tags) => highlightingFor(state, tags) },
      (from, until, classes) => void syntax.push(syntaxMark(classes).range(from, until)),
      start,
      end,
    );
    // As the editor layers them: semantic marks inside the syntax spans, so their colour wins.
    RangeSet.spans([semanticHighlights(state), Decoration.set(syntax)], start, end, {
      span: (from, until, active) => {
        if (!active.length) return;
        // `active` runs innermost first.
        const color = this.color(view, active.map((d) => (d.spec.class as string | undefined) ?? "").reverse());
        if (!color) return;
        // A token can run over several lines (a block comment): one span per line.
        for (let pos = from; pos < until;) {
          const line = doc.lineAt(pos);
          const stop = Math.min(until, line.to);
          if (stop > pos) out[line.number - 1 - fromLine]!.push({ from: pos - line.from, to: stop - line.from, color });
          pos = line.to + 1;
        }
      },
      point: () => {},
    });
    return out;
  }

  problems(): EditorProblem[] {
    const view = this.handle?.view;
    if (!view) return [];
    const doc = view.state.doc;
    return markerBarProblems(view.state).map((m) => ({
      line: doc.lineAt(m.from).number - 1,
      lastLine: doc.lineAt(Math.max(m.from, m.to - 1)).number - 1,
      severity: problemLevel(m.severity),
    }));
  }

  folded(): EditorFold[] {
    const view = this.handle?.view;
    if (!view) return [];
    const doc = view.state.doc;
    const out: EditorFold[] = [];
    foldedRanges(view.state).between(0, doc.length, (from, to) => {
      const fromLine = doc.lineAt(from).number - 1;
      const toLine = doc.lineAt(to).number - 1;
      const last = out.at(-1);
      // Folds inside a fold, or starting on the row it ends on, are part of it.
      if (last && fromLine <= last.toLine) last.toLine = Math.max(last.toLine, toLine);
      else if (toLine > fromLine) out.push({ fromLine, toLine });
    });
    return out;
  }

  wrapped(fromLine: number, toLine: number): number[] | null {
    const view = this.handle?.view;
    if (!view?.lineWrapping) return null;
    const doc = view.state.doc;
    const out: number[] = [];
    for (let n = fromLine + 1; n <= Math.min(toLine, doc.lines); n++) {
      const line = doc.line(n);
      // The editor's own line blocks: measured in the viewport, estimated elsewhere.
      const block = view.lineBlockAt(line.from);
      if (block.from < line.from) {
        out.push(0);
        continue;
      }
      // Block widgets (above or below the line) are not rows of its text.
      const height = Array.isArray(block.type)
        ? block.type.reduce((h, b) => (b.type === BlockType.Text ? h + b.height : h), 0)
        : block.height;
      out.push(Math.max(1, Math.round(height / view.defaultLineHeight)));
    }
    return out;
  }

  selections(): EditorSelection[] {
    const view = this.handle?.view;
    if (!view) return [];
    const { doc, selection } = view.state;
    const position = (pos: number) => {
      const line = doc.lineAt(pos);
      return { line: line.number - 1, column: pos - line.from };
    };
    const main = selection.main;
    return [main, ...selection.ranges.filter((_, i) => i !== selection.mainIndex)].map((r) => ({
      anchor: position(r.anchor),
      head: position(r.head),
    }));
  }

  changes(): EditorChange[] {
    const view = this.handle?.view;
    if (!view) return [];
    const doc = view.state.doc;
    return view.state.facet(lineChanges).map((c) => {
      // As the lane draws them: a hunk whose lines were all deleted is a deletion.
      if (c.kind === "deleted" || c.to <= c.from) {
        const line = doc.lineAt(Math.min(c.from, doc.length)).number - 1;
        return { line, lastLine: line, kind: "deleted" };
      }
      return {
        line: doc.lineAt(c.from).number - 1,
        lastLine: doc.lineAt(Math.max(c.from, c.to - 1)).number - 1,
        kind: c.kind,
      };
    });
  }

  /** The text colour of spans nested with these classes (outermost first), as the current scheme resolves it. */
  private color(view: EditorView, nested: string[]): string {
    const key = nested.join("\n");
    let color = this.colors.get(key);
    if (color === undefined) {
      // Outside the content DOM, which the editor observes; inside the editor, for its variables.
      const probe = document.createElement("span");
      probe.style.cssText = "position:absolute;visibility:hidden";
      let inner = probe;
      for (const classes of nested)
        inner = inner.appendChild(Object.assign(document.createElement("span"), { className: classes }));
      view.dom.appendChild(probe);
      color = getComputedStyle(inner).color;
      probe.remove();
      this.colors.set(key, color);
    }
    return color;
  }

  private emit(e: FrameEditorEvent) {
    for (const l of this.listeners) l(e);
  }

  private schedule(p: {
    target?: boolean;
    viewport?: boolean;
    document?: boolean;
    problems?: boolean;
    layout?: boolean;
    selections?: boolean;
    changes?: boolean;
    lines?: [number, number];
  }) {
    const q = this.pending;
    q.target ||= !!p.target;
    q.viewport ||= !!p.viewport;
    q.document ||= !!p.document;
    q.problems ||= !!p.problems;
    q.layout ||= !!p.layout;
    q.selections ||= !!p.selections;
    q.changes ||= !!p.changes;
    if (p.lines) q.lines = q.lines ? [Math.min(q.lines[0], p.lines[0]), Math.max(q.lines[1], p.lines[1])] : p.lines;
    if (!this.frame) this.frame = requestAnimationFrame(() => this.flush());
  }

  private flush() {
    this.frame = 0;
    const q = this.pending;
    this.pending = nothingPending();
    const view = this.handle?.view;
    if (!view) return;
    if (q.target) this.emit({ editor: "target", value: this.get() });
    if (q.document && this.documentListeners.size) {
      const state = { version: this.version, text: view.state.doc.toString() };
      for (const l of this.documentListeners) l(state);
    }
    if (q.lines) {
      const lines = view.state.doc.lines;
      const fromLine = Math.min(q.lines[0], lines);
      this.emit({ editor: "highlights", value: { fromLine, toLine: Math.min(q.lines[1], lines) } });
    }
    if (q.viewport) this.emit({ editor: "viewport", value: this.viewport()! });
    if (q.problems) this.emit({ editor: "problems", value: this.problems() });
    if (q.layout) this.emit({ editor: "layout", value: { folded: this.folded(), softWrap: view.lineWrapping } });
    if (q.selections) this.emit({ editor: "selections", value: this.selections() });
    if (q.changes) this.emit({ editor: "changes", value: this.changes() });
  }
}

function EditorPanel({ pluginId, decl, tabId }: { pluginId: string; decl: EditorPanelDecl; tabId: string | null }) {
  const editor = useMemo(() => new PanelEditor(), []);
  const handle = useEditorRegistry((s) => {
    if (tabId) for (const e of s.editors) if (e.tabId === tabId) return e;
    return null;
  });
  useEffect(() => editor.bind(handle), [editor, handle]);
  useEffect(() => {
    const off = subscribeTheme(() => editor.themeChanged());
    return () => {
      off();
      editor.dispose();
    };
  }, [editor]);
  return <WebView pluginId={pluginId} view={decl.id} label={decl.id} document={editor.document} editor={editor} />;
}

const granted = (pluginId: string) =>
  !!usePlugins
    .getState()
    .plugins.find((p) => p.id === pluginId)
    ?.capabilities.some((c) => c.id === "editor.read" && c.granted);

/** Shows the panel in every editor group while its `when` holds and `editor.read` is granted. */
export function projectEditorPanel(pluginId: string, decl: EditorPanelDecl): () => void {
  function PluginEditorPanel({ tabId }: { paneId: string; tabId: string | null }) {
    return <EditorPanel pluginId={pluginId} decl={decl} tabId={tabId} />;
  }
  let remove: (() => void) | null = null;
  const refresh = () => {
    const show = granted(pluginId) && evaluateWhen(decl.when ?? undefined);
    if (show === !!remove) return;
    if (show) {
      remove = registerEditorGroupPanel({
        id: `plugin.${pluginId}.${decl.id}`,
        width: decl.width,
        component: PluginEditorPanel,
      });
    } else {
      remove?.();
      remove = null;
    }
  };
  const offContext = useContextKeys.subscribe(refresh);
  const offPlugins = usePlugins.subscribe(refresh);
  refresh();
  return () => {
    offContext();
    offPlugins();
    remove?.();
  };
}
