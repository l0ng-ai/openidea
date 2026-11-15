/**
 * The gutter's icon area (IDEA's line marker area): run icons, inheritance markers and the
 * rendered-doc toggle share one column, as wide as the most icons on any line, instead of a
 * column per kind that stays empty on the lines where another kind has its icon.
 */
import { Facet, type EditorState, type Extension, type RangeSet } from "@codemirror/state";
import { EditorView, GutterMarker, gutter, type BlockInfo, type ViewUpdate, type WidgetType } from "@codemirror/view";

export interface IconAreaSource {
  /** Left to right within a line: lower first. */
  order: number;
  markers(view: EditorView): RangeSet<GutterMarker>;
  /** The marker beside a block widget (a rendered doc comment), which has no text line. */
  widgetMarker?(view: EditorView, widget: WidgetType, block: BlockInfo): GutterMarker | null;
  /** Markers that changed without `markers` returning a new set (one shown on hover). */
  lineMarkerChange?(update: ViewUpdate): boolean;
  /** Keeps one icon of width while true, so icons that come and go don't shift the text. */
  reserve?(state: EditorState): boolean;
  /** A press on the area at `block`; true when the source handled it. */
  mousedown?(view: EditorView, block: BlockInfo, event: MouseEvent): boolean;
}

export const iconAreaSource = Facet.define<IconAreaSource, readonly IconAreaSource[]>({
  combine: (sources) => [...sources].sort((a, b) => a.order - b.order),
});

/** The width of one icon, for the reserved column. Hidden; not a button. */
class IconSpacer extends GutterMarker {
  override toDOM(): Node {
    const el = document.createElement("span");
    el.className = "cm-openidea-iconSpacer";
    return el;
  }
}

const iconSpacer = new IconSpacer();
const noSpacer = new (class extends GutterMarker {})();

const reserved = (state: EditorState) => state.facet(iconAreaSource).some((s) => s.reserve?.(state));

const areaGutter = gutter({
  class: "cm-openidea-iconArea",
  markers: (view) => view.state.facet(iconAreaSource).map((s) => s.markers(view)),
  widgetMarker: (view, widget, block) => {
    for (const s of view.state.facet(iconAreaSource)) {
      const marker = s.widgetMarker?.(view, widget, block);
      if (marker) return marker;
    }
    return null;
  },
  lineMarkerChange: (update) =>
    update.startState.facet(iconAreaSource) !== update.state.facet(iconAreaSource) ||
    update.state.facet(iconAreaSource).some((s) => s.lineMarkerChange?.(update)),
  initialSpacer: (view) => (reserved(view.state) ? iconSpacer : noSpacer),
  updateSpacer: (_spacer, update) => (reserved(update.state) ? iconSpacer : noSpacer),
  domEventHandlers: {
    mousedown: (view, block, event) =>
      view.state.facet(iconAreaSource).some((s) => s.mousedown?.(view, block, event as MouseEvent) ?? false),
  },
});

const areaTheme = EditorView.baseTheme({
  ".cm-openidea-iconArea .cm-gutterElement": {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: "2px",
  },
  // Room around the icons, not the element: an area without icons takes no width.
  ".cm-openidea-iconArea .cm-gutterElement > *": { margin: "0 1px" },
  ".cm-openidea-iconArea .cm-gutterElement > :first-child": { marginLeft: "5px" },
  ".cm-openidea-iconSpacer": { display: "inline-block", width: "14px" },
});

/** Installed in every editor; empty (no width) while no source has markers or reserves room. */
export const iconAreaExtension: Extension = [areaGutter, areaTheme];
