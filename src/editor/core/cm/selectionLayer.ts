import { Direction, EditorView, RectangleMarker, layer } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

/** Rounds a CSS length to the nearest device pixel. */
export function snapToDevicePixel(v: number, dpr: number): number {
  return Math.round(v * dpr) / dpr;
}

/**
 * Re-emits selection rectangles with top and bottom edges snapped to device pixels. A multi-line
 * selection is drawn as several stacked rectangles; their shared edge comes from separate float
 * sums, and when it lands on a fractional pixel each side rounds differently and a 1px seam shows.
 */
export function snapMarkers(markers: readonly RectangleMarker[], className: string, dpr: number): RectangleMarker[] {
  return markers.map((m) => {
    const top = snapToDevicePixel(m.top, dpr);
    const bottom = snapToDevicePixel(m.top + m.height, dpr);
    return new RectangleMarker(className, m.left, top, m.width, bottom - top);
  });
}

/**
 * Widens the rectangles that end at the lines' right padding (`rightSide`, where CodeMirror stops a selection
 * that runs past a line end) by that padding (`pad`), so selected lines fill the editor to its right edge as in
 * IDEA. Rectangles that end inside a line stay as they are.
 */
export function widenToRightEdge(
  markers: readonly RectangleMarker[],
  className: string,
  rightSide: number,
  pad: number,
): RectangleMarker[] {
  if (pad <= 0) return [...markers];
  return markers.map((m) =>
    m.width !== null && m.width > 0 && Math.abs(m.left + m.width - rightSide) < 0.5
      ? new RectangleMarker(className, m.left, m.top, m.width + pad, m.height)
      : m,
  );
}

const CLASS = "cm-selectionBackground";

/** Where CodeMirror ends a selection past the line end, in layer coordinates, and the lines' right padding (screen px). */
function lineRightEdge(view: EditorView): { rightSide: number; pad: number } {
  const line = view.contentDOM.querySelector(".cm-line");
  const pad = (line ? parseFloat(getComputedStyle(line).paddingRight) || 0 : 0) * view.scaleX;
  const scroller = view.scrollDOM.getBoundingClientRect();
  const base = scroller.left - view.scrollDOM.scrollLeft * view.scaleX;
  return { rightSide: view.contentDOM.getBoundingClientRect().right - pad - base, pad };
}

const snappedSelectionLayer = layer({
  above: false,
  class: "cm-selectionLayer",
  mount: (dom) => dom.classList.add("cm-openidea-selectionLayer"),
  markers(view) {
    const dpr = window.devicePixelRatio || 1;
    const edge = view.textDirection === Direction.LTR ? lineRightEdge(view) : null;
    const out: RectangleMarker[] = [];
    for (const r of view.state.selection.ranges) {
      if (r.empty) continue;
      const markers = snapMarkers(RectangleMarker.forRange(view, CLASS, r), CLASS, dpr);
      out.push(...(edge ? widenToRightEdge(markers, CLASS, edge.rightSide, edge.pad) : markers));
    }
    return out;
  },
  update: (u) => u.docChanged || u.selectionSet || u.viewportChanged,
});

/** Use with `drawSelection()`: replaces its selection layer, which is hidden. */
export function seamlessSelection(): Extension {
  return [
    snappedSelectionLayer,
    EditorView.theme({
      ".cm-selectionLayer:not(.cm-openidea-selectionLayer)": {
        display: "none",
      },
      // drawSelection hides the native selection inside the lines only. WebKit also fills the gaps left of
      // selected lines (the text inset) with the content's own ::selection colour, which showed as small
      // blocks next to the gutter.
      ".cm-content::selection": { backgroundColor: "transparent" },
    }),
  ];
}
