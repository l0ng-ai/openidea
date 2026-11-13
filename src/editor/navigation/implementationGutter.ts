/**
 * Gutter icons for inheritance: "is implemented / overridden" (↓) on types and
 * methods with implementations or overriders, "implements / overrides" (↑) on
 * methods with a super method. Clicking one navigates to its single target or
 * opens the targets chooser.
 *
 * Generic over language servers: ↓ comes from implementation requests (one
 * cancellable batch per pass), ↑ from the type hierarchy and the supertypes'
 * document symbols (as Super Method, ⌘U). One debounced pass after edits /
 * scrolling asks the declarations in and near the viewport first, then the rest
 * of the file in batches; results are cached per document text, and markers
 * follow their lines in between.
 * The cache outlives the editor view (switching tabs remounts it) until other
 * files change or a language server settles: on some servers (jdtls) every
 * implementation search walks the whole workspace, so asking again is costly.
 */
import { RangeSet, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, type ViewUpdate } from "@codemirror/view";
import { shownAgain, type EditorDocContext } from "@/editor/api";
import { docOf, debounce, isUnavailable, lspRequest } from "@/editor/lsp/lsp";
import { featureBackoff, onServerSettled } from "@/editor/lsp/availability";
import { readManyFileLines, withDocument } from "@/editor/lsp/files";
import { locationItems, navigateTo, pinToFind } from "@/editor/lsp/navigation";
import { openPopup } from "@/editor/lsp/popupStore";
import {
  commands,
  isCancelled,
  nextRequestId,
  onIdeEvent,
  type HierarchyItem,
  type Location,
  type OutlineItem,
  type Pos,
  type RequestId,
} from "@/platform/ipc";
import { editorPrefs, type EditorExtras } from "@/platform/editorSettings";
import { useProject } from "@/platform/project";
import { gutterIconMarkup } from "@/ui";
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
import { overridersInType, superMethodTargets, type SuperDeps, type SuperMethod } from "./structureNav";
import styles from "./LineMarkers.module.css";

/** Lines above / below the viewport that are asked with it. */
const MARGIN_LINES = 60;
const BATCH_SIZE = 60;
const DEBOUNCE_MS = 500;
const gutterBackoff = featureBackoff();
const MAX_CACHED_DOCS = 32;

interface DocMarkers {
  doc: Text;
  cache: MarkerCache;
  outline: { items: OutlineItem[]; candidates: MarkerCandidate[] } | null;
  /** `changes` when the cache was started. */
  changes: number;
}

/** Marker caches by path, most recently used last. */
const docMarkers = new Map<string, DocMarkers>();
/**
 * Bumped when other files may have changed (edited in an editor; saved, created or removed
 * on disk): every document's cached answers may be stale then.
 */
let changes = 0;
const live = new Set<MarkersPlugin>();
let watching = false;

/** Build output and tool folders: their changes add no implementations. */
const OUTPUT_PATH =
  /(?:^|[\\/])(?:\.git|\.gradle|\.idea|\.openidea|node_modules|target|build|out|bin)(?:[\\/]|$)|\.class$/;

/** Whether changes to `paths` can invalidate cached markers. */
export function affectsMarkers(paths: readonly string[]): boolean {
  return paths.some((p) => !OUTPUT_PATH.test(p));
}

/** Subscribes once per window and stays subscribed, so the settle echo guard survives remounts. */
function watchChanges() {
  if (watching) return;
  watching = true;
  onIdeEvent("fsChanged", (e) => {
    if (affectsMarkers([...e.created, ...e.modified, ...e.removed])) changes++;
  });
  // Answers (outlines too) given while a server was starting or indexing may be incomplete.
  onServerSettled(() => {
    docMarkers.clear();
    for (const plugin of live) plugin.refreshSoon();
  });
}

/** The cache for `doc` at `path`: kept while its text and other files are unchanged. */
export function markersOf(path: string, doc: Text): DocMarkers {
  let entry = docMarkers.get(path);
  if (!entry || entry.doc !== doc) entry = { doc, cache: emptyCache(), outline: null, changes };
  else if (entry.changes !== changes) entry = { ...entry, cache: emptyCache(), changes };
  docMarkers.delete(path);
  docMarkers.set(path, entry);
  if (docMarkers.size > MAX_CACHED_DOCS) docMarkers.delete(docMarkers.keys().next().value!);
  return entry;
}

function markersStale(path: string, doc: Text): boolean {
  const entry = docMarkers.get(path);
  return !entry || entry.doc !== doc || entry.changes !== changes;
}

