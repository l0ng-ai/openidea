/** Find Usages (⌥F7 → "usages" tool window) and Show Usages (⌥⌘F7 → popup). */
import { create } from "zustand";
import { Channel } from "@tauri-apps/api/core";
import type { ClassifiedReference, ReferenceAccess, ReferenceKind, Location, References, RequestId } from "@/bindings";
import { clearLineTokens } from "@/editor/lineTokens";
import { showPendingHint } from "@/editor/lsp/hint";
import { incompleteNote } from "@/editor/lsp/lsp";
import { commands, IpcError, isCancelled, nextRequestId } from "@/platform/ipc";
import { shortcutLabel } from "@/platform/keymap";
import { synchronizeDocumentIndexes, toolWindowService } from "@/workbench/contributions";
import {
  caretContext,
  caretSynced,
  caretPoint,
  hint,
  lspRequest,
  openLocation,
  readManyFileLines,
  reportError,
  type CaretContext,
} from "./ipc";
import { syntaxUsages } from "./syntaxUsages";

export interface Usage {
  kind?: ReferenceKind;
  access?: ReferenceAccess | null;
  /** Exact semantic range, retained when the line preview is clamped. */
  sourceLocation?: Location;
  path: string;
  line: number;
  col: number;
  /** End column on `line` (clamped to the line for multi-line ranges). */
  endCol: number;
  /** The usage's line text (empty when the file couldn't be read). */
  text: string;
}

export interface UsageGroup {
  path: string;
  usages: Usage[];
}

/** Groups reference locations by file (sorted by path, then position), attaching line previews. */
export function groupUsages(
  locs: readonly Location[],
  files: ReadonlyMap<string, readonly string[] | null>,
  classified: readonly ClassifiedReference[] = [],
): UsageGroup[] {
  const kinds = new Map(classified.map((r) => [usageLocationKey(r.location), r]));
  const byPath = new Map<string, Usage[]>();
  const seen = new Set<string>();
  for (const l of locs) {
    const key = usageLocationKey(l);
    if (seen.has(key)) continue;
    seen.add(key);
    const text = files.get(l.path)?.[l.range.start.line] ?? kinds.get(key)?.text ?? "";
    const endCol = l.range.end.line === l.range.start.line ? l.range.end.col : Math.max(text.length, l.range.start.col);
    let list = byPath.get(l.path);
    if (!list) byPath.set(l.path, (list = []));
    list.push({
      ...(kinds.has(usageLocationKey(l))
        ? {
            kind: kinds.get(usageLocationKey(l))!.kind,
            access: kinds.get(usageLocationKey(l))!.access,
            sourceLocation: l,
          }
        : {}),
      path: l.path,
      line: l.range.start.line,
      col: l.range.start.col,
      endCol,
      text,
    });
  }
  return [...byPath.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, usages]) => ({ path, usages: usages.sort((a, b) => a.line - b.line || a.col - b.col) }));
}

export function usageCount(groups: readonly UsageGroup[]): number {
  return groups.reduce((n, g) => n + g.usages.length, 0);
}

/** Trims leading whitespace of a preview line, shifting the match range accordingly. */
export function trimPreview(u: Usage): { text: string; textCol: number; from: number; to: number } {
  const lead = u.text.length - u.text.trimStart().length;
  const text = u.text.trim();
  const from = Math.max(0, u.col - lead);
  const to = Math.max(from, Math.min(text.length, u.endCol - lead));
  return { text, textCol: lead, from, to };
}

/** Project Files, or Project and Libraries (Java's dependency jars and JDK too). */
export type UsageScope = "project" | "libraries";

/** The scope a search ran in, when there was a choice (`null` when the server has none). */
function searchedScope(libraries: boolean, librariesSkipped: boolean, widenable: boolean): UsageScope | null {
  if (librariesSkipped) return "project";
  return libraries && widenable ? "libraries" : null;
}

export interface UsageSearch {
  /** Identifies one search run (UI state such as expansion resets per run). */
  id: number;
  symbol: string | null;
  loading: boolean;
  groups: UsageGroup[];
  error: string | null;
  /** Results came from the syntax fallback: says so (e.g. "Text occurrences (language server not ready)"). */
  note: string | null;
  /** Re-runs the same query (rerun button). */
  rerun: (() => void) | null;
  /** Where it searched, when the server can search beyond Project Files (Java's jars and JDK). */
  scope?: UsageScope | null;
  /** Runs it again in Project and Libraries. */
  searchLibraries?: (() => void) | null;
  /** Kept when a new search runs (Pin Tab). */
  pinned?: boolean;
}

let searchSeq = 0;

/** One tab per search; as in IDEA a new search replaces the selected tab unless it is pinned. */
interface UsagesState {
  tabs: UsageSearch[];
  active: number | null;
}

