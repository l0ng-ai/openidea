/**
 * Gutter icons from plugins' `line-markers` providers. Asked once per document version
 * (debounced); markers follow their lines in between; a click opens the
 * marker's target. The gutter column exists only while there are markers,
 * so editors without plugin providers keep their usual width.
 */
import { Compartment, RangeSet, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, type ViewUpdate } from "@codemirror/view";
import { shownAgain, type EditorDocContext } from "@/editor/api";
import { navigationButton } from "./navigationButton";
import { tx } from "@/platform/i18n";
import { pluginsBackend } from "./backend";
import { commands, type LineMarkerInfo } from "@/platform/ipc";
import { gutterIconMarkup, isIconName } from "@/ui/icons";
import { onMarkerIconsChanged, resolveMarkerIcon } from "./markerIcons";
import styles from "@/editor/navigation/LineMarkers.module.css";

const DEBOUNCE_MS = 400;

const ICONS: Record<string, string> = {
  implemented: "gutter-implemented",
  implementing: "gutter-implementing",
  overridden: "gutter-overridden",
  overriding: "gutter-overriding",
  run: "gutter-run",
  navigate: "gutter-navigate",
};

/** Legacy aliases and ordinary registered icon names; navigate when unknown. */
export function markerIcon(icon: string | null): string {
  const name = icon ?? "navigate";
  return Object.hasOwn(ICONS, name) ? ICONS[name]! : isIconName(name) ? name : ICONS.navigate!;
}

interface Placed {
  markers: LineMarkerInfo[];
  icon: string;
  pos: number;
}

function targetKey(marker: LineMarkerInfo): string {
  const target = marker.target;
  return target
    ? JSON.stringify([
        target.path,
        target.range.start.line,
        target.range.start.col,
        target.range.end.line,
        target.range.end.col,
      ])
    : JSON.stringify([marker.pluginId, marker.tooltip]);
}

function markerTooltip(markers: readonly LineMarkerInfo[]): string {
  const descriptions = [...new Set(markers.map((marker) => marker.tooltip).filter(Boolean))];
  if (markers.length === 1) return descriptions[0] ?? "";
  return [`${tx("Related targets")} (${markers.length})`, ...descriptions.slice(0, 5)].join("\n");
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

/** One marker per line and resolved icon, retaining all distinct destinations. */
export function placeMarkers(doc: Text, markers: readonly LineMarkerInfo[]): Placed[] {
  const groups = new Map<string, { placed: Placed; seen: Set<string> }>();
  for (const marker of markers) {
    if (!Number.isInteger(marker.line) || marker.line < 0 || marker.line >= doc.lines) continue;
    const icon = markerIcon(marker.icon);
    const key = `${marker.line}:${icon}`;
    let group = groups.get(key);
    if (!group) {
      group = { placed: { markers: [], icon, pos: doc.line(marker.line + 1).from }, seen: new Set() };
      groups.set(key, group);
    }
    const target = targetKey(marker);
    if (!group.seen.has(target)) {
      group.seen.add(target);
      group.placed.markers.push(marker);
    }
  }
  return [...groups.values()].map(({ placed }) => placed);
}

class PluginMarker extends GutterMarker {
  constructor(readonly placed: Placed) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return (
      other instanceof PluginMarker &&
      other.placed.icon === this.placed.icon &&
      other.placed.markers.length === this.placed.markers.length &&
      other.placed.markers.every((marker, index) => {
        const current = this.placed.markers[index]!;
        return marker.tooltip === current.tooltip && targetKey(marker) === targetKey(current);
      })
    );
  }
  override toDOM(): Node {
    const targets = this.placed.markers.flatMap((marker) => (marker.target ? [marker.target] : []));
    const tooltip = markerTooltip(this.placed.markers);
    const el = targets.length ? navigationButton(targets, this.placed.icon, tooltip) : document.createElement("span");
    el.className = `${styles.marker} cm-plugin-mapping-button`;
    el.title = tooltip;
    el.setAttribute("aria-label", tooltip);
    el.innerHTML = gutterIconMarkup(this.placed.icon) ?? "";
    return el;
  }
}

class MarkersPlugin {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private skipped = false;
  private shown = false;
  private off: () => void;

  constructor(
    private view: EditorView,
    private doc: number,
    private column: Compartment,
  ) {
    const offBackend = pluginsBackend().onEvent((event) => {
      if (event.type !== "documentIndexesChanged") return;
      this.generation++;
      this.shown = false;
      this.view.dispatch({ effects: [setMarkers.of([]), this.column.reconfigure([])] });
      this.schedule();
    });
    const offIcons = onMarkerIconsChanged(() => {
      this.generation++;
      this.schedule();
    });
    this.off = () => {
      offBackend();
      offIcons();
    };
    this.schedule();
  }

  update(u: ViewUpdate) {
    if (u.docChanged || (this.skipped && shownAgain(u))) this.schedule();
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
      const resolved = await Promise.all(
        markers.data.map(async (marker) => ({
          ...marker,
          icon: await resolveMarkerIcon(marker.pluginId, marker.icon),
        })),
      );
      if (gen !== this.generation || this.view.state.doc !== text) return;
      this.skipped = !this.view.dom.isConnected;
      if (this.skipped) return;
      const placed = placeMarkers(text, resolved);
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
      view.state.field(markersField).map((m) => new PluginMarker(m).range(m.pos)),
      true,
    ),
});

export function pluginLineMarkerGutter(ctx: EditorDocContext): Extension {
  if (ctx.doc < 0) return [];
  const doc = ctx.doc;
  const column = new Compartment();
  return [markersField, column.of([]), ViewPlugin.define((view) => new MarkersPlugin(view, doc, column))];
}
