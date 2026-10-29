/**
 * Gutter icons for inheritance: "is implemented / overridden" (↓) on types and
 * methods with implementations or overriders, "implements / overrides" (↑) on
 * methods with a super method. Clicking one navigates to its single target or
 * opens the targets chooser.
 *
 * Generic over language servers: ↓ comes from implementation requests (one
 * cancellable batch per pass), ↑ from the type hierarchy and the supertypes'
 * document symbols (as Super Method, ⌘U). Only declarations in and near the
 * viewport are asked, in one debounced pass after edits / scrolling; results
 * are cached per document text, and markers follow their lines in between.
 */
import { RangeSet, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, type ViewUpdate } from "@codemirror/view";
import type { EditorDocContext } from "@/editor/api";
import { docOf, debounce, isUnavailable, lspRequest } from "@/editor/lsp/lsp";
import { featureBackoff, onServerSettled } from "@/editor/lsp/availability";
import { readManyFileLines, withDocument } from "@/editor/lsp/files";
import { locationItems, navigateTo, pinToFind } from "@/editor/lsp/navigation";
import { openPopup } from "@/editor/lsp/popupStore";
import {
  commands,
  isCancelled,
  nextRequestId,
  type HierarchyItem,
  type Location,
  type OutlineItem,
  type Pos,
  type RequestId,
} from "@/platform/ipc";
import { editorPrefs, type EditorExtras } from "@/platform/editorSettings";
import { useProject } from "@/platform/project";
import { iconMarkup } from "@/ui";
import {
  MARKER_ICONS,
  candidateKey,
  inheritorsMarker,
  markerCandidates,
  supersMarker,
  withoutSelf,
  type LineMarker,
  type MarkerCandidate,
  type MarkerGroup,
} from "./lineMarkers";
import { superMethodTargets, type SuperDeps, type SuperMethod } from "./structureNav";
import styles from "./LineMarkers.module.css";

/** Lines above / below the viewport that are covered too, so scrolling feels instant. */
const MARGIN_LINES = 60;
const MAX_PER_PASS = 60;
const DEBOUNCE_MS = 500;
const gutterBackoff = featureBackoff();

/** Settings › Editor › General › Gutter Icons groups that are on. */
export function enabledGroups(prefs: Pick<EditorExtras, "showGutterIcons" | "gutterIconsDisabled">): Set<MarkerGroup> {
  if (!prefs.showGutterIcons) return new Set();
  return new Set((["inheritors", "supers"] as const).filter((g) => !prefs.gutterIconsDisabled.includes(g)));
}

export interface MarkerDeps {
  /** Implementations of the symbols at `positions`, one list each (rejects when the server cannot answer). */
  implementations: (positions: Pos[]) => Promise<Location[][]>;
  supers: SuperDeps;
  readFiles: (paths: readonly string[]) => Promise<Map<string, string[] | null>>;
}

interface CacheEntry {
  inheritors?: LineMarker | null;
  supers?: LineMarker | null;
}

/** Results for one document text; `unsupported` remembers a server that cannot answer a group. */
export interface MarkerCache {
  entries: Map<string, CacheEntry>;
  unsupported: Set<MarkerGroup>;
}

export const emptyCache = (): MarkerCache => ({ entries: new Map(), unsupported: new Set() });

/**
 * Asks the server about the `candidates` not in `cache` yet (only the enabled
 * `groups`) and stores the answers. Cancellation propagates; an unavailable
 * server marks its group unsupported for this cache.
 */
export async function fillMarkers(
  path: string,
  candidates: readonly MarkerCandidate[],
  groups: ReadonlySet<MarkerGroup>,
  deps: MarkerDeps,
  cache: MarkerCache,
): Promise<void> {
  const entry = (c: MarkerCandidate) => {
    const key = candidateKey(c);
    let e = cache.entries.get(key);
    if (!e) cache.entries.set(key, (e = {}));
    return e;
  };
  const down =
    groups.has("inheritors") && !cache.unsupported.has("inheritors")
      ? candidates.filter((c) => c.inheritable && cache.entries.get(candidateKey(c))?.inheritors === undefined)
      : [];
  const up =
    groups.has("supers") && !cache.unsupported.has("supers")
      ? candidates.filter((c) => c.overriding && c.owner && cache.entries.get(candidateKey(c))?.supers === undefined)
      : [];

  let implementations: Location[][] = [];
  if (down.length) {
    try {
      implementations = (await deps.implementations(down.map((c) => ({ line: c.line, col: c.col })))).map((locs, i) =>
        withoutSelf(path, down[i]!, locs),
      );
    } catch (e) {
      if (isCancelled(e)) throw e;
      if (isUnavailable(e)) cache.unsupported.add("inheritors");
      down.length = 0;
    }
  }
  const supers: SuperMethod[][] = [];
  for (const c of up) supers.push(await superMethodTargets(path, c.owner!, c.symbol, deps.supers));

  const files = await deps.readFiles([
    ...implementations.flat().map((l) => l.path),
    ...supers.flat().map((s) => s.location.path),
  ]);
  down.forEach((c, i) => (entry(c).inheritors = inheritorsMarker(c, implementations[i] ?? [], files)));
  up.forEach((c, i) => (entry(c).supers = supersMarker(c, supers[i]!, files)));
}

