import { BlockType, Direction, EditorView, RectangleMarker, layer } from "@codemirror/view";
import type { Extension, SelectionRange } from "@codemirror/state";

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

/**
 * Grows a selection's outer rectangles to whole line boxes. CodeMirror sizes the first and last row of a
 * selection to the text's glyph box (`glyph` px tall, the shortest rectangle), so a gap of the line's
 * leading showed above and below it; IDEA fills the full line height. `lineHeight` is the editor's line
 * height in the same units.
 */
export function growToLineBoxes(
  markers: readonly RectangleMarker[],
  className: string,
  lineHeight: number,
): RectangleMarker[] {
  if (!markers.length) return [];
  const glyph = Math.min(...markers.map((m) => m.height));
  const leading = Math.max(0, Math.min(lineHeight / 2, (lineHeight - glyph) / 2));
  if (leading < 0.25) return [...markers];
  const top = Math.min(...markers.map((m) => m.top));
  const bottom = Math.max(...markers.map((m) => m.top + m.height));
  return markers.map((m) => {
    const up = Math.abs(m.top - top) < 0.5 ? leading : 0;
    const down = Math.abs(m.top + m.height - bottom) < 0.5 ? leading : 0;
    return up || down ? new RectangleMarker(className, m.left, m.top - up, m.width, m.height + up + down) : m;
  });
}

/**
 * Adds what is missing up to `right` on rows (`{ top, bottom }`, layer coordinates) the selection runs past the
 * end of. CodeMirror skips folded ranges, so a selection starting on a folded line stopped at its visible text,
 * short of the placeholder and the edge. Rows with no rectangle at all are left alone.
 */
export function fillRowEnds(
  markers: readonly RectangleMarker[],
  className: string,
  rows: readonly { top: number; bottom: number }[],
  right: number,
): RectangleMarker[] {
  const out = [...markers];
  for (const row of rows) {
    let end = -Infinity;
    for (const m of markers)
      if (m.top < row.bottom - 0.5 && m.top + m.height > row.top + 0.5)
        end = Math.max(end, m.width === null ? Infinity : m.left + m.width);
    if (end === -Infinity || end >= right - 0.5) continue;
    out.push(new RectangleMarker(className, end, row.top, right - end, row.bottom - row.top));
  }
  return out;
}

const CLASS = "cm-selectionBackground";

/** The line boxes (layer coordinates) of the visible rows that `r` runs past the end of. */
function rowsPastEnd(view: EditorView, r: SelectionRange): { top: number; bottom: number }[] {
  const scroller = view.scrollDOM.getBoundingClientRect();
  const offset = view.documentTop - (scroller.top - view.scrollDOM.scrollTop * view.scaleY);
  return view.viewportLineBlocks
    .filter((b) => b.type === BlockType.Text && b.to >= r.from && b.to < r.to)
    .map((b) => ({ top: offset + b.top, bottom: offset + b.bottom }));
}

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
      const lines = growToLineBoxes(
        RectangleMarker.forRange(view, CLASS, r),
        CLASS,
        view.defaultLineHeight * view.scaleY,
      );
      const full = edge
        ? fillRowEnds(
            widenToRightEdge(lines, CLASS, edge.rightSide, edge.pad),
            CLASS,
            rowsPastEnd(view, r),
            edge.rightSide + edge.pad,
          )
        : lines;
      out.push(...snapMarkers(full, CLASS, dpr));
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
