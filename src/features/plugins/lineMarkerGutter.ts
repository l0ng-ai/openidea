/**
 * Gutter icons from plugins' `line-markers` providers. Asked once per document version
 * (debounced); markers follow their lines in between; a click opens the
 * marker's target. The gutter column exists only while there are markers,
 * so editors without plugin providers keep their usual width.
 */
import { Compartment, RangeSet, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, type ViewUpdate } from "@codemirror/view";
import type { EditorDocContext } from "@/editor/api";
import { navigationButton } from "./navigationButton";
import { pluginsBackend } from "./backend";
import { commands, type LineMarkerInfo } from "@/platform/ipc";
import { gutterIconMarkup } from "@/ui";
import styles from "@/editor/navigation/LineMarkers.module.css";

const DEBOUNCE_MS = 400;

const ICONS: Record<string, string> = {
  implemented: "gutter-implemented",
  implementing: "gutter-implementing",
  overridden: "gutter-overridden",
  overriding: "gutter-overriding",
  run: "gutter-run",
  navigate: "gutter-implementing",
};

/** Icon name for a plugin marker (`navigate` when unknown). */
export function markerIcon(icon: string | null): string {
  return ICONS[icon ?? "navigate"] ?? ICONS.navigate!;
}

interface Placed {
  marker: LineMarkerInfo;
  pos: number;
}

const setMarkers = StateEffect.define<Placed[]>();

const markersField = StateField.define<Placed[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setMarkers)) return e.value;
    if (!tr.docChanged || !value.length) return value;
    return value.map((m) => ({ ...m, pos: tr.state.doc.lineAt(tr.changes.mapPos(m.pos, -1)).from }));
  },
});

/** Markers on existing lines, at their line starts. */
export function placeMarkers(doc: Text, markers: readonly LineMarkerInfo[]): Placed[] {
  return markers.filter((m) => m.line < doc.lines).map((marker) => ({ marker, pos: doc.line(marker.line + 1).from }));
}

class PluginMarker extends GutterMarker {
  constructor(readonly marker: LineMarkerInfo) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return (
      other instanceof PluginMarker &&
      other.marker.tooltip === this.marker.tooltip &&
      other.marker.icon === this.marker.icon &&
      JSON.stringify(other.marker.target) === JSON.stringify(this.marker.target)
    );
  }
  override toDOM(): Node {
    const el = this.marker.target
      ? navigationButton([this.marker.target], markerIcon(this.marker.icon))
      : document.createElement("span");
    el.className = `${styles.marker} cm-plugin-mapping-button`;
    el.title = this.marker.tooltip;
    el.setAttribute("aria-label", this.marker.tooltip);
    el.innerHTML = gutterIconMarkup(markerIcon(this.marker.icon)) ?? "";
    return el;
  }
}

class MarkersPlugin {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private shown = false;
  private off: () => void;

  constructor(
    private view: EditorView,
    private doc: number,
    private column: Compartment,
  ) {
    this.off = pluginsBackend().onEvent((event) => {
      if (event.type !== "documentIndexesChanged") return;
      this.generation++;
      this.shown = false;
      this.view.dispatch({ effects: [setMarkers.of([]), this.column.reconfigure([])] });
      this.schedule();
    });
    this.schedule();
  }

  update(u: ViewUpdate) {
    if (u.docChanged) this.schedule();
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), DEBOUNCE_MS);
  }

  private async run() {
    this.timer = null;
    const gen = ++this.generation;
    const text = this.view.state.doc;
    try {
      const markers = await commands.pluginLineMarkers(this.doc);
      if (gen !== this.generation || this.view.state.doc !== text || !this.view.dom.isConnected) return;
      if (markers.status !== "ok") return;
      const placed = placeMarkers(text, markers.data);
      if (!placed.length && !this.view.state.field(markersField).length) return;
      const effects: StateEffect<unknown>[] = [setMarkers.of(placed)];
      if (placed.length > 0 !== this.shown) {
        this.shown = placed.length > 0;
        effects.push(this.column.reconfigure(this.shown ? markerColumn : []));
      }
      this.view.dispatch({ effects });
    } catch (e) {
      console.debug("[plugin line markers]", e);
    }
  }

  destroy() {
    this.off();
    if (this.timer) clearTimeout(this.timer);
    this.generation++;
  }
}

const markerColumn: Extension = gutter({
  class: `${styles.gutter} cm-openidea-gutter-pluginMarkers`,
  markers: (view) =>
    RangeSet.of(
      view.state.field(markersField).map((m) => new PluginMarker(m.marker).range(m.pos)),
      true,
    ),
});

export function pluginLineMarkerGutter(ctx: EditorDocContext): Extension {
  if (ctx.doc < 0) return [];
  const doc = ctx.doc;
  const column = new Compartment();
  return [markersField, column.of([]), ViewPlugin.define((view) => new MarkersPlugin(view, doc, column))];
}
