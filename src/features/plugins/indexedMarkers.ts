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
import type { FileMarkers, Location } from "@/platform/ipc";
import { markerIcon } from "./lineMarkerGutter";
import { usePluginMarkers, watchPluginMarkers } from "./markerStore";
import { navigationButton } from "./navigationButton";

class MappingMarker extends GutterMarker {
  constructor(readonly targets: Location[]) {
    super();
  }
  override eq(other: GutterMarker) {
    return other instanceof MappingMarker && JSON.stringify(other.targets) === JSON.stringify(this.targets);
  }
  override toDOM() {
    return navigationButton(this.targets, markerIcon(null));
  }
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

/** One marker per line, with the targets of every marker on it. */
export function markersOf(view: EditorView, entry: FileMarkers | undefined): RangeSet<GutterMarker> {
  if (!entry || !editorPrefs().showGutterIcons) return RangeSet.empty;
  const doc = view.state.doc;
  const rows = new Map<number, Location[]>();
  for (const marker of entry.markers) {
    const line = doc.lineAt(rangeToOffsets(doc, marker.range).from).from;
    const targets = rows.get(line) ?? [];
    for (const target of marker.targets)
      if (!targets.some((t) => t.path === target.path && JSON.stringify(t.range) === JSON.stringify(target.range)))
        targets.push(target);
    rows.set(line, targets);
  }
  return RangeSet.of(
    [...rows].map(([pos, targets]) => new MappingMarker(targets).range(pos)),
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
        readonly off: () => void;
        readonly unwatch: () => void;
        readonly prefs: () => void;
        constructor(readonly view: EditorView) {
          this.off = usePluginMarkers.subscribe(() => this.schedule());
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
          this.view.dispatch({ effects: setMarkers.of(markersOf(this.view, entry)) });
        }
        destroy() {
          this.disposed = true;
          this.off();
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