export const useUsages = create<UsagesState>(() => ({ tabs: [], active: null }));

/** The selected tab's search. */
export const activeUsageSearch = (s: UsagesState): UsageSearch | null =>
  s.tabs.find((t) => t.id === s.active) ?? s.tabs.at(-1) ?? null;

const MAX_TABS = 8;

/** Shows `search` in a new tab, or in place of the selected one unless that is pinned. */
export function openUsageTab(search: UsageSearch) {
  useUsages.setState((s) => {
    const reused = s.tabs.find((t) => t.id === s.active && !t.pinned);
    const tabs = reused ? s.tabs.map((t) => (t === reused ? search : t)) : [...s.tabs, search];
    return { tabs: tabs.slice(-MAX_TABS), active: search.id };
  });
}

/** Replaces tab `id` (a rerun or a finished search), keeping its pin and selection. */
function replaceUsageTab(id: number, search: UsageSearch): boolean {
  const s = useUsages.getState();
  const old = s.tabs.find((t) => t.id === id);
  if (!old) return false;
  useUsages.setState({
    tabs: s.tabs.map((t) => (t === old ? { ...search, pinned: old.pinned } : t)),
    active: s.active === id ? search.id : s.active,
  });
  return true;
}

export function pinUsageTab(id: number, pinned: boolean) {
  useUsages.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, pinned } : t)) }));
}

export function closeUsageTab(id: number) {
  cancelSearch(id);
  useUsages.setState((s) => {
    const i = s.tabs.findIndex((t) => t.id === id);
    const tabs = s.tabs.filter((t) => t.id !== id);
    const active = s.active === id ? (tabs[Math.min(i, tabs.length - 1)]?.id ?? null) : s.active;
    return { tabs, active };
  });
}

/** Rerun of the selected tab (⌘R in the Find Usages tool window). */
export function rerunActiveUsages() {
  activeUsageSearch(useUsages.getState())?.rerun?.();
}

interface UsagesPopupState {
  open: boolean;
  anchor: { x: number; y: number };
  symbol: string | null;
  groups: UsageGroup[];
  note: string | null;
  /** Shows those found so far while the search goes on. */
  loading: boolean;
  /** Where it searched, when the server can search beyond Project Files. */
  scope: UsageScope | null;
}

export const useUsagesPopup = create<UsagesPopupState>(() => ({
  open: false,
  anchor: { x: 0, y: 0 },
  symbol: null,
  groups: [],
  note: null,
  loading: false,
  scope: null,
}));

interface FetchedUsages {
  groups: UsageGroup[];
  note: string | null;
  librariesSkipped: boolean;
}

/** Paths whose lines are read to show these usages: not those the server gave along. */
function pathsToRead(locs: readonly Location[], classified: readonly ClassifiedReference[]): string[] {
  const given = new Set(classified.filter((r) => r.text != null).map((r) => usageLocationKey(r.location)));
  return locs.filter((l) => !given.has(usageLocationKey(l))).map((l) => l.path);
}

/**
 * The server's references across the project (files outside its analysis scope
 * included); when it is not ready or fails, the syntax fallback (an empty server
 * answer is respected). Without a fallback the server error stands. Without
 * `libraries`, Java's dependencies and JDK are not searched (Project Files); with it,
 * those found in the sources go to `onPartial` before the slower search for the rest.
 * Cancel with `commands.cancelRequest(request)`.
 */
export async function fetchUsages(
  c: CaretContext,
  request: RequestId = nextRequestId(),
  onPartial?: (found: FetchedUsages) => void,
  libraries = false,
): Promise<FetchedUsages> {
  // Usage lines are read afresh: so are the files their syntax colours come from.
  clearLineTokens();
  const before = c.view?.state.doc;
  let locs: Location[];
  let classified: ClassifiedReference[] = [];
  let note: string | null = null;
  let librariesSkipped = false;
  await caretSynced(c);
  await synchronizeDocumentIndexes(c.path);
  if (c.view && c.view.state.doc !== before) throw new IpcError({ kind: "cancelled", message: "", data: null });
  let settled = false;
  const channel = new Channel<References>();
  channel.onmessage = (refs) => {
    if (!onPartial) return;
    void readManyFileLines(pathsToRead(refs.locations, refs.classified ?? [])).then((files) => {
      if (settled) return;
      onPartial({
        groups: groupUsages(refs.locations, files, refs.classified ?? []),
        note: refs.incomplete ? incompleteNote(refs.incomplete, c.word) : null,
        librariesSkipped: false,
      });
    });
  };
  try {
    const refs = await lspRequest(() =>
      commands.lspReferences(request, c.doc, { line: c.line, col: c.col }, false, true, libraries, channel),
    ).finally(() => {
      settled = true;
    });
    locs = refs.locations;
    classified = refs.classified ?? [];
    librariesSkipped = refs.librariesSkipped ?? false;
    if (refs.incomplete) note = incompleteNote(refs.incomplete, c.word);
  } catch (e) {
    if (isCancelled(e)) throw e;
    let fb = null;
    try {
      fb = await syntaxUsages(c);
    } catch (fe) {
      if (isCancelled(fe)) throw fe;
      console.debug("[syntax] usages fallback", fe);
    }
    if (!fb) throw e;
    locs = fb.locs;
    note = fb.note;
  }
  const files = await readManyFileLines(pathsToRead(locs, classified));
  return { groups: groupUsages(locs, files, classified), note, librariesSkipped };
}

