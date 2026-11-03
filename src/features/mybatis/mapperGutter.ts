/**
 * Editor wiring for MyBatis mappers: the gutter icons that jump between the two
 * halves of a mapper, and the context actions that generate what a method is
 * missing.
 *
 * Clicking an icon goes to the bound statement, or to the method it is bound to,
 * and several targets open the usual chooser. The generate actions offer the XML
 * statement of a method that has none, and the `@Param` annotations a
 * multi-parameter method is missing.
 *
 * The document being edited is parsed here (its own text, masked by the IDE's
 * grammar for Java); the other half is read from the project through
 * `mapperStore`, so an XML file that is not open still lights up its methods.
 * Both are recomputed a beat after each edit and whenever the index learns about
 * a changed file. Turning the icons off — Settings › Editor › General › Gutter
 * Icons › MyBatis mapper declarations, or the master switch — hides the gutter
 * column and leaves the context actions alone, which is what the other gutter
 * icon groups do.
 */
import { RangeSet, StateEffect, StateField, type Extension, type Text, type Transaction } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, type ViewUpdate } from "@codemirror/view";
import { intentionProviders, type ContributedIntention, type EditorDocContext } from "@/editor/api";
import { debounce, docOf } from "@/editor/lsp/lsp";
import { locationItems, navigateTo, pinToFind } from "@/editor/lsp/navigation";
import { openPopup } from "@/editor/lsp/popupStore";
import { tx } from "@/platform/i18n";
import { gutterIconMarkup } from "@/ui";
import { parseJavaMapper } from "./java";
import { parseMapperXml } from "./xml";
import { javaMask, type MaskSource } from "./mask";
import { generations, type Generation } from "./generate";
import { generateParams, generateStatement } from "./generateActions";
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

/** What the open mapper can be shown (icons) and offered (context actions). */
export async function mapperAnalysis(
  side: "java" | "xml",
  text: string,
  mask?: MaskSource,
): Promise<{ markers: MapperMarker[]; generations: Generation[] }> {
  if (side === "java") {
    const mapper = parseJavaMapper(text, mask);
    if (!mapper?.isInterface) return { markers: [], generations: [] };
    const xml = await mapperXmlFor(mapper.qualifiedName);
    return { markers: javaMarkers(mapper, xml), generations: generations(mapper, xml) };
  }
  const xml = parseMapperXml(text);
  const markers = xml?.namespace ? xmlMarkers(xml, await mapperInterfaceFor(xml.namespace)) : [];
  return { markers, generations: [] };
}

// ---------------------------------------------------------------------------
// CodeMirror

/** A line-based record, anchored at its line start in the current document. */
interface Placed<T> {
  item: T;
  pos: number;
}

function place<T extends { line: number }>(doc: Text, items: readonly T[]): Placed<T>[] {
  return items.filter((i) => i.line < doc.lines).map((item) => ({ item, pos: doc.line(item.line + 1).from }));
}

function remap<T>(value: Placed<T>[], tr: Transaction): Placed<T>[] {
  if (!tr.docChanged || !value.length) return value;
  return value.map((m) => ({ ...m, pos: tr.state.doc.lineAt(tr.changes.mapPos(m.pos, -1)).from }));
}

const samePlaced = <T>(a: readonly Placed<T>[], b: readonly Placed<T>[], same: (x: T, y: T) => boolean) =>
  a.length === b.length && a.every((m, i) => m.pos === b[i]!.pos && same(m.item, b[i]!.item));

const setMarkers = StateEffect.define<Placed<MapperMarker>[]>();

const markersField = StateField.define<Placed<MapperMarker>[]>({
  create: () => [],
  update: (value, tr) => {
    for (const e of tr.effects) if (e.is(setMarkers)) return e.value;
    return remap(value, tr);
  },
});

const setGenerations = StateEffect.define<Placed<Generation>[]>();

const generationsField = StateField.define<Placed<Generation>[]>({
  create: () => [],
  update: (value, tr) => {
    for (const e of tr.effects) if (e.is(setGenerations)) return e.value;
    return remap(value, tr);
  },
});

