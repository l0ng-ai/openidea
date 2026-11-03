/**
 * Gutter icons for MyBatis mappers: on a mapper interface method, on a mapper
 * XML statement. Clicking one jumps to the other half — the bound statement, or
 * the method it is bound to — and several targets open the usual chooser.
 *
 * The document being edited is parsed here (its own text, masked by the IDE's
 * grammar for Java); the other half is read from the project through
 * `mapperStore`, so an XML file that is not open still lights up its methods.
 * Markers are recomputed a beat after each edit and whenever the index learns
 * about a changed file; they follow Settings › Editor › General › Gutter Icons.
 */
import { RangeSet, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, type ViewUpdate } from "@codemirror/view";
import type { EditorDocContext } from "@/editor/api";
import { literalRanges } from "@/editor/core/cm/literals";
import { debounce, docOf } from "@/editor/lsp/lsp";
import { locationItems, navigateTo, pinToFind } from "@/editor/lsp/navigation";
import { openPopup } from "@/editor/lsp/popupStore";
import { editorPrefs } from "@/platform/editorSettings";
import { useProject } from "@/platform/project";
import { gutterIconMarkup } from "@/ui";
import { parseJavaMapper } from "./java";
import { parseMapperXml } from "./xml";
import { rangesFromLiterals, type MaskSource } from "./mask";
import { javaMarkers, xmlMarkers, type MapperMarker } from "./mapperMarkers";
import { mapperInterfaceFor, mapperXmlFor, onMapperIndexCleared } from "./mapperStore";
import styles from "./Mybatis.module.css";

const DEBOUNCE_MS = 300;

const MARKER_ICON = "gutter-mybatis";

/** Which half of a mapper this document is; anything else gets no markers. */
function sideOf(ctx: EditorDocContext): "java" | "xml" | null {
  if (ctx.virtual || ctx.readOnly) return null;
  return ctx.language === "java" ? "java" : ctx.language === "xml" ? "xml" : null;
}

/** Java: the mask the IDE's own grammar sees, when it has one for this file. */
function javaMask(view: EditorView): MaskSource | undefined {
  const literals = literalRanges(view.state);
  return literals.length ? rangesFromLiterals(literals) : undefined;
}

/** Markers of the open mapper, with its other half resolved from the project. */
export async function mapperMarkers(side: "java" | "xml", text: string, mask?: MaskSource): Promise<MapperMarker[]> {
  if (side === "java") {
    const mapper = parseJavaMapper(text, mask);
    return mapper?.isInterface ? javaMarkers(mapper, await mapperXmlFor(mapper.qualifiedName)) : [];
  }
  const xml = parseMapperXml(text);
  return xml?.namespace ? xmlMarkers(xml, await mapperInterfaceFor(xml.namespace)) : [];
}

// ---------------------------------------------------------------------------
// CodeMirror

interface PlacedMarker {
  marker: MapperMarker;
  /** Line start offset in the current state. */
  pos: number;
}

const setMarkers = StateEffect.define<PlacedMarker[]>();

const markersField = StateField.define<PlacedMarker[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setMarkers)) return e.value;
    if (!tr.docChanged || !value.length) return value;
    return value.map((m) => ({ ...m, pos: tr.state.doc.lineAt(tr.changes.mapPos(m.pos, -1)).from }));
  },
});

function place(doc: Text, markers: readonly MapperMarker[]): PlacedMarker[] {
  return markers.filter((m) => m.line < doc.lines).map((marker) => ({ marker, pos: doc.line(marker.line + 1).from }));
}

const sameMarkers = (a: readonly PlacedMarker[], b: readonly PlacedMarker[]) =>
  a.length === b.length &&
  a.every(
    (m, i) => m.pos === b[i]!.pos && m.marker.name === b[i]!.marker.name && m.marker.tooltip === b[i]!.marker.tooltip,
  );

class MapperGutterMarker extends GutterMarker {
  constructor(readonly marker: MapperMarker) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return (
      other instanceof MapperGutterMarker &&
      other.marker.name === this.marker.name &&
      other.marker.tooltip === this.marker.tooltip
    );
  }
  override toDOM(): Node {
    const el = document.createElement("div");
    el.className = `${styles.marker} cm-openidea-mapperMarker`;
    el.dataset.name = this.marker.name;
    el.title = this.marker.tooltip;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", this.marker.tooltip);
    el.innerHTML = gutterIconMarkup(MARKER_ICON) ?? "";
    return el;
  }
}

