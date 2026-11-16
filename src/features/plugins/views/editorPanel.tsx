/**
 * Plugin editor panels (`[[contributes.editorPanels]]`): a web page at the right edge of every
 * editor group, following the group's text editor (a minimap, say). Each group has one frame,
 * kept while the group switches tabs: the page hears `onTarget` instead of reloading. Through
 * `openidea.editor` it reads the file (read-only), the viewport and the syntax colours, and
 * scrolls the editor — straight from the editor, not through the plugin's code, since a minimap
 * follows every frame of a scroll.
 */
import { highlightingFor, syntaxTree } from "@codemirror/language";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { highlightTree } from "@lezer/highlight";
import { useEffect, useMemo } from "react";
import { useEditorRegistry, type TextEditorHandle } from "@/editor/api";
import { evaluateWhen, useContextKeys } from "@/platform/context";
import { subscribeTheme } from "@/platform/themeWatch";
import { registerEditorGroupPanel } from "@/workbench/contributions";
import { usePlugins } from "../store";
import { basename } from "./customEditor";
import {
  WebView,
  type DocumentState,
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
  private pending: { viewport: boolean; document: boolean; lines: [number, number] | null } = {
    viewport: false,
    document: false,
    lines: null,
  };

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
    if (handle) {
      const { view } = handle;
      const onScroll = () => this.schedule({ viewport: true });
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
      this.schedule({ viewport: true });
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
    return { path: h.ctx.path, language: h.ctx.language, version: this.version, lineCount: h.view.state.doc.lines };
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
    highlightTree(
      syntaxTree(state),
      { style: (tags) => highlightingFor(state, tags) },
      (from, until, classes) => {
        const color = this.color(view, classes);
        if (!color) return;
        // A token can run over several lines (a block comment): one span per line.
        for (let pos = Math.max(from, start); pos < Math.min(until, end);) {
          const line = doc.lineAt(pos);
          const stop = Math.min(until, end, line.to);
          if (stop > pos) out[line.number - 1 - fromLine]!.push({ from: pos - line.from, to: stop - line.from, color });
          pos = line.to + 1;
        }
      },
      start,
      end,
    );
    return out;
  }

  /** The text colour `classes` give in the editor, as the current scheme resolves it. */
  private color(view: EditorView, classes: string): string {
    let color = this.colors.get(classes);
    if (color === undefined) {
      // Outside the content DOM, which the editor observes; inside the editor, for its variables.
      const probe = document.createElement("span");
      probe.className = classes;
      probe.style.cssText = "position:absolute;visibility:hidden";
      view.dom.appendChild(probe);
      color = getComputedStyle(probe).color;
      probe.remove();
      this.colors.set(classes, color);
    }
    return color;
  }

  private emit(e: FrameEditorEvent) {
    for (const l of this.listeners) l(e);
  }

  private schedule(p: { viewport?: boolean; document?: boolean; lines?: [number, number] }) {
    const q = this.pending;
    q.viewport ||= !!p.viewport;
    q.document ||= !!p.document;
    if (p.lines) q.lines = q.lines ? [Math.min(q.lines[0], p.lines[0]), Math.max(q.lines[1], p.lines[1])] : p.lines;
    if (!this.frame) this.frame = requestAnimationFrame(() => this.flush());
  }

  private flush() {
    this.frame = 0;
    const q = this.pending;
    this.pending = { viewport: false, document: false, lines: null };
    const view = this.handle?.view;
    if (!view) return;
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
