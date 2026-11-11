import { BlockType, Direction, EditorView, RectangleMarker, layer, type BlockInfo } from "@codemirror/view";
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

/** A visual row's line box, top and bottom, in layer coordinates. */
export type RowBox = { top: number; bottom: number };

/**
 * Fits a selection's rectangles to whole line boxes (`rowAt(y)` gives the box of the row at `y`).
 * CodeMirror sizes the first and last row of a selection to the text's glyph box: shorter than the
 * line height, the leading stayed unselected; taller (a larger font size with the default line
 * height), the glyph box reached into the rows above and below. Probing each outer row at its
 * vertical midpoint and aligning the row seams to the line boxes keeps every selected row exact.
 */
export function growToLineBoxes(
  markers: readonly RectangleMarker[],
  className: string,
  rowAt: (y: number) => RowBox,
  edges: { first: boolean; last: boolean } = { first: true, last: true },
): RectangleMarker[] {
  if (!markers.length) return [];
  const top = Math.min(...markers.map((m) => m.top));
  const bottom = Math.max(...markers.map((m) => m.top + m.height));
  const firstSample = edges.first ? markers.find((m) => Math.abs(m.top - top) < 0.5) : undefined;
  const lastSample = edges.last ? markers.find((m) => Math.abs(m.top + m.height - bottom) < 0.5) : undefined;
  const firstRow = firstSample ? rowAt(firstSample.top + firstSample.height / 2) : null;
  const lastRow = lastSample ? rowAt(lastSample.top + lastSample.height / 2) : null;
  return markers.flatMap((m) => {
    if (m.width !== null && m.width <= 0) return [];
    const end = m.top + m.height;
    const isFirst = firstRow !== null && Math.abs(m.top - top) < 0.5;
    const isLast = lastRow !== null && Math.abs(end - bottom) < 0.5;
    let t = m.top;
    let b = end;
    if (isFirst && isLast) {
      t = firstRow.top;
      b = lastRow.bottom;
    } else if (isFirst) {
      t = firstRow.top;
      b = firstRow.bottom;
    } else if (isLast) {
      t = lastRow.top;
      b = lastRow.bottom;
    } else {
      if (firstRow) t = firstRow.bottom;
      if (lastRow) b = lastRow.top;
    }
    if (b - t <= 0) return [];
    return [t !== m.top || b !== end ? new RectangleMarker(className, m.left, t, m.width, b - t) : m];
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
  rows: readonly RowBox[],
  right: number,
): RectangleMarker[] {
  const out = [...markers];
  for (const row of rows) {
    // Only rectangles across the row's middle count (the one below may reach into its leading), and the fill
    // takes their height: flush with them, and no overlap to darken a translucent selection colour.
    const mid = (row.top + row.bottom) / 2;
    let end = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    for (const m of markers) {
      if (m.top >= mid || m.top + m.height <= mid) continue;
      end = Math.max(end, m.width === null ? Infinity : m.left + m.width);
      top = Math.min(top, m.top);
      bottom = Math.max(bottom, m.top + m.height);
    }
    if (end === -Infinity || end >= right - 0.5) continue;
    out.push(
      new RectangleMarker(
        className,
        end,
        Math.max(top, row.top),
        right - end,
        Math.min(bottom, row.bottom) - Math.max(top, row.top),
      ),
    );
  }
  return out;
}

/**
 * Cuts the vertical spans in `gaps` (`{ top, bottom }`, layer coordinates) out of the rectangles. CodeMirror fills
 * everything between a selection's first and last line with one rectangle, which runs over the block widgets
 * (code lenses) in between, or over part of one.
 */
export function cutOutGaps(
  markers: readonly RectangleMarker[],
  className: string,
  gaps: readonly RowBox[],
): RectangleMarker[] {
  if (!gaps.length) return [...markers];
  const out: RectangleMarker[] = [];
  for (const m of markers) {
    let pieces: Array<[number, number]> = [[m.top, m.top + m.height]];
    for (const g of gaps) {
      pieces = pieces.flatMap(([t, b]): Array<[number, number]> =>
        g.bottom <= t || g.top >= b
          ? [[t, b]]
          : (
              [
                [t, Math.min(b, g.top)],
                [Math.max(t, g.bottom), b],
              ] as Array<[number, number]>
            ).filter(([pt, pb]) => pb - pt > 0.5),
      );
    }
    if (pieces.length === 1 && pieces[0]![0] === m.top && pieces[0]![1] === m.top + m.height) out.push(m);
    else for (const [t, b] of pieces) out.push(new RectangleMarker(className, m.left, t, m.width, b - t));
  }
  return out;
}

/**
 * Moves the rectangles that start at `from` to `to`, keeping their right edges. CodeMirror starts the rows a selection
 * runs through from the line start at the lines' left padding rounded down to whole pixels (`parseInt`), and a row
 * that starts at a line's first character at the real padding, so with a fractional inset one row of a selection
 * started a device pixel to the right of the others.
 */
export function alignLeftEdges(
  markers: readonly RectangleMarker[],
  className: string,
  from: number,
  to: number,
): RectangleMarker[] {
  if (Math.abs(to - from) < 0.01) return [...markers];
  return markers.map((m) =>
    m.width !== null && Math.abs(m.left - from) < 0.01
      ? new RectangleMarker(className, to, m.top, m.width - (to - from), m.height)
      : m,
  );
}

/**
 * Drops the rectangles that start at `from` and end by `to`, covering only the inset before a line's text. A selection
 * that ends at the start of a line made CodeMirror paint that line from its rounded edge (`from`) to the first
 * character (`to`): a sliver left of the text, a device pixel wide with a fractional inset. IDEA paints nothing there.
 */
export function dropInsetSlivers(markers: readonly RectangleMarker[], from: number, to: number): RectangleMarker[] {
  return markers.filter((m) => m.width === null || Math.abs(m.left - from) >= 0.01 || m.left + m.width > to + 0.01);
}

/** Adds one rectangle from `left` to `right` over each of `gaps` (layer coordinates). */
export function fillGaps(
  markers: readonly RectangleMarker[],
  className: string,
  gaps: readonly RowBox[],
  left: number,
  right: number,
): RectangleMarker[] {
  if (!gaps.length || !(right > left)) return [...markers];
  return [...markers, ...gaps.map((g) => new RectangleMarker(className, left, g.top, right - left, g.bottom - g.top))];
}

/**
 * A line block's parts. A line with block widgets attached (a code lens above it, say) comes back from
 * `lineBlockAt*` and `viewportLineBlocks` as one block whose `type` lists the widgets and the text.
 */
const parts = (block: BlockInfo): readonly BlockInfo[] =>
  Array.isArray(block.type) ? (block.type as readonly BlockInfo[]) : [block];

/** The text part of a line block at document `y` (the one nearest to it when `y` is on a widget). */
export function textBlock(block: BlockInfo, y: number): BlockInfo {
  const texts = parts(block).filter((b) => b.type === BlockType.Text);
  return (
    texts.find((b) => y >= b.top && y < b.bottom) ??
    texts.reduce<BlockInfo | null>(
      (best, b) =>
        !best || Math.abs(y - (b.top + b.bottom) / 2) < Math.abs(y - (best.top + best.bottom) / 2) ? b : best,
      null,
    ) ??
    block
  );
}

/** The text blocks among `blocks`, taken out of lines that carry block widgets. */
export function textBlocks(blocks: readonly BlockInfo[]): BlockInfo[] {
  return blocks.flatMap((b) => parts(b).filter((p) => p.type === BlockType.Text));
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

/**
 * Where CodeMirror starts a selection running through a line start (`rounded`: the left padding cut to whole pixels)
 * and where it starts one beginning at a line's first character (`real`: the padding as it is), in layer coordinates.
 */
function lineLeftEdge(view: EditorView): { rounded: number; real: number } | null {
  const line = view.contentDOM.querySelector(".cm-line");
  if (!line) return null;
  const style = getComputedStyle(line);
  const scroller = view.scrollDOM.getBoundingClientRect();
  const left = view.contentDOM.getBoundingClientRect().left - (scroller.left - view.scrollDOM.scrollLeft * view.scaleX);
  const rounded = left + parseInt(style.paddingLeft) + Math.min(0, parseInt(style.textIndent));
  const real = left + parseFloat(style.paddingLeft) + Math.min(0, parseFloat(style.textIndent));
  return Number.isFinite(rounded) && Number.isFinite(real) ? { rounded, real } : null;
}

/** Layer y = document y + this offset. */
function layerOffset(view: EditorView): number {
  const scroller = view.scrollDOM.getBoundingClientRect();
  return view.documentTop - (scroller.top - view.scrollDOM.scrollTop * view.scaleY);
}

/** The box of the visual row at layer `y`: its line's text, or for a wrapped line the row of it. */
function rowAt(view: EditorView, offset: number, y: number): RowBox {
  const block = textBlock(view.lineBlockAtHeight(y - offset), y - offset);
  const lh = view.defaultLineHeight;
  if ((!view.lineWrapping && !block.widgetLineBreaks) || block.height < lh * 1.5)
    return { top: offset + block.top, bottom: offset + block.bottom };
  const rows = Math.max(1, Math.round(block.height / lh));
  const rh = block.height / rows;
  const idx = Math.max(0, Math.min(rows - 1, Math.floor((y - offset - block.top) / rh)));
  return { top: offset + block.top + idx * rh, bottom: offset + block.top + (idx + 1) * rh };
}

/** Whether `pos` resolves to a text block on `side` (as opposed to a standalone block widget). */
function hasTextBlockAt(view: EditorView, pos: number, side: 1 | -1): boolean {
  const line = view.lineBlockAt(pos);
  if (!Array.isArray(line.type)) return line.type === BlockType.Text;
  let best: BlockInfo | undefined;
  for (const l of line.type as readonly BlockInfo[]) {
    if (l.from > pos) break;
    if (l.to < pos) continue;
    if (l.from < pos && l.to > pos) return l.type === BlockType.Text;
    if (!best || (l.type === BlockType.Text && (best.type !== l.type || (side < 0 ? l.from < pos : l.to > pos))))
      best = l;
  }
  return (best ?? line).type === BlockType.Text;
}

/** The line boxes (layer coordinates) of the visible rows that `r` runs past the end of. */
function rowsPastEnd(view: EditorView, offset: number, r: SelectionRange): RowBox[] {
  return textBlocks(view.viewportLineBlocks)
    .filter((b) => b.to >= r.from && b.to < r.to)
    .map((b) => ({ top: offset + b.top, bottom: offset + b.bottom }));
}

/**
 * The visible block widgets attached to lines (code lenses and the like, layer coordinates) around `r`. IDEA paints
 * the ones the selection runs through (`fill`: it selects text on both sides) whole, and leaves the ones it stops at
 * (`cut`: it ends at the start of the line below one, or starts at the end of the line above one) unpainted.
 */
function lineWidgets(view: EditorView, offset: number, r: SelectionRange): { cut: RowBox[]; fill: RowBox[] } {
  const cut: RowBox[] = [];
  const fill: RowBox[] = [];
  for (const line of view.viewportLineBlocks) {
    if (!Array.isArray(line.type) || line.to < r.from || line.from > r.to) continue;
    for (const w of parts(line)) {
      if (w.height <= 0 || (w.type !== BlockType.WidgetBefore && w.type !== BlockType.WidgetAfter)) continue;
      // A widget before a line sits at the line's start, one after it at the line's end.
      const at = w.type === BlockType.WidgetBefore ? line.from : line.to;
      (r.from < at && r.to > at ? fill : cut).push({ top: offset + w.top, bottom: offset + w.bottom });
    }
  }
  return { cut, fill };
}

const snappedSelectionLayer = layer({
  above: false,
  class: "cm-selectionLayer",
  mount: (dom) => dom.classList.add("cm-openidea-selectionLayer"),
  markers(view) {
    const ranges = view.state.selection.ranges.filter((r) => !r.empty);
    if (!ranges.length) return [];
    const dpr = window.devicePixelRatio || 1;
    const edge = view.textDirection === Direction.LTR ? lineRightEdge(view) : null;
    const start = view.textDirection === Direction.LTR ? lineLeftEdge(view) : null;
    const offset = layerOffset(view);
    const out: RectangleMarker[] = [];
    for (const r of ranges) {
      if (r.to <= view.viewport.from || r.from >= view.viewport.to) continue;
      const from = Math.max(r.from, view.viewport.from);
      const to = Math.min(r.to, view.viewport.to);
      const lines = growToLineBoxes(RectangleMarker.forRange(view, CLASS, r), CLASS, (y) => rowAt(view, offset, y), {
        first: hasTextBlockAt(view, from, 1),
        last: hasTextBlockAt(view, to, -1),
      });
      // The sliver CodeMirror draws on a line the selection ends at the start of marks that line as the last row for
      // growToLineBoxes, so it goes only after the rows are grown. Then every row starts at the rounded edge: a pixel
      // left of the text, as IDEA leaves a gap between them.
      const aligned = start
        ? alignLeftEdges(dropInsetSlivers(lines, start.rounded, start.real), CLASS, start.real, start.rounded)
        : lines;
      if (!aligned.length) continue;
      const full = edge
        ? fillRowEnds(
            widenToRightEdge(aligned, CLASS, edge.rightSide, edge.pad),
            CLASS,
            rowsPastEnd(view, offset, r),
            edge.rightSide + edge.pad,
          )
        : aligned;
      // Block widgets: cut them all out of CodeMirror's rectangles, then paint the ones the selection runs through
      // with one rectangle each, so a translucent selection colour never doubles up over them.
      const widgets = lineWidgets(view, offset, r);
      const left = Math.min(...full.map((m) => m.left));
      const right = edge ? edge.rightSide + edge.pad : Math.max(...full.map((m) => m.left + (m.width ?? 0)));
      const painted = fillGaps(
        cutOutGaps(full, CLASS, [...widgets.cut, ...widgets.fill]),
        CLASS,
        widgets.fill,
        left,
        right,
      );
      out.push(...snapMarkers(painted, CLASS, dpr));
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
