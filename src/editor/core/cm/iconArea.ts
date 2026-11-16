/**
 * The gutter's icon area (IDEA's line marker area): run icons, inheritance markers and the
 * rendered-doc toggle share one column, as wide as the most icons on any line, instead of a
 * column per kind that stays empty on the lines where another kind has its icon.
 */
import { Facet, type EditorState, type Extension, type RangeSet, type Transaction } from "@codemirror/state";
import {
  EditorView,
  GutterMarker,
  ViewPlugin,
  gutter,
  type BlockInfo,
  type ViewUpdate,
  type WidgetType,
} from "@codemirror/view";

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

/**
 * Where a marker on the line starting at `pos` goes after `tr`: the start of the line its text is
 * on now. An Enter at the start of the line moves the marker down with its text, as every source
 * must agree; one left on the new blank line until its source refreshes would split a line's icons
 * and briefly narrow the area, shifting the code.
 */
export function mapLineStart(tr: Transaction, pos: number): number {
  return tr.state.doc.lineAt(tr.changes.mapPos(pos, 1)).from;
}

export const iconAreaSource = Facet.define<IconAreaSource, readonly IconAreaSource[]>({
  combine: (sources) => [...sources].sort((a, b) => a.order - b.order),
});

/** `count` icons of width, the room the area keeps. Hidden; not buttons. */
class IconSpacer extends GutterMarker {
  constructor(readonly count: number) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return other instanceof IconSpacer && other.count === this.count;
  }
  override toDOM(): Node {
    const el = document.createElement("span");
    el.className = "cm-openidea-iconAreaSpacer";
    for (let i = 0; i < this.count; i++)
      el.appendChild(document.createElement("span")).className = "cm-openidea-iconSpacer";
    return el;
  }
}

const noSpacer = new (class extends GutterMarker {})();

/** The most icons on one line, at least one while a source reserves room. */
function mostIcons(view: EditorView): number {
  const sources = view.state.facet(iconAreaSource);
  const lines = new Map<number, number>();
  let most = sources.some((s) => s.reserve?.(view.state)) ? 1 : 0;
  for (const s of sources)
    for (const it = s.markers(view).iter(); it.value; it.next()) {
      const line = view.state.doc.lineAt(it.from).from;
      const n = (lines.get(line) ?? 0) + 1;
      lines.set(line, n);
      most = Math.max(most, n);
    }
  return most;
}

/** How long the text and its icons stay unchanged before the area may narrow. */
export const SETTLE_MS = 2000;

/**
 * After an edit each source places its icons again on its own schedule (a run icon before the
 * language server's inheritance icons), so a line's icons briefly part. The area widens at once
 * but narrows only once nothing changed for `SETTLE_MS`, so the text does not shift back and forth.
 */
const areaWidth = ViewPlugin.fromClass(
  class {
    private holdUntil = 0;
    /** The most icons on a line now, and the icons of width the spacer keeps. */
    private icons = 0;
    private kept = 0;
    private timer: ReturnType<typeof setTimeout> | undefined;
    constructor(readonly view: EditorView) {}

    spacer(prev: GutterMarker | null, update: ViewUpdate | null): GutterMarker {
      const icons = mostIcons(this.view);
      const now = Date.now();
      if (update && (update.docChanged || icons !== this.icons)) {
        this.holdUntil = now + SETTLE_MS;
        clearTimeout(this.timer);
        // Once settled, any update asks for the spacer again.
        this.timer = setTimeout(() => this.kept > this.icons && this.view.dispatch({}), SETTLE_MS);
      }
      this.icons = icons;
      if (prev && now < this.holdUntil && icons < this.kept) return prev;
      this.kept = icons;
      return icons ? new IconSpacer(icons) : noSpacer;
    }

    destroy() {
      clearTimeout(this.timer);
    }
  },
);

const spacer = (view: EditorView, prev: GutterMarker | null, update: ViewUpdate | null) =>
  view.plugin(areaWidth)?.spacer(prev, update) ?? noSpacer;

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
  initialSpacer: (view) => spacer(view, null, null),
  updateSpacer: (prev, update) => spacer(update.view, prev, update),
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
  ".cm-openidea-iconArea .cm-gutterElement > *, .cm-openidea-iconAreaSpacer > *": { margin: "0 1px" },
  ".cm-openidea-iconArea .cm-gutterElement > :first-child, .cm-openidea-iconAreaSpacer > :first-child": {
    marginLeft: "5px",
  },
  // The spacer's icons are laid out as the line's own.
  ".cm-openidea-iconAreaSpacer": { display: "contents" },
  ".cm-openidea-iconSpacer": { display: "inline-block", width: "14px" },
});

/** Installed in every editor; empty (no width) while no source has markers or reserves room. */
export const iconAreaExtension: Extension = [areaWidth, areaGutter, areaTheme];
