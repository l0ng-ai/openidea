/**
 * Per-change controls of the diff viewer, as in IDEA: ">>" / "<<" apply arrows
 * in the divider (toward each editable side) and a Revert button shown while
 * hovering a change in an editable pane.
 */
import { RangeSet, StateEffect, StateField, Text, type Extension, type Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  WidgetType,
  gutter,
  type DecorationSet,
} from "@codemirror/view";
import { getChunks, getOriginalDoc, type Chunk, type MergeView } from "@codemirror/merge";
import { tx } from "@/platform/i18n";
import { iconMarkup, type IconName } from "@/ui";
import { transferChunk } from "./diffOptions";
import styles from "./DiffEditor.module.css";

export function diffDocument(text: string | null): Text {
  return Text.of((text ?? "").split(/\r\n?|\n/));
}

/** Copies chunk `index` of `mv` from `source` to the other side (an undoable user edit). */
export function applyChunk(mv: MergeView, index: number, source: "a" | "b") {
  const chunk = mv.chunks[index];
  if (!chunk) return;
  const [src, dst] = source === "a" ? [mv.a, mv.b] : [mv.b, mv.a];
  dst.dispatch({ changes: transferChunk(chunk, source, src.state.doc, dst.state.doc), userEvent: "revert" });
}

/** Reverts a unified change with the same line-boundary handling as the split viewer. */
export function revertUnifiedChunk(view: EditorView, pos: number) {
  const chunk = getChunks(view.state)?.chunks.find((c) => c.fromB <= pos && c.endB >= pos);
  if (!chunk) return;
  view.dispatch({
    changes: transferChunk(chunk, "a", getOriginalDoc(view.state), view.state.doc),
    userEvent: "revert",
  });
}

export function onHunkButtonClick(button: HTMLButtonElement, apply: () => void) {
  button.addEventListener("mousedown", (event) => {
    // Keep editor focus and suppress MergeView's delegated one-directional revert.
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    apply();
  });
}

export interface HunkButton {
  label: string;
  icon: IconName;
  run(): void;
}

export class HunkButtons extends GutterMarker {
  constructor(private readonly buttons: HunkButton[]) {
    super();
  }

  toDOM() {
    const container = document.createElement("span");
    container.className = styles.hunkButtons!;
    for (const { icon, label, run } of this.buttons) {
      const button = document.createElement("button");
      button.type = "button";
      button.title = tx(label);
      button.setAttribute("aria-label", button.title);
      button.innerHTML = iconMarkup(icon, 14) ?? "";
      onHunkButtonClick(button, run);
      container.append(button);
    }
    return container;
  }
}

export function hunkButtons(side: "a" | "b", action: (chunk: Chunk) => HunkButton): Extension {
  let lastDoc: Text | undefined;
  let lastChunks: readonly Chunk[] | undefined;
  let markers: RangeSet<GutterMarker> = RangeSet.empty;
  return gutter({
    class: styles.hunkGutter,
    side: side === "a" ? "after" : "before",
    markers: (view) => {
      const doc = view.state.doc;
      const chunks = getChunks(view.state)?.chunks;
      if (doc === lastDoc && chunks === lastChunks) return markers;
      lastDoc = doc;
      lastChunks = chunks;
      const byLine = new Map<number, HunkButton[]>();
      for (const chunk of chunks ?? []) {
        const offset = side === "a" ? chunk.fromA : chunk.fromB;
        const line = doc.lineAt(Math.min(offset, doc.length)).from;
        byLine.set(line, [...(byLine.get(line) ?? []), action(chunk)]);
      }
      markers = RangeSet.of(
        [...byLine].map(([line, buttons]) => new HunkButtons(buttons).range(line)),
        true,
      );
      return markers;
    },
  });
}

export function exposeHunkButtons(view: EditorView) {
  const column = view.dom.querySelector(`.${styles.hunkGutter}`);
  const gutters = column?.parentElement;
  if (!gutters) return;
  // CodeMirror's decorative gutters are hidden from assistive technology.
  gutters.removeAttribute("aria-hidden");
  for (const other of gutters.children) {
    if (other !== column) other.setAttribute("aria-hidden", "true");
  }
}