/** In-flight server requests: of tool window searches by search id, and of the popup. */
const inflight = new Map<number, RequestId>();
let popupRequest: RequestId | null = null;

function cancelSearch(id: number) {
  const request = inflight.get(id);
  if (request === undefined) return;
  inflight.delete(id);
  void commands.cancelRequest(request).catch(() => {});
}

/** The window switched projects: results (and in-flight searches) of the previous one are dropped. */
export function resetUsages() {
  for (const id of [...inflight.keys()]) cancelSearch(id);
  if (popupRequest !== null) void commands.cancelRequest(popupRequest).catch(() => {});
  popupRequest = null;
  useUsages.setState({ tabs: [], active: null });
  useUsagesPopup.setState({ open: false, symbol: null, groups: [], note: null, loading: false, scope: null });
  popupTarget = null;
}

export async function findUsages() {
  const c = caretContext();
  if (!c) {
    hint("Open a file to find usages");
    return;
  }
  // `widenable`: an earlier run of this search skipped the libraries.
  const run = async (prev: number | null, libraries: boolean, widenable: boolean) => {
    const id = ++searchSeq;
    const base = {
      id,
      symbol: c.word,
      rerun: () => void run(id, libraries, widenable),
      searchLibraries: () => void run(id, true, true),
    };
    const loading = { ...base, loading: true, groups: [], error: null, note: null };
    if (prev !== null) cancelSearch(prev);
    if (prev === null || !replaceUsageTab(prev, loading)) openUsageTab(loading);
    toolWindowService().show("usages");
    const request = nextRequestId();
    inflight.set(id, request);
    try {
      const { groups, note, librariesSkipped } = await fetchUsages(
        c,
        request,
        (found) => {
          if (inflight.get(id) === request) replaceUsageTab(id, { ...loading, groups: found.groups, note: found.note });
        },
        libraries,
      );
      const scope = searchedScope(libraries, librariesSkipped, widenable);
      replaceUsageTab(id, { ...base, loading: false, groups, error: null, note, scope });
    } catch (e) {
      // Cancelled here (closed tab, rerun): a newer state already replaced it.
      if (isCancelled(e) && !inflight.has(id)) return;
      const message = e instanceof Error ? e.message : String(e);
      if (!replaceUsageTab(id, { ...base, loading: false, groups: [], error: message, note: null })) return;
      reportError(e);
    } finally {
      if (inflight.get(id) === request) inflight.delete(id);
    }
  };
  await run(null, false, false);
}

/**
 * Shows already-found usages in the tool window (Safe Delete's "View Usages").
 * Ignores malformed arguments.
 */
export async function showUsageResults(arg: unknown) {
  const a = (arg ?? {}) as {
    symbol?: unknown;
    locations?: unknown;
    classified?: ClassifiedReference[];
    note?: unknown;
  };
  if (!Array.isArray(a.locations)) return;
  const locs = a.locations as Location[];
  const symbol = typeof a.symbol === "string" ? a.symbol : null;
  const id = ++searchSeq;
  const base = { id, symbol, rerun: null };
  openUsageTab({ ...base, loading: true, groups: [], error: null, note: null });
  toolWindowService().show("usages");
  clearLineTokens();
  const files = await readManyFileLines(locs.map((l) => l.path));
  replaceUsageTab(id, {
    ...base,
    loading: false,
    groups: groupUsages(locs, files, a.classified),
    error: null,
    note: typeof a.note === "string" ? a.note : null,
  });
}

export function dismissUsagesPopup() {
  if (popupRequest !== null) void commands.cancelRequest(popupRequest).catch(() => {});
  popupRequest = null;
  useUsagesPopup.setState({ open: false });
}

/** How long Show Usages waits for all usages before it shows those found first. */
const EARLY_POPUP_DELAY_MS = 300;
/** How long the hint after Show Usages stays (and invoking it again widens its search). */
const HINT_MS = 4000;