/** Records that other files may have changed (tests). */
export function noteOtherChanges() {
  changes++;
}

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
  const known = down.length ? await fromHierarchy(path, down, deps.supers) : new Map<MarkerCandidate, Location[]>();
  if (down.length) {
    const ask = down.filter((c) => !known.has(c));
    let asked: Location[][] = [];
    if (ask.length) {
      try {
        asked = await deps.implementations(ask.map((c) => ({ line: c.line, col: c.col })));
      } catch (e) {
        if (isCancelled(e)) throw e;
        if (isUnavailable(e)) cache.unsupported.add("inheritors");
        for (let i = down.length - 1; i >= 0; i--) if (!known.has(down[i]!)) down.splice(i, 1);
      }
    }
    implementations = down.map((c) => withoutSelf(path, c, known.get(c) ?? asked[ask.indexOf(c)] ?? []));
  }
  // Some servers (Pyrefly) answer implementation requests with nothing while their
  // type hierarchy still knows the subtypes: use it for the ↓ markers of types.
  const subtypes = deps.supers.subtypes;
  if (subtypes) {
    await Promise.all(
      down.map(async (c, i) => {
        if (c.method || known.has(c) || (implementations[i]?.length ?? 0)) return;
        try {
          const found = await subtypes(path, { line: c.line, col: c.col });
          implementations[i] = found.map((s) => ({ path: s.path, range: s.selectionRange }));
        } catch (e) {
          if (isCancelled(e)) throw e;
        }
      }),
    );
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

/**
 * Overriders of a type's methods from one walk of its subtypes and their outlines, instead of one
 * implementation request per method: jdtls builds the type hierarchy again for every implementation
 * request, so a large interface kept it busy long enough to hold up navigation. Only for servers
 * whose outline names carry the signature (`save(T, int)`), and only while the walk takes fewer
 * requests than it replaces. A method whose name a subtype reuses with another signature
 * (`save(Order)` for a generic `save(T)`) is left to its implementation request. The type's own
 * marker lists the subtypes found.
 */
async function fromHierarchy(
  path: string,
  down: readonly MarkerCandidate[],
  supers: SuperDeps,
): Promise<Map<MarkerCandidate, Location[]>> {
  const known = new Map<MarkerCandidate, Location[]>();
  if (!supers.subtypes) return known;
  const byOwner = new Map<string, MarkerCandidate[]>();
  for (const c of down) {
    if (!c.method || !c.owner || !c.symbol.includes("(")) continue;
    const key = `${c.owner.line}:${c.owner.col}`;
    byOwner.set(key, [...(byOwner.get(key) ?? []), c]);
  }
  for (const methods of byOwner.values()) {
    if (methods.length < 2) continue;
    const owner = methods[0]!.owner!;
    const subtypes = await allSubtypes(path, owner, supers, methods.length - 1);
    if (!subtypes) continue;
    const type = down.find((c) => !c.method && c.line === owner.line && c.col === owner.col);
    if (type)
      known.set(
        type,
        subtypes.map((s) => ({ path: s.path, range: s.selectionRange })),
      );
    for (const m of methods) {
      const targets: Location[] = [];
      let unsure = false;
      for (const s of subtypes) {
        const outline = await supers.outline(s.path).catch((e) => {
          if (isCancelled(e)) throw e;
          return null;
        });
        const found = outline && overridersInType(outline, s, m.symbol);
        if (!found) {
          unsure = true;
          break;
        }
        for (const o of found) targets.push({ path: s.path, range: o.selection_range });
      }
      if (!unsure) known.set(m, targets);
    }
  }
  return known;
}

/** Every subtype of the type at `pos`, or null when the walk would take more than `budget` requests or fails. */
async function allSubtypes(path: string, pos: Pos, supers: SuperDeps, budget: number): Promise<HierarchyItem[] | null> {
  const all: HierarchyItem[] = [];
  const seen = new Set<string>();
  let level = [{ path, pos }];
  let asked = 0;
  while (level.length) {
    const next: Array<{ path: string; pos: Pos }> = [];
    for (const t of level) {
      if (++asked > budget) return null;
      let found: HierarchyItem[];
      try {
        found = await supers.subtypes!(t.path, t.pos);
      } catch (e) {
        if (isCancelled(e)) throw e;
        return null;
      }
      for (const s of found) {
        const key = `${s.path}:${s.selectionRange.start.line}:${s.selectionRange.start.col}`;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(s);
        next.push({ path: s.path, pos: s.selectionRange.start });
      }
    }
    level = next;
  }
  return all;
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
    el.innerHTML = gutterIconMarkup(MARKER_ICONS[this.marker.kind]) ?? "";
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

/**
 * The declarations one pass asks about, in batches: those in and near the viewport first, then the
 * rest of the file nearest first, so markers are ready before scrolling to them.
 */
export function markerBatches(
  candidates: readonly MarkerCandidate[],
  firstVisible: number,
  lastVisible: number,
): MarkerCandidate[][] {
  const first = firstVisible - MARGIN_LINES;
  const last = lastVisible + MARGIN_LINES;
  const distance = (c: MarkerCandidate) => (c.line < first ? first - c.line : c.line > last ? c.line - last : 0);
  const ordered = [...candidates].sort((a, b) => distance(a) - distance(b));
  const batches: MarkerCandidate[][] = [];
  for (let i = 0; i < ordered.length; i += BATCH_SIZE) batches.push(ordered.slice(i, i + BATCH_SIZE));
  return batches;
}

class MarkersPlugin {
  private refresh = debounce(() => void this.run(), DEBOUNCE_MS);
  private generation = 0;
  private skipped = false;
  private request: RequestId | null = null;
  private offSettings: () => void;

  constructor(private view: EditorView) {
    live.add(this);
    watchChanges();
    this.refresh();
    this.offSettings = useProject.subscribe((s, prev) => {
      if (s.settings !== prev.settings) this.refresh();
    });
  }

  refreshSoon() {
    this.refresh();
  }

  update(u: ViewUpdate) {
    if (u.docChanged) {
      // Other documents' markers may depend on this one.
      changes++;
      this.refresh();
    } else if (u.viewportChanged || (this.skipped && shownAgain(u))) this.refresh();
    // Other files may have changed meanwhile (a new implementation).
    else if (u.focusChanged && u.view.hasFocus) {
      const ctx = docOf(u.view);
      if (ctx && markersStale(ctx.path, u.view.state.doc)) this.refresh();
    }
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
    this.skipped = !view.dom.isConnected;
    if (this.skipped) return;
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
    const entry = markersOf(ctx.path, text);
    try {
      if (!entry.outline) {
        const items = await lspRequest(() => commands.docOutline(ctx.doc));
        if (stale()) return;
        entry.outline = {
          items,
          candidates: markerCandidates(items, (l) => (l < text.lines ? text.line(l + 1).text : "")),
        };
      }
      const { candidates, items } = entry.outline;
      const { from, to } = view.viewport;
      const batches = markerBatches(candidates, text.lineAt(from).number - 1, text.lineAt(to).number - 1);
      for (const batch of batches) {
        const request = (this.request = nextRequestId());
        await fillMarkers(ctx.path, batch, groups, markerDeps(ctx, items, request, entry.cache), entry.cache);
        if (this.request === request) this.request = null;
        if (stale()) return;
        this.show(place(text, cachedMarkers(candidates, groups, entry.cache)));
        // Hidden meanwhile (tab switch): resume when shown again.
        if ((this.skipped = !view.dom.isConnected)) return;
      }
    } catch (e) {
      if (isUnavailable(e)) gutterBackoff.mark(ctx.doc);
      else if (!isCancelled(e)) console.debug("[lineMarkers]", e);
    }
  }

  destroy() {
    this.refresh.cancel();
    this.cancelRequest();
    this.offSettings();
    this.generation++;
    live.delete(this);
  }
}

/** LSP access for one pass: this document's outline as known, others' opened on demand, each asked once. */
function markerDeps(ctx: EditorDocContext, items: OutlineItem[], request: RequestId, cache: MarkerCache): MarkerDeps {
  const supertypes = new Map<string, Promise<HierarchyItem[]>>();
  const subtypes = new Map<string, Promise<HierarchyItem[]>>();
  const outlines = new Map<string, Promise<OutlineItem[]>>([[ctx.path, Promise.resolve(items)]]);
  const hierarchy = (doc: number, pos: Pos, direction: "incoming" | "outgoing") =>
    lspRequest(() => commands.lspTypeHierarchy(doc, pos, direction));
  return {
    implementations: (positions) => lspRequest(() => commands.lspImplementations(request, ctx.doc, positions)),
    supers: {
      supertypes: (path, pos) => {
        const key = `${path}:${pos.line}:${pos.col}`;
        let p = supertypes.get(key);
        if (!p) {
          p =
            path === ctx.path
              ? hierarchy(ctx.doc, pos, "incoming").catch((e) => {
                  // No type hierarchy for this file: no ↑ markers until the server changes.
                  if (isUnavailable(e)) cache.unsupported.add("supers");
                  throw e;
                })
              : withDocument(path, (doc) => hierarchy(doc, pos, "incoming"));
          supertypes.set(key, p);
        }
        return p;
      },
      subtypes: (path, pos) => {
        const key = `${path}:${pos.line}:${pos.col}`;
        let p = subtypes.get(key);
        if (!p) {
          p =
            path === ctx.path
              ? hierarchy(ctx.doc, pos, "outgoing")
              : withDocument(path, (doc) => hierarchy(doc, pos, "outgoing"));
          subtypes.set(key, p);
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