const sameMarker = (a: MapperMarker, b: MapperMarker) => a.name === b.name && a.tooltip === b.tooltip;

const sameGeneration = (a: Generation, b: Generation) =>
  a.name === b.name && a.statement === b.statement && a.params === b.params;

class MapperGutterMarker extends GutterMarker {
  constructor(readonly marker: MapperMarker) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return other instanceof MapperGutterMarker && sameMarker(other.marker, this.marker);
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

const gutterMarkers = new WeakMap<readonly Placed<MapperMarker>[], RangeSet<GutterMarker>>();

function markerSet(placed: readonly Placed<MapperMarker>[]): RangeSet<GutterMarker> {
  let set = gutterMarkers.get(placed);
  if (!set) {
    set = RangeSet.of(
      placed.map((m) => new MapperGutterMarker(m.item).range(m.pos)),
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

  constructor(private view: EditorView) {
    this.refresh();
    // The other half may have been created, renamed or deleted meanwhile.
    this.offCleared = onMapperIndexCleared(() => this.refresh());
  }

  update(u: ViewUpdate) {
    if (u.docChanged) this.refresh();
  }

  private show(markers: Placed<MapperMarker>[], offers: Placed<Generation>[]) {
    const state = this.view.state;
    const effects: StateEffect<unknown>[] = [];
    if (!samePlaced(state.field(markersField), markers, sameMarker)) effects.push(setMarkers.of(markers));
    if (!samePlaced(state.field(generationsField), offers, sameGeneration)) effects.push(setGenerations.of(offers));
    if (effects.length) this.view.dispatch({ effects });
  }

  private async run() {
    const view = this.view;
    if (!view.dom.isConnected) return;
    const ctx = docOf(view);
    const side = ctx && sideOf(ctx);
    if (!ctx || !side) return;
    const text = view.state.doc;
    const gen = ++this.generation;
    try {
      const found = await mapperAnalysis(side, text.toString(), side === "java" ? javaMask(view.state) : undefined);
      if (gen !== this.generation || view.state.doc !== text || !view.dom.isConnected) return;
      this.show(place(text, found.markers), place(text, found.generations));
    } catch (e) {
      console.debug("[mybatis] mapper markers", e);
    }
  }

  destroy() {
    this.refresh.cancel();
    this.offCleared();
    this.generation++;
  }
}

/** Opens the single target, or the chooser over several. */
async function openMapperTargets(marker: MapperMarker, anchor: { x: number; y: number }) {
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
  return (onLine.find((m) => m.item.name === name) ?? (onLine.length === 1 ? onLine[0] : null))?.item ?? null;
}

/** The offers of the line the caret is on. */
function generationAt(view: EditorView): Generation | null {
  const at = view.state.doc.lineAt(view.state.selection.main.head).from;
  return view.state.field(generationsField).find((g) => g.pos === at)?.item ?? null;
}

function intentions(ctx: EditorDocContext, view: EditorView): ContributedIntention[] {
  const offer = generationAt(view);
  if (!offer) return [];
  const out: ContributedIntention[] = [];
  if (offer.statement)
    out.push({
      id: "mybatis.generateStatement",
      label: tx`Generate Statement for ${offer.name}`,
      icon: MARKER_ICON,
      run: () => generateStatement(view, ctx.path, offer.name),
    });
  if (offer.params)
    out.push({
      id: "mybatis.generateParams",
      label: tx("Generate @Param Annotations"),
      icon: MARKER_ICON,
      run: () => generateParams(view, ctx.path, offer.name),
    });
  return out;
}

export function mybatisEditor(ctx: EditorDocContext): Extension {
  if (ctx.doc < 0) return [];
  return [
    markersField,
    generationsField,
    ViewPlugin.fromClass(MarkersPlugin),
    intentionProviders.of((view) => (ctx.language === "java" ? intentions(ctx, view) : [])),
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