/**
 * What the popup, or the hint after it, shows usages of: invoked again meanwhile, Show
 * Usages searches it in Project and Libraries, wherever the caret is now.
 */
let popupTarget: { c: CaretContext; widenable: boolean; hintUntil: number } | null = null;

export async function showUsagesPopup() {
  const target = popupTarget;
  const popup = useUsagesPopup.getState();
  if (target?.widenable && ((popup.open && popup.scope === "project") || Date.now() < target.hintUntil)) {
    await searchPopup(target.c, true, true);
    return;
  }
  const c = caretContext();
  if (!c) {
    hint("Open a file to show usages");
    return;
  }
  await searchPopup(c, false, false);
}

/** The popup's scope chooser: searches its symbol again in `scope`. */
export function setUsagesPopupScope(scope: UsageScope) {
  const target = popupTarget;
  if (!target || scope === useUsagesPopup.getState().scope) return;
  void searchPopup(target.c, scope === "libraries", target.widenable);
}

async function searchPopup(c: CaretContext, libraries: boolean, widenable: boolean) {
  // Set from the start: the scope chooser can switch while this search goes on.
  popupTarget = { c, widenable, hintUntil: 0 };
  const reopened = useUsagesPopup.getState().open;
  if (reopened) useUsagesPopup.setState({ loading: true, scope: libraries ? "libraries" : "project" });
  if (popupRequest !== null) void commands.cancelRequest(popupRequest).catch(() => {});
  const request = nextRequestId();
  popupRequest = request;
  // Opened with those found first when the rest take a while; it then stays open, even
  // when they were all. A quick search still jumps to a single usage.
  let early = false;
  let found: FetchedUsages | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Until the popup or the answer shows (a reopened popup has its own spinner).
  const pending = !reopened && c.view ? showPendingHint(c.view, "Searching for usages…") : () => {};
  const openEarly = () => {
    if (popupRequest !== request || !found) return;
    pending();
    if (!early && !reopened) useUsagesPopup.setState({ open: true, anchor: caretPoint(), symbol: c.word });
    early = true;
    useUsagesPopup.setState({ ...found, loading: true, scope: widenable ? "libraries" : null });
  };
  const again = shortcutLabel("find.showUsages");
  try {
    const { groups, note, librariesSkipped } = await fetchUsages(
      c,
      request,
      (partial) => {
        if (!usageCount(partial.groups)) return;
        found = partial;
        if (early) openEarly();
        else timer ??= setTimeout(openEarly, EARLY_POPUP_DELAY_MS);
      },
      libraries,
    ).finally(() => {
      clearTimeout(timer);
      pending();
    });
    if (popupRequest !== request) return;
    const scope = searchedScope(libraries, librariesSkipped, widenable);
    popupTarget = { c, widenable: widenable || scope !== null, hintUntil: 0 };
    const total = usageCount(groups);
    if (early || reopened || total > 1) {
      if (!early && !reopened) useUsagesPopup.setState({ open: true, anchor: caretPoint(), symbol: c.word });
      useUsagesPopup.setState({ groups, note, loading: false, scope });
      return;
    }
    // As in IDEA, the hint offers to widen the search, which Show Usages does while it shows.
    const widen = scope === "project" && again !== "";
    if (widen) popupTarget.hintUntil = Date.now() + HINT_MS;
    // The count and scope, for tests: the hint is the whole answer.
    const counted: Record<string, string> = scope ? { usages: String(total), scope } : { usages: String(total) };
    if (!total) {
      if (widen)
        hint(
          `No usages found in Project Files. Press ${again} again to search in 'Project and Libraries'`,
          "info",
          counted,
        );
      else if (scope === "project") hint("No usages found in Project Files", "info", counted);
      else {
        const none = c.word ? `No usages of '${c.word}' found` : "No usages found";
        hint(note ? `${none}. ${note}` : none, "info", counted);
      }
      return;
    }
    // IDEA jumps to the only usage and says so in the target editor.
    const u = groups[0]!.usages[0]!;
    await openLocation(u.path, u.line, u.col);
    if (widen)
      hint(
        `Only one usage in Project Files. Press ${again} again to search in 'Project and Libraries'`,
        "info",
        counted,
      );
    else if (scope === "libraries") hint("Only one usage in Project and Libraries", "info", counted);
    else hint("Only one usage in Project Files", "info", counted);
  } catch (e) {
    if (popupRequest !== request || isCancelled(e)) return;
    if (early || reopened) useUsagesPopup.setState({ loading: false });
    reportError(e);
  } finally {
    if (popupRequest === request) popupRequest = null;
  }
}

function usageLocationKey(l: Location): string {
  return JSON.stringify([l.path, l.range.start.line, l.range.start.col, l.range.end.line, l.range.end.col]);
}
