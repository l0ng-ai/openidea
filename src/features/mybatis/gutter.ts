/**
 * MyBatis gutter icons: on Java mapper methods (jump to the XML statement or
 * the SQL annotation) and on mapper.xml statements and the namespace line
 * (jump to the interface method / interface). Markers compute in two phases:
 * a synchronous pass over the live document (Java parse / XML scan), then the
 * project index answers for the counterpart; stale results are dropped by a
 * generation counter. Both sides follow the generic Gutter Icons setting
 * group (`mybatis`), hidden by the shared CSS rule.
 */
import { RangeSet, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, type ViewUpdate } from "@codemirror/view";
import { editorsFor, type EditorDocContext } from "@/editor/api";
import { debounce, docOf } from "@/editor/lsp/lsp";
import { locationItems, navigateTo } from "@/editor/lsp/navigation";
import { openPopup } from "@/editor/lsp/popupStore";
import { editorPrefs } from "@/platform/editorSettings";
import { tx } from "@/platform/i18n";
import type { Location } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { gutterIconMarkup } from "@/ui";
import { parseMapperInterface, type MapperInterface } from "./javaParse";
import { parseMapperXml, type MapperXml } from "./xmlParse";
import { EMPTY_INDEX, ensureMapperIndex, javaInterfaceFor, type MapperIndex } from "./xmlIndex";
import styles from "./Mybatis.module.css";

export interface MybatisMarker {
  /** 0-based line of the marker. */
  line: number;
  tooltip: string;
  targets: Location[];
  chooserTitle: string;
}

function location(path: string, line: number, col: number): Location {
  return { path, range: { start: { line, col }, end: { line, col: col + 1 } } };
}

/** Java markers: SQL annotations (same file) and the XML statements from the index. */
export function javaMarkers(path: string, text: string, index: MapperIndex): MybatisMarker[] {
  const iface = parseMapperInterface(text);
  if (!iface) return [];
  const entries = index.xmls.get(iface.fqn) ?? [];
  const out: MybatisMarker[] = [];
  for (const m of iface.methods) {
    const targets: Location[] = [];
    let tooltip: string;
    if (m.sqlAnnotation) {
      targets.push(location(path, m.annotationLine, 0));
      tooltip = tx("Jump to SQL annotation");
    } else {
      for (const e of entries)
        for (const s of e.statements.get(m.name) ?? []) targets.push(location(e.path, s.line, s.col));
      if (!targets.length) continue;
      tooltip = tx("Jump to MyBatis statement");
    }
    out.push({ line: m.line, tooltip, targets, chooserTitle: tx("Choose MyBatis Statement") });
  }
  return out;
}

/** XML markers: statements with a matching interface method, and the namespace line. */
export function xmlMarkers(xml: MapperXml, counterpart: { path: string; iface: MapperInterface }): MybatisMarker[] {
  if (!xml.namespace) return [];
  const out: MybatisMarker[] = [];
  if (xml.line >= 0)
    out.push({
      line: xml.line,
      tooltip: tx("Jump to mapper interface"),
      targets: [location(counterpart.path, counterpart.iface.line, 3)],
      chooserTitle: "",
    });
  const byId = new Map(counterpart.iface.methods.map((m) => [m.name, m]));
  for (const s of xml.statements) {
    const m = byId.get(s.id);
    if (!m) continue;
    out.push({
      line: s.line,
      tooltip: tx("Jump to mapper method"),
      targets: [location(counterpart.path, m.line, m.col)],
      chooserTitle: "",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// CodeMirror

interface Placed {
  marker: MybatisMarker;
  pos: number;
}

const setMarkers = StateEffect.define<Placed[]>();

const markersField = StateField.define<Placed[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setMarkers)) return e.value;
    if (!tr.docChanged || !value.length) return value;
    return value.map((p) => ({ ...p, pos: tr.state.doc.lineAt(tr.changes.mapPos(p.pos, -1)).from }));
  },
});

function place(doc: Text, markers: readonly MybatisMarker[]): Placed[] {
  return markers.filter((m) => m.line < doc.lines).map((m) => ({ marker: m, pos: doc.line(m.line + 1).from }));
}

const samePlaced = (a: readonly Placed[], b: readonly Placed[]) =>
  a.length === b.length && a.every((p, i) => p.pos === b[i]!.pos && p.marker.tooltip === b[i]!.marker.tooltip);

class Marker extends GutterMarker {
  constructor(readonly marker: MybatisMarker) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return (
      other instanceof Marker && other.marker.tooltip === this.marker.tooltip && other.marker.line === this.marker.line
    );
  }
  override toDOM(): Node {
    const el = document.createElement("div");
    el.className = `${styles.marker} cm-openidea-mybatis-marker`;
    el.title = this.marker.tooltip;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", this.marker.tooltip);
    el.innerHTML = gutterIconMarkup("gutter-mybatis") ?? "";
    return el;
  }
}