const gutterMarkers = new WeakMap<readonly PlacedMarker[], RangeSet<GutterMarker>>();

function markerSet(placed: readonly PlacedMarker[]): RangeSet<GutterMarker> {
  let set = gutterMarkers.get(placed);
  if (!set) {
    set = RangeSet.of(
      placed.map((m) => new MapperGutterMarker(m.marker).range(m.pos)),
      true,
    );
    gutterMarkers.set(placed, set);
  }
  return set;
}

class MarkersPlugin {
  private refresh = debounce(() => void this.run(), DEBOUNCE_MS);
  private generation = 0;
  private offCleared: () => void;
  private offSettings: () => void;

  constructor(private view: EditorView) {
    this.refresh();
    // The other half may have been created, renamed or deleted meanwhile.
    this.offCleared = onMapperIndexCleared(() => this.refresh());
    this.offSettings = useProject.subscribe((state, previous) => {
      if (state.settings !== previous.settings) this.refresh();
    });
  }

  update(u: ViewUpdate) {
    if (u.docChanged) this.refresh();
  }

  private show(placed: PlacedMarker[]) {
    if (!sameMarkers(this.view.state.field(markersField), placed))
      this.view.dispatch({ effects: setMarkers.of(placed) });
  }

  private async run() {
    const view = this.view;
    if (!view.dom.isConnected) return;
    const ctx = docOf(view);
    const side = ctx && sideOf(ctx);
    if (!ctx || !side) return;
    // Settings › Editor › General › Gutter Icons.
    if (!editorPrefs().showGutterIcons) {
      this.show([]);
      return;
    }
    const text = view.state.doc;
    const gen = ++this.generation;
    try {
      const markers = await mapperMarkers(side, text.toString(), side === "java" ? javaMask(view) : undefined);
      if (gen !== this.generation || view.state.doc !== text || !view.dom.isConnected) return;
      this.show(place(text, markers));
    } catch (e) {
      console.debug("[mybatis] mapper markers", e);
    }
  }

  destroy() {
    this.refresh.cancel();
    this.offCleared();
    this.offSettings();
    this.generation++;
  }
}

/** Opens the single target, or the chooser over several. */
export async function openMapperTargets(marker: MapperMarker, anchor: { x: number; y: number }) {
  if (marker.targets.length === 1) {
    await navigateTo(marker.targets[0]!);
    return;
  }
  openPopup({
    kind: "list",
    anchor,
    title: marker.chooserTitle,
    items: await locationItems(marker.targets),
    pin: pinToFind(marker.name, marker.targets),
  });
}

/** The marker whose icon was clicked: several can share a line. */
function markerAt(view: EditorView, lineFrom: number, el: Element | null): MapperMarker | null {
  const onLine = view.state.field(markersField).filter((m) => m.pos === lineFrom);
  const name = (el?.closest(`.${styles.marker}`) as HTMLElement | null)?.dataset.name;
  return (onLine.find((m) => m.marker.name === name) ?? (onLine.length === 1 ? onLine[0] : null))?.marker ?? null;
}

export function mybatisGutter(ctx: EditorDocContext): Extension {
  if (ctx.doc < 0) return [];
  return [
    markersField,
    ViewPlugin.fromClass(MarkersPlugin),
    gutter({
      class: `${styles.gutter} cm-openidea-gutter-mybatis`,
      markers: (view) => markerSet(view.state.field(markersField)),
      domEventHandlers: {
        mousedown: (view, block, event) => {
          const e = event as MouseEvent;
          if (e.button !== 0) return false;
          const target = e.target instanceof Element ? e.target : null;
          const marker = markerAt(view, block.from, target);
          if (!marker) return false;
          e.preventDefault();
          const rect = (target?.closest(`.${styles.marker}`) ?? target)?.getBoundingClientRect();
          void openMapperTargets(marker, rect ? { x: rect.left, y: rect.bottom + 2 } : { x: e.clientX, y: e.clientY });
          return true;
        },
      },
    }),
  ];
}