/** A ">>" / "<<" button; the chunk index comes from the nearest `data-chunk` (itself included). */
export function arrowButton(dir: "a-to-b" | "b-to-a", run: (chunkIndex: number) => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `cm-diffArrow cm-diffArrow-${dir}`;
  const label = dir === "a-to-b" ? "Apply change to the right (Replace ›››)" : "Apply change to the left (‹‹‹ Replace)";
  btn.setAttribute("aria-label", label);
  btn.title = label;
  btn.innerHTML = iconMarkup(dir === "a-to-b" ? "diff-arrow-right" : "diff-arrow-left", 14) ?? "";
  onHunkButtonClick(btn, () => {
    const holder = btn.closest<HTMLElement>("[data-chunk]");
    const index = Number(holder?.dataset.chunk);
    if (Number.isInteger(index)) run(index);
  });
  return btn;
}

/**
 * `renderRevertControl` for MergeView: one or two arrows per chunk. `toB`:
 * the right side is editable (">>"); `toA`: the left side is (">>" / "<<").
 */
export function arrowControls(
  getView: () => MergeView | null,
  sides: { toA: boolean; toB: boolean },
  apply = (index: number, source: "a" | "b") => {
    const view = getView();
    if (view) applyChunk(view, index, source);
  },
): () => HTMLElement {
  return () => {
    const box = document.createElement("div");
    box.className = "cm-diffArrows";
    if (sides.toB) box.appendChild(arrowButton("a-to-b", (i) => apply(i, "a")));
    if (sides.toA) box.appendChild(arrowButton("b-to-a", (i) => apply(i, "b")));
    return box;
  };
}

const setHover = StateEffect.define<number | null>();

class RevertWidget extends WidgetType {
  constructor(
    readonly index: number,
    readonly onRevert: (view: EditorView, index: number) => void,
  ) {
    super();
  }
  eq(other: RevertWidget) {
    return other.index === this.index;
  }
  toDOM(view: EditorView) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cm-diffHoverRevert";
    btn.title = "Revert this change";
    btn.setAttribute("aria-label", "Revert this change");
    btn.innerHTML = `${iconMarkup("revert", 12) ?? ""}<span>Revert</span>`;
    onHunkButtonClick(btn, () => this.onRevert(view, this.index));
    return btn;
  }
  ignoreEvent() {
    return true;
  }
}

export function chunkAt(chunks: readonly Chunk[], side: "a" | "b", pos: number, docLength: number): number {
  return chunks.findIndex((c) => {
    const [from, to] = side === "a" ? [c.fromA, c.toA] : [c.fromB, c.toB];
    return from === to ? pos === from : pos >= from && pos < Math.max(to, from + 1) && pos <= docLength;
  });
}

/**
 * A "Revert" button at the first line of the change under the mouse, for an
 * editable pane of a split diff. `onRevert` copies the other side's content.
 */
export function hoverRevert(onRevert: (view: EditorView, index: number) => void): Extension {
  const field = StateField.define<{ index: number | null; deco: DecorationSet }>({
    create: () => ({ index: null, deco: Decoration.none }),
    update(value, tr) {
      let index = value.index;
      for (const e of tr.effects) if (e.is(setHover)) index = e.value;
      const info = getChunks(tr.state);
      if (index !== null && (!info || index >= info.chunks.length)) index = null;
      if (index === value.index && !tr.docChanged && getChunks(tr.startState) === info) return value;
      const decos: Range<Decoration>[] = [];
      const chunk = index !== null ? info?.chunks[index] : undefined;
      if (chunk && info?.side) {
        const from = info.side === "a" ? chunk.fromA : chunk.fromB;
        const line = tr.state.doc.lineAt(Math.min(from, tr.state.doc.length));
        decos.push(Decoration.line({ class: "cm-diffHoverLine" }).range(line.from));
        decos.push(Decoration.widget({ widget: new RevertWidget(index!, onRevert), side: 1 }).range(line.to));
      }
      return { index, deco: Decoration.set(decos, true) };
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
  });
  const tracker = ViewPlugin.fromClass(
    class {
      constructor(readonly view: EditorView) {}
      set(index: number | null) {
        if (this.view.state.field(field).index !== index) this.view.dispatch({ effects: setHover.of(index) });
      }
    },
    {
      eventHandlers: {
        mousemove(e) {
          const info = getChunks(this.view.state);
          if (!info?.side) return;
          const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
          const line = this.view.state.doc.lineAt(pos);
          const i = chunkAt(info.chunks, info.side, line.from, this.view.state.doc.length);
          this.set(i >= 0 ? i : null);
        },
        mouseleave() {
          this.set(null);
        },
      },
    },
  );
  return [field, tracker];
}
