/**
 * Gutter markers from plugins' document indexers, resolved by the host from
 * its cached graph. A click goes to the marker's targets (a chooser when there
 * are several); an edit hides the markers until the edited text is indexed.
 */
import { RangeSet, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, type ViewUpdate } from "@codemirror/view";
import { registerEditorContribution } from "@/editor/api";
import { rangeToOffsets } from "@/editor/lsp/positions";
import { editorPrefs } from "@/platform/editorSettings";
import { useProject } from "@/platform/project";
import type { FileMarkers, IndexedMarker, Location } from "@/platform/ipc";
import { markerIcon } from "./lineMarkerGutter";
import { onMarkerIconsChanged, resolveIndexedMarkerIcon, type IndexedMarkerIcon } from "./markerIcons";
import { usePluginMarkers, watchPluginMarkers } from "./markerStore";
import { navigationButton } from "./navigationButton";

class MappingMarker extends GutterMarker {
  constructor(
    readonly targets: Location[],
    readonly icon: IndexedMarkerIcon | undefined,
  ) {
    super();
  }
  override eq(other: GutterMarker) {
    return (
      other instanceof MappingMarker &&
      other.icon?.icon === this.icon?.icon &&
      other.icon?.tooltip === this.icon?.tooltip &&
      JSON.stringify(other.targets) === JSON.stringify(this.targets)
    );
  }
  override toDOM() {
    return navigationButton(this.targets, markerIcon(this.icon?.icon ?? null), this.icon?.tooltip);
  }
}

const iconKey = (marker: IndexedMarker) => `${marker.pluginId}:${marker.icon}`;

/** The declared icons of the entry's markers, by plugin and declaration id. */
async function resolveIcons(entry: FileMarkers | undefined): Promise<Map<string, IndexedMarkerIcon>> {
  const declared = new Map<string, [pluginId: string, id: string]>();
  for (const marker of entry?.markers ?? [])
    if (marker.icon !== null) declared.set(iconKey(marker), [marker.pluginId, marker.icon]);
  const resolved = await Promise.all(
    [...declared].map(async ([key, [pluginId, id]]) => [key, await resolveIndexedMarkerIcon(pluginId, id)] as const),
  );
  return new Map(resolved.filter((r): r is readonly [string, IndexedMarkerIcon] => r[1] !== undefined));
}

const setMarkers = StateEffect.define<RangeSet<GutterMarker>>();
const markersField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    if (tr.docChanged) value = RangeSet.empty;
    for (const effect of tr.effects) if (effect.is(setMarkers)) value = effect.value;
    return value;
  },
});

/** One marker per line, with the targets of every marker on it and the first declared icon among them. */
export function markersOf(
  view: EditorView,
  entry: FileMarkers | undefined,
  icons: ReadonlyMap<string, IndexedMarkerIcon> = new Map(),
): RangeSet<GutterMarker> {
  if (!entry || !editorPrefs().showGutterIcons) return RangeSet.empty;
  const doc = view.state.doc;
  const rows = new Map<number, { targets: Location[]; icon?: IndexedMarkerIcon }>();
  for (const marker of entry.markers) {
    const line = doc.lineAt(rangeToOffsets(doc, marker.range).from).from;
    const row = rows.get(line) ?? { targets: [] };
    for (const target of marker.targets)
      if (!row.targets.some((t) => t.path === target.path && JSON.stringify(t.range) === JSON.stringify(target.range)))
        row.targets.push(target);
    row.icon ??= marker.icon === null ? undefined : icons.get(iconKey(marker));
    rows.set(line, row);
  }
  return RangeSet.of(
    [...rows].map(([pos, row]) => new MappingMarker(row.targets, row.icon).range(pos)),
    true,
  );
}

export function indexedMarkers(path: string): Extension {
  return [
    markersField,
    gutter({ class: "cm-plugin-mapping-gutter", markers: (v) => v.state.field(markersField) }),
    EditorView.baseTheme({
      ".cm-plugin-mapping-button": {
        border: "none",
        padding: "0 2px",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
        height: "100%",
        display: "flex",
        alignItems: "center",
      },
      ".cm-plugin-mapping-button svg": { width: "16px", height: "16px" },
      ".cm-plugin-mapping-button:focus-visible": { outline: "1px solid var(--accent)" },
    }),
    ViewPlugin.fromClass(
      class {
        last: FileMarkers | undefined;
        queued = false;
        disposed = false;
        generation = 0;
        readonly off: () => void;
        readonly offIcons: () => void;
        readonly unwatch: () => void;
        readonly prefs: () => void;
        constructor(readonly view: EditorView) {
          this.off = usePluginMarkers.subscribe(() => this.schedule());
          this.offIcons = onMarkerIconsChanged(() => {
            this.last = undefined;
            this.schedule();
          });
          this.unwatch = watchPluginMarkers(path);
          this.prefs = useProject.subscribe((s, prev) => {
            if (s.settings !== prev.settings) {
              this.last = undefined;
              this.schedule();
            }
          });
          this.schedule();
        }
        update(update: ViewUpdate) {
          if (update.docChanged) this.last = undefined;
        }
        schedule() {
          if (this.queued || this.disposed) return;
          this.queued = true;
          queueMicrotask(() => {
            this.queued = false;
            if (!this.disposed) this.refresh();
          });
        }
        refresh() {
          const entry = usePluginMarkers.getState().entries.get(path);
          if (entry && entry === this.last) return;
          this.last = entry;
          const doc = this.view.state.doc;
          const generation = ++this.generation;
          void resolveIcons(entry).then((icons) => {
            if (this.disposed || generation !== this.generation || this.view.state.doc !== doc) return;
            this.view.dispatch({ effects: setMarkers.of(markersOf(this.view, entry, icons)) });
          });
        }
        destroy() {
          this.disposed = true;
          this.off();
          this.offIcons();
          this.unwatch();
          this.prefs();
        }
      },
    ),
  ];
}

export function startIndexedMarkers() {
  return registerEditorContribution({
    id: "plugins.indexedMarkers",
    order: 65,
    extensions: (ctx) => (ctx.virtual || ctx.doc < 0 ? [] : indexedMarkers(ctx.path)),
  });
}
