/**
 * The 3px change lane next to the line numbers (`gutterLaneMarkers`) and the
 * right-hand overview lane over the scrollbar (`scrollbarMarks`).
 */
import { EditorSelection, type EditorState, type Extension, type StateEffect } from "@codemirror/state";
import { foldedRanges, unfoldEffect } from "@codemirror/language";
import { EditorView, ViewPlugin, gutter, type ViewUpdate } from "@codemirror/view";
import { gutterLaneMarkers, scrollbarMarks, type ScrollbarMark } from "@/editor/api";

export const changeLane: Extension = gutter({
  class: "cm-openidea-lane",
  markers: (view) => view.state.facet(gutterLaneMarkers),
});

const MAX_RENDERED = 4000;

/** How far (px) a click may miss a mark on the overview lane. */
const MARK_TOLERANCE = 6;

/** The mark nearest to `y` (by its top) among those within the tolerance. */
export function nearestMark<M extends { top: number; bottom: number }>(marks: readonly M[], y: number): M | null {
  let best: M | null = null;
  for (const m of marks) {
    if (y < m.top - MARK_TOLERANCE || y > m.bottom + MARK_TOLERANCE) continue;
    if (!best || Math.abs(m.top - y) < Math.abs(best.top - y)) best = m;
  }
  return best;
}

/** The smallest scrollbar thumb (`::-webkit-scrollbar-thumb` min-height in global.css). */
const MIN_THUMB = 32;

/**
 * Where the vertical scrollbar thumb of a scroller is, in px from the top of its track, or null
 * when nothing scrolls. The overview lane lies over the scrollbar, so its marks must not take
 * the pointer where the thumb is (#752).
 */
export function scrollbarThumb(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  minThumb = MIN_THUMB,
): { top: number; bottom: number } | null {
  const max = scrollHeight - clientHeight;
  if (max <= 0 || clientHeight <= 0) return null;
  const length = Math.min(clientHeight, Math.max(minThumb, (clientHeight * clientHeight) / scrollHeight));
  const top = (Math.min(Math.max(scrollTop, 0), max) / max) * (clientHeight - length);
  return { top, bottom: top + length };
}

/** Unfolds the folds hiding `pos` or the rest of its line (navigating to a mark shows it). */
export function unfoldAround(state: EditorState, pos: number): StateEffect<unknown>[] {
  const lineEnd = state.doc.lineAt(pos).to;
  const out: StateEffect<unknown>[] = [];
  foldedRanges(state).between(pos, lineEnd, (from, to) => {
    if (from <= lineEnd && to > pos) out.push(unfoldEffect.of({ from, to }));
  });
  return out;
}

/** The class an outer scroller gets while a lane draws its scrollbar (its native one is hidden). */
const OUTER_SCROLLER = "cm-openidea-overviewScroller";

class OverviewLane {
  dom: HTMLElement;
  /** What scrolls the document: the editor's own scroller, or an outer one the editor is laid out in. */
  private scroller: HTMLElement;
  private resize: ResizeObserver | null = null;
  private scheduled = false;
  private lastKey = "";
  /** The last pointer position over the editor, to re-check the thumb when it scrolls. */
  private pointer: { x: number; y: number } | null = null;
  /**
   * The scrollbar thumb, drawn and dragged by the lane: the native scrollbar is hidden, so a
   * press on this strip stays here instead of reaching the text layer as a text drag.
   */
  private thumb: HTMLElement;

  constructor(
    private view: EditorView,
    outer?: HTMLElement,
  ) {
    this.scroller = outer ?? view.scrollDOM;
    this.dom = document.createElement("div");
    this.dom.className = outer ? "cm-openidea-overview cm-openidea-overview-sticky" : "cm-openidea-overview";
    this.dom.setAttribute("aria-hidden", "true");
    this.thumb = document.createElement("div");
    this.thumb.className = "cm-openidea-overviewThumb";
    this.dom.addEventListener("mousedown", this.onMouseDown);
    this.thumb.addEventListener("mousedown", this.onThumbMouseDown);
    view.dom.addEventListener("mousemove", this.onPointerMove);
    view.dom.addEventListener("mouseleave", this.onPointerLeave);
    this.scroller.addEventListener("scroll", this.onScroll, { passive: true });
    if (outer) {
      // First in the editor, sticking to the top of the outer scroller's viewport.
      view.dom.prepend(this.dom);
      outer.classList.add(OUTER_SCROLLER);
      this.resize = new ResizeObserver(() => this.schedule());
      this.resize.observe(outer);
    } else view.dom.appendChild(this.dom);
    this.schedule();
  }

