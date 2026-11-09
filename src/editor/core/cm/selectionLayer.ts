import { EditorView, RectangleMarker, layer } from "@codemirror/view";
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

const CLASS = "cm-selectionBackground";

const snappedSelectionLayer = layer({
  above: false,
  class: "cm-selectionLayer",
  mount: (dom) => dom.classList.add("cm-openidea-selectionLayer"),
  markers(view) {
    const dpr = window.devicePixelRatio || 1;
    const out: RectangleMarker[] = [];
    for (const r of view.state.selection.ranges)
      if (!r.empty) out.push(...snapMarkers(RectangleMarker.forRange(view, CLASS, r), CLASS, dpr));
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
    }),
  ];
}