/** Markers known for `candidates`, in document order (↓ before ↑ on a line). */
export function cachedMarkers(
  candidates: readonly MarkerCandidate[],
  groups: ReadonlySet<MarkerGroup>,
  cache: MarkerCache,
): LineMarker[] {
  const out: LineMarker[] = [];
  for (const c of candidates) {
    const e = cache.entries.get(candidateKey(c));
    if (!e) continue;
    if (groups.has("inheritors") && e.inheritors) out.push(e.inheritors);
    if (groups.has("supers") && e.supers) out.push(e.supers);
  }
  return out;
}

/** Opens the single target, or the chooser over several. */
export async function openMarkerTargets(marker: LineMarker, anchor: { x: number; y: number }) {
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

// ---------------------------------------------------------------------------
// CodeMirror

interface PlacedMarker {
  marker: LineMarker;
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

function place(doc: Text, markers: readonly LineMarker[]): PlacedMarker[] {
  return markers.filter((m) => m.line < doc.lines).map((marker) => ({ marker, pos: doc.line(marker.line + 1).from }));
}

const sameMarkers = (a: readonly PlacedMarker[], b: readonly PlacedMarker[]) =>
  a.length === b.length &&
  a.every(
    (m, i) => m.pos === b[i]!.pos && m.marker.kind === b[i]!.marker.kind && m.marker.tooltip === b[i]!.marker.tooltip,
  );

class InheritanceMarker extends GutterMarker {
  constructor(readonly marker: LineMarker) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return (
      other instanceof InheritanceMarker &&
      other.marker.kind === this.marker.kind &&
      other.marker.tooltip === this.marker.tooltip
    );
  }
  override toDOM(): Node {
    const el = document.createElement("div");
    el.className = `${styles.marker} cm-openidea-lineMarker-${this.marker.kind}`;
    el.dataset.kind = this.marker.kind;
    el.title = this.marker.tooltip;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", this.marker.tooltip);
    el.innerHTML = iconMarkup(MARKER_ICONS[this.marker.kind], 14) ?? "";
    return el;
  }
}

const gutterMarkers = new WeakMap<readonly PlacedMarker[], RangeSet<GutterMarker>>();

function markerSet(placed: readonly PlacedMarker[]): RangeSet<GutterMarker> {
  let set = gutterMarkers.get(placed);
  if (!set) {
    set = RangeSet.of(
      placed.map((m) => new InheritanceMarker(m.marker).range(m.pos)),
      true,
    );
    gutterMarkers.set(placed, set);
  }
  return set;
}

class MarkersPlugin {
  private refresh = debounce(() => void this.run(), DEBOUNCE_MS);
  private cache = emptyCache();
  private cacheDoc: Text | null = null;
  private outline: { doc: Text; items: OutlineItem[]; candidates: MarkerCandidate[] } | null = null;
  private generation = 0;
  private request: RequestId | null = null;
  private offSettings: () => void;
  private offServers: () => void;

  constructor(private view: EditorView) {
    this.refresh();
    this.offSettings = useProject.subscribe((s, prev) => {
      if (s.settings !== prev.settings) this.refresh();
    });
    // Answers given while a server was starting or indexing may be incomplete.
    this.offServers = onServerSettled(() => {
      this.invalidate();
      this.refresh();
    });
  }

  update(u: ViewUpdate) {
    if (u.docChanged || u.viewportChanged) this.refresh();
    // Other files may have changed meanwhile (a new implementation).
    else if (u.focusChanged && u.view.hasFocus) {
      this.invalidate();
      this.refresh();
    }
  }

  private invalidate() {
    this.cacheDoc = null;
    this.outline = null;
  }

  private cancelRequest() {
    if (this.request === null) return;
    void commands.cancelRequest(this.request).catch(() => {});
    this.request = null;
  }

  private show(placed: PlacedMarker[]) {
    if (!sameMarkers(this.view.state.field(markersField), placed))
      this.view.dispatch({ effects: setMarkers.of(placed) });
  }

  private async run() {
    const view = this.view;
    if (!view.dom.isConnected) return;
    const ctx = docOf(view);
    if (!ctx) return;
    const gen = ++this.generation;
    this.cancelRequest();
    const groups = enabledGroups(editorPrefs());
    if (!groups.size || gutterBackoff.active(ctx.doc)) {
      if (!groups.size) this.show([]);
      return;
    }
    const text = view.state.doc;
    const stale = () => gen !== this.generation || view.state.doc !== text;
    if (this.cacheDoc !== text) {
      this.cache = emptyCache();
      this.cacheDoc = text;
    }
    try {
      if (this.outline?.doc !== text) {
        const items = await lspRequest(() => commands.docOutline(ctx.doc));
        if (stale()) return;
        this.outline = {
          doc: text,
          items,
          candidates: markerCandidates(items, (l) => (l < text.lines ? text.line(l + 1).text : "")),
        };
      }
      const { candidates, items } = this.outline;
      const { from, to } = view.viewport;
      const first = text.lineAt(from).number - 1 - MARGIN_LINES;
      const last = text.lineAt(to).number - 1 + MARGIN_LINES;
      const visible = candidates.filter((c) => c.line >= first && c.line <= last).slice(0, MAX_PER_PASS);
      const request = (this.request = nextRequestId());
      await fillMarkers(ctx.path, visible, groups, markerDeps(ctx, items, request, this.cache), this.cache);
      if (this.request === request) this.request = null;
      if (stale()) return;
      this.show(place(text, cachedMarkers(candidates, groups, this.cache)));
    } catch (e) {
      if (isUnavailable(e)) gutterBackoff.mark(ctx.doc);
      else if (!isCancelled(e)) console.debug("[lineMarkers]", e);
    }
  }

  destroy() {
    this.refresh.cancel();
    this.cancelRequest();
    this.offSettings();
    this.offServers();
    this.generation++;
  }
}

/** LSP access for one pass: this document's outline as known, others' opened on demand, each asked once. */
function markerDeps(ctx: EditorDocContext, items: OutlineItem[], request: RequestId, cache: MarkerCache): MarkerDeps {
  const supertypes = new Map<string, Promise<HierarchyItem[]>>();
  const outlines = new Map<string, Promise<OutlineItem[]>>([[ctx.path, Promise.resolve(items)]]);
  const hierarchy = (doc: number, pos: Pos) => lspRequest(() => commands.lspTypeHierarchy(doc, pos, "incoming"));
  return {
    implementations: (positions) => lspRequest(() => commands.lspImplementations(request, ctx.doc, positions)),
    supers: {
      supertypes: (path, pos) => {
        const key = `${path}:${pos.line}:${pos.col}`;
        let p = supertypes.get(key);
        if (!p) {
          p =
            path === ctx.path
              ? hierarchy(ctx.doc, pos).catch((e) => {
                  // No type hierarchy for this file: no ↑ markers until the server changes.
                  if (isUnavailable(e)) cache.unsupported.add("supers");
                  throw e;
                })
              : withDocument(path, (doc) => hierarchy(doc, pos));
          supertypes.set(key, p);
        }
        return p;
      },
      outline: (path) => {
        let p = outlines.get(path);
        if (!p) outlines.set(path, (p = withDocument(path, (doc) => lspRequest(() => commands.docOutline(doc)))));
        return p;
      },
    },
    readFiles: readManyFileLines,
  };
}

function markerAt(view: EditorView, lineFrom: number, el: Element | null): LineMarker | null {
  const onLine = view.state.field(markersField).filter((m) => m.pos === lineFrom);
  const kind = (el?.closest(`.${styles.marker}`) as HTMLElement | null)?.dataset.kind;
  return (onLine.find((m) => m.marker.kind === kind) ?? (onLine.length === 1 ? onLine[0] : null))?.marker ?? null;
}

export function implementationGutter(ctx: EditorDocContext): Extension {
  if (ctx.doc < 0) return [];
  return [
    markersField,
    ViewPlugin.fromClass(MarkersPlugin),
    gutter({
      class: `${styles.gutter} cm-openidea-gutter-lineMarkers`,
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
          void openMarkerTargets(marker, rect ? { x: rect.left, y: rect.bottom + 2 } : { x: e.clientX, y: e.clientY });
          return true;
        },
      },
    }),
  ];
}