const markerSets = new WeakMap<readonly Placed[], RangeSet<GutterMarker>>();

function markerSet(placed: readonly Placed[]): RangeSet<GutterMarker> {
  let set = markerSets.get(placed);
  if (!set) {
    set = RangeSet.of(
      placed.map((p) => new Marker(p.marker).range(p.pos)),
      true,
    );
    markerSets.set(placed, set);
  }
  return set;
}

/** Live editor plugins re-run their pass when the project index changes (generation). */
const gutterRefreshers = new Set<() => void>();

export function refreshMybatisGutters(): void {
  for (const refresh of gutterRefreshers) refresh();
}

class MybatisPlugin {
  private generation = 0;
  private offSettings: () => void;
  /** Dispatches never run inside a view update (construction / doc change). */
  private refresh = debounce(() => void this.run(), 100);

  constructor(private view: EditorView) {
    this.offSettings = useProject.subscribe((s, prev) => {
      if (s.settings !== prev.settings) this.refresh();
    });
    gutterRefreshers.add(this.refresh);
    this.refresh();
  }

  update(u: ViewUpdate) {
    if (u.docChanged || u.focusChanged) this.refresh();
  }

  private show(markers: readonly MybatisMarker[]) {
    const placed = place(this.view.state.doc, markers);
    if (!samePlaced(this.view.state.field(markersField), placed))
      this.view.dispatch({ effects: setMarkers.of(placed) });
  }

  private async run() {
    const view = this.view;
    if (!view.dom.isConnected) return;
    const ctx = docOf(view);
    if (!ctx) return;
    const prefs = editorPrefs();
    if (!prefs.showGutterIcons || prefs.gutterIconsDisabled.includes("mybatis")) {
      this.show([]);
      return;
    }
    const gen = ++this.generation;
    const text = view.state.doc.toString();
    const stale = () => gen !== this.generation || view.state.doc.toString() !== text;
    const root = useProject.getState().project?.root ?? null;
    // shortcut: skip very large files; a mapper never gets that big.
    if (text.length > 1_000_000) {
      this.show([]);
      return;
    }

    if (ctx.language === "java") {
      const iface = parseMapperInterface(text);
      if (!iface) {
        this.show([]);
        return;
      }
      const signals = iface.hasMapperAnnotation || iface.methods.some((m) => m.sqlAnnotation);
      this.show(javaMarkers(ctx.path, text, EMPTY_INDEX));
      if (signals || iface.kind === "interface") {
        const index = await ensureMapperIndex(root);
        if (stale()) return;
        this.show(javaMarkers(ctx.path, text, index));
      }
      return;
    }

    if (ctx.language === "xml") {
      const xml = parseMapperXml(text);
      if (!xml.namespace) {
        this.show([]);
        return;
      }
      this.show([]);
      const counterpart = await javaInterfaceFor(xml.namespace);
      if (stale() || !counterpart) return;
      // Prefer the live document when the interface is open (dirty positions).
      let iface = counterpart.iface;
      const open = editorsFor(counterpart.path)[0];
      if (open) {
        const live = parseMapperInterface(open.view.state.doc.toString());
        if (live && live.fqn === xml.namespace) iface = live;
      }
      this.show(xmlMarkers(xml, { path: counterpart.path, iface }));
      return;
    }

    this.show([]);
  }

  destroy() {
    this.refresh.cancel();
    gutterRefreshers.delete(this.refresh);
    this.generation++;
    this.offSettings();
  }
}

async function openMarkerTargets(marker: MybatisMarker, x: number, y: number) {
  if (marker.targets.length === 1) {
    await navigateTo(marker.targets[0]!);
    return;
  }
  openPopup({ kind: "list", anchor: { x, y }, title: marker.chooserTitle, items: await locationItems(marker.targets) });
}

function markerAt(view: EditorView, lineFrom: number): MybatisMarker | null {
  return view.state.field(markersField).find((m) => m.pos === lineFrom)?.marker ?? null;
}

/** The gutter extension (the ⌥↵ facet is added by the feature's contribution). */
export function mybatisExtensions(ctx: EditorDocContext): Extension[] {
  if (ctx.language !== "java" && ctx.language !== "xml") return [];
  return [
    markersField,
    ViewPlugin.fromClass(MybatisPlugin),
    gutter({
      class: `${styles.gutter} cm-openidea-gutter-mybatis`,
      markers: (view) => markerSet(view.state.field(markersField)),
      domEventHandlers: {
        mousedown: (view, block, event) => {
          const e = event as MouseEvent;
          if (e.button !== 0) return false;
          const marker = markerAt(view, block.from);
          if (!marker) return false;
          e.preventDefault();
          const target = e.target instanceof Element ? e.target : null;
          const rect = (target?.closest(`.${styles.marker}`) ?? target)?.getBoundingClientRect();
          void openMarkerTargets(marker, rect ? rect.left : e.clientX, rect ? rect.bottom + 2 : e.clientY);
          return true;
        },
      },
    }),
  ];
}