  update(u: ViewUpdate) {
    if (
      u.docChanged ||
      u.geometryChanged ||
      u.heightChanged ||
      u.viewportChanged ||
      u.selectionSet ||
      u.startState.facet(scrollbarMarks) !== u.state.facet(scrollbarMarks)
    )
      this.schedule();
  }

  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    this.view.requestMeasure({
      key: this,
      read: (view) => {
        this.scheduled = false;
        const laneHeight = this.scroller.clientHeight;
        const len = view.state.doc.length;
        // The document itself, without the scroll-past-end padding that follows the editor height.
        const contentHeight = Math.max(view.lineBlockAt(len).bottom, 1);
        // A long document maps onto the lane proportionally: positions in % of the lane
        // stay valid while the window resizes, so a live resize rewrites nothing.
        const fit = contentHeight <= laneHeight;
        const scale = fit ? 1 : laneHeight / contentHeight;
        const unit = fit ? "px" : "%";
        const pos = (y: number) => (fit ? Math.floor(y) : +((y / contentHeight) * 100).toFixed(3));
        const marks = view.state.facet(scrollbarMarks);
        const rows = new Map<string, { top: number; height: number; mark: ScrollbarMark }>();
        for (const m of marks) {
          if (rows.size > MAX_RENDERED) break;
          const from = Math.min(Math.max(0, m.from), len);
          const to = Math.min(Math.max(from, m.to ?? from), len);
          const a = view.lineBlockAt(from);
          const b = to === from ? a : view.lineBlockAt(to);
          // Marks landing on the same lane pixel collapse into one.
          const px = Math.floor(a.top * scale);
          const top = pos(a.top);
          const height = fit ? Math.round(b.bottom - a.top) : +(((b.bottom - a.top) / contentHeight) * 100).toFixed(3);
          const key = `${px}:${m.color}:${m.kind ?? "line"}`;
          const prev = rows.get(key);
          if (!prev || (m.priority ?? 0) > (prev.mark.priority ?? 0) || height > prev.height)
            rows.set(key, { top: prev?.top ?? top, height: Math.max(height, prev?.height ?? 0), mark: m });
        }
        const caret = pos(view.lineBlockAt(view.state.selection.main.head).top);
        return {
          rows: [...rows.values()].sort((x, y) => (x.mark.priority ?? 0) - (y.mark.priority ?? 0)),
          caret,
          unit,
          laneHeight,
        };
      },
      write: ({ rows, caret, unit, laneHeight }) => {
        if (this.scroller !== this.view.scrollDOM) {
          this.dom.style.height = `${laneHeight}px`;
          this.dom.style.marginBottom = `-${laneHeight}px`;
        }
        const key =
          rows.map((r) => `${r.top},${r.height},${r.mark.color},${r.mark.kind}`).join("|") +
          `#${caret}${unit}${laneHeight}`;
        if (key === this.lastKey) return;
        this.lastKey = key;
        const frag = document.createDocumentFragment();
        for (const r of rows) {
          const el = document.createElement("div");
          el.className =
            r.mark.kind === "thin" || r.mark.kind === "full"
              ? `cm-openidea-overviewMark cm-openidea-overviewMark-${r.mark.kind}`
              : "cm-openidea-overviewMark";
          el.style.top = `${r.top}${unit}`;
          el.style.height = `${r.height}${unit}`;
          el.style.background = r.mark.color;
          el.dataset.pos = String(r.mark.from);
          if (r.mark.tooltip) el.title = r.mark.tooltip;
          frag.appendChild(el);
        }
        const c = document.createElement("div");
        c.className = "cm-openidea-overviewCaret";
        c.style.top = `${caret}${unit}`;
        frag.appendChild(c);
        frag.appendChild(this.thumb);
        this.dom.replaceChildren(frag);
      },
    });
    this.scheduleThumb();
  }

  private scheduleThumb() {
    this.view.requestMeasure({
      key: this.thumb,
      read: () => {
        const s = this.scroller;
        const thumb = scrollbarThumb(s.scrollTop, s.scrollHeight, s.clientHeight);
        // The lane starts at the top of the editor, the scrollbar at the top of the scroller.
        const offset = s.getBoundingClientRect().top - this.dom.getBoundingClientRect().top;
        // The drawn thumb matches the geometry the drag maps onto, so the pointer keeps its grip.
        return thumb && { top: thumb.top + offset, height: thumb.bottom - thumb.top };
      },
      write: (thumb) => {
        this.thumb.style.display = thumb ? "" : "none";
        if (!thumb) return;
        this.thumb.style.top = `${thumb.top}px`;
        this.thumb.style.height = `${thumb.height}px`;
      },
    });
  }

  /**
   * Over the thumb the marks let the pointer through, so the thumb can be dragged even where a
   * mark covers it (a new file is one mark the height of the lane, #752).
   */
  private updateThumbPassThrough() {
    const p = this.pointer;
    let over = false;
    if (p) {
      const lane = this.dom.getBoundingClientRect();
      const s = this.scroller;
      const thumb = scrollbarThumb(s.scrollTop, s.scrollHeight, s.clientHeight);
      const y = p.y - s.getBoundingClientRect().top;
      over = !!thumb && p.x >= lane.left && p.x <= lane.right && y >= thumb.top && y <= thumb.bottom;
    }
    this.dom.classList.toggle("cm-openidea-overview-onThumb", over);
  }

  private onPointerMove = (e: MouseEvent) => {
    this.pointer = { x: e.clientX, y: e.clientY };
    // A thumb drag in progress keeps the marks out of the way until the button is released.
    if (e.buttons === 0) this.updateThumbPassThrough();
  };

  private onPointerLeave = () => {
    this.pointer = null;
    this.updateThumbPassThrough();
  };

  private onScroll = () => {
    this.scheduleThumb();
    if (this.pointer) this.updateThumbPassThrough();
  };

  /** The thumb's own press: drag it, keeping the button state inside the lane. */
  private onThumbMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const s = this.scroller;
    const thumb = scrollbarThumb(s.scrollTop, s.scrollHeight, s.clientHeight);
    if (!thumb) return;
    const startY = e.clientY;
    const startTop = s.scrollTop;
    const travel = s.scrollHeight - s.clientHeight;
    // The distance the thumb can move: the track minus the thumb itself.
    const track = Math.max(1, s.clientHeight - (thumb.bottom - thumb.top));
    const onMove = (ev: MouseEvent) => {
      s.scrollTop = startTop + ((ev.clientY - startY) * travel) / track;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      this.updateThumbPassThrough();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  private onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const marks = [...this.dom.querySelectorAll<HTMLElement>(".cm-openidea-overviewMark")].map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, pos: Number(el.dataset.pos) };
    });
    const hit = nearestMark(marks, e.clientY);
    if (!hit) {
      // Above / below the thumb pages the editor, like the native track it replaces.
      const s = this.scroller;
      const thumb = scrollbarThumb(s.scrollTop, s.scrollHeight, s.clientHeight);
      e.preventDefault();
      if (!thumb) return;
      const y = e.clientY - s.getBoundingClientRect().top;
      if (y < thumb.top) s.scrollTop -= s.clientHeight;
      else if (y > thumb.bottom) s.scrollTop += s.clientHeight;
      return;
    }
    e.preventDefault();
    const state = this.view.state;
    const pos = Math.min(hit.pos, state.doc.length);
    this.view.dispatch({
      selection: EditorSelection.cursor(pos),
      effects: [...unfoldAround(state, pos), EditorView.scrollIntoView(pos, { y: "center" })],
      userEvent: "select.overview",
    });
    this.view.focus();
  };

  destroy() {
    this.dom.removeEventListener("mousedown", this.onMouseDown);
    this.thumb.removeEventListener("mousedown", this.onThumbMouseDown);
    this.view.dom.removeEventListener("mousemove", this.onPointerMove);
    this.view.dom.removeEventListener("mouseleave", this.onPointerLeave);
    this.scroller.removeEventListener("scroll", this.onScroll);
    this.resize?.disconnect();
    if (this.scroller !== this.view.scrollDOM) this.scroller.classList.remove(OUTER_SCROLLER);
    this.dom.remove();
  }
}

/**
 * The overview lane over an outer scroller that holds the editor at its full height (the panes of
 * an aligned side-by-side diff scroll together in their container): `scroller` finds it once the
 * editor is in the DOM. The lane sticks to the right edge of this editor.
 */
export function overviewLaneIn(scroller: (view: EditorView) => HTMLElement | null): Extension {
  return ViewPlugin.define((view) => new OverviewLane(view, scroller(view) ?? undefined));
}

export const overviewLane: Extension = [
  ViewPlugin.define((view) => new OverviewLane(view)),
  EditorView.editorAttributes.of({ class: "cm-openidea-withOverview" }),
];
