/**
 * Component inlays under lines (IDEA's block inlays with Swing components, as code review
 * threads use them): each inlay is a CodeMirror block widget holding a React root. Inlays
 * are replaced as a whole with `setLineInlays`; one with the same key keeps its DOM (and
 * React state) and is re-rendered with the new content.
 *
 *   view.dispatch({ effects: setLineInlays.of([{ key: thread.id, line: 41, content: <Thread … /> }]) });
 */
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

export interface LineInlay {
  /** Stable identity: the same key keeps the DOM and React state. */
  key: string;
  /** 0-based line the inlay shows under. */
  line: number;
  content: ReactNode;
}

/** Replaces the inlays of a view. */
export const setLineInlays = StateEffect.define<readonly LineInlay[]>();

interface Mounted {
  root: Root;
  observer: ResizeObserver | null;
}

const mounted = new WeakMap<HTMLElement, Mounted>();

class InlayWidget extends WidgetType {
  constructor(readonly inlay: LineInlay) {
    super();
  }
  override eq(other: WidgetType): boolean {
    return (
      other instanceof InlayWidget && other.inlay.key === this.inlay.key && other.inlay.content === this.inlay.content
    );
  }
  override toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement("div");
    dom.className = "cm-lineInlay";
    dom.dataset.inlay = this.inlay.key;
    const root = createRoot(dom);
    root.render(this.inlay.content);
    // The content grows and shrinks (editors, folded replies): CodeMirror re-measures heights.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => view.requestMeasure());
    observer?.observe(dom);
    mounted.set(dom, { root, observer });
    return dom;
  }
  override updateDOM(dom: HTMLElement): boolean {
    const m = mounted.get(dom);
    if (!m || dom.dataset.inlay !== this.inlay.key) return false;
    m.root.render(this.inlay.content);
    return true;
  }
  override destroy(dom: HTMLElement): void {
    const m = mounted.get(dom);
    if (!m) return;
    mounted.delete(dom);
    m.observer?.disconnect();
    // Not while React may be rendering (a widget can go away during a dispatch from an event handler).
    queueMicrotask(() => m.root.unmount());
  }
  override get estimatedHeight(): number {
    return 60;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

function build(state: EditorState, inlays: readonly LineInlay[]): DecorationSet {
  const ranges = inlays
    .filter((i) => i.line >= 0 && i.line < state.doc.lines)
    .map((i, order) => ({ i, order, pos: state.doc.line(i.line + 1).to }))
    .sort((a, b) => a.pos - b.pos || a.order - b.order)
    .map(({ i, pos }) => Decoration.widget({ widget: new InlayWidget(i), block: true, side: 1 }).range(pos));
  return Decoration.set(ranges);
}

// A block formatting context: the content's margins count in the height CodeMirror measures.
const theme = EditorView.baseTheme({ ".cm-lineInlay": { display: "flow-root" } });

/** The inlay field of a view, starting with `initial`. */
export function lineInlays(initial: readonly LineInlay[] = []): Extension {
  const field = StateField.define<DecorationSet>({
    create: (state) => build(state, initial),
    update(value, tr) {
      for (const e of tr.effects) if (e.is(setLineInlays)) return build(tr.state, e.value);
      return tr.docChanged ? value.map(tr.changes) : value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
  return [field, theme];
}
