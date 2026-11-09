/**
 * Keeps the end of a line clear of the floating corner widgets (`editorCorner()`
 * in `editor/api.ts`: the inspection widget, the Review Mode group).
 *
 * The corner is absolutely positioned in `.cm-editor`, outside `.cm-scroller`:
 * scrolling does not move it and it does not count in `scrollWidth`, so at full
 * horizontal scroll the last characters of a line land under it. Its width is
 * not a constant (a green check, then counts and previous/next buttons as
 * problems appear), so the lines' right padding follows its measured width
 * through `--cm-corner-inset` (`theme.ts`), the way the fixed line padding
 * already reserves room for the overview lane.
 */
import { type EditorView, ViewPlugin } from "@codemirror/view";

/** Space between the corner's left edge and the end of a line. */
const CORNER_GAP = 4;

/** Width changes of the corner that matter: `getBoundingClientRect()` is fractional. */
const round = (width: number) => Math.ceil(width);

class CornerInset {
  private corner: HTMLElement | null = null;
  private observer: ResizeObserver | null = null;
  private inset = -1;

  constructor(private readonly view: EditorView) {
    this.sync();
  }

  /** A new corner: `editorCorner()` calls this right after appending it. */
  track(corner: HTMLElement) {
    if (corner === this.corner) return;
    this.observer?.disconnect();
    this.corner = corner;
    if (typeof ResizeObserver === "undefined") return;
    // The widget's content grows and shrinks (diagnostic counts, Review Mode).
    this.observer = new ResizeObserver(() => this.measure());
    this.observer.observe(corner);
    this.measure();
  }

  update() {
    // The corner is created lazily, possibly after this plugin: catch it on the next update.
    if (!this.corner) this.sync();
  }

  private sync() {
    const corner = this.view.dom.querySelector<HTMLElement>(":scope > .cm-openidea-corner");
    if (corner) this.track(corner);
  }

  private measure() {
    const corner = this.corner;
    if (!corner) return;
    const width = corner.getBoundingClientRect().width;
    let inset = width > 0 ? round(width) + CORNER_GAP : 0;
    // A narrow window or a wide corner: keep at least half of the width for text.
    const room = this.view.scrollDOM.clientWidth;
    if (inset > 0 && room > 0) inset = Math.min(inset, Math.floor(room / 2));
    this.apply(inset);
  }

  private apply(inset: number) {
    if (inset === this.inset) return;
    this.inset = inset;
    const style = this.view.dom.style;
    // An empty corner needs no room; the `theme.ts` fallback is 0.
    if (inset > 0) style.setProperty("--cm-corner-inset", `${inset}px`);
    else style.removeProperty("--cm-corner-inset");
    // The line boxes changed: CodeMirror re-measures the content and the scroll extent.
    this.view.requestMeasure();
  }

  destroy() {
    this.observer?.disconnect();
    this.observer = null;
    this.corner = null;
  }
}

export const cornerInset = ViewPlugin.fromClass(CornerInset);
