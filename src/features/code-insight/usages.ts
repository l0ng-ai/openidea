/** Find Usages (⌥F7 → "usages" tool window) and Show Usages (⌥⌘F7 → popup). */
import { create } from "zustand";
import type { Location, ReferencesIncomplete, RequestId } from "@/bindings";
import { clearLineTokens } from "@/editor/lineTokens";
import { commands, isCancelled, nextRequestId } from "@/platform/ipc";
import { toolWindowService } from "@/workbench/contributions";
import {
  caretContext,
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
): UsageGroup[] {
  const byPath = new Map<string, Usage[]>();
  const seen = new Set<string>();
  for (const l of locs) {
    const key = `${l.path}:${l.range.start.line}:${l.range.start.col}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = files.get(l.path)?.[l.range.start.line] ?? "";
    const endCol = l.range.end.line === l.range.start.line ? l.range.end.col : Math.max(text.length, l.range.start.col);
    let list = byPath.get(l.path);
    if (!list) byPath.set(l.path, (list = []));
    list.push({ path: l.path, line: l.range.start.line, col: l.range.start.col, endCol, text });
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
}

export const useUsagesPopup = create<UsagesPopupState>(() => ({
  open: false,
  anchor: { x: 0, y: 0 },
  symbol: null,
  groups: [],
  note: null,
}));

interface FetchedUsages {
  groups: UsageGroup[];
  note: string | null;
}

/** Why the server's answer may miss usages, for the results' note. */
export function incompleteNote(reason: ReferencesIncomplete, word: string | null): string {
  if (reason === "indexing") return "May be incomplete: the language server is still indexing";
  return `May be incomplete: too many files mention ${word ? `'${word}'` : "the name"} to search them all`;
}

/**
 * The server's references across the project (files outside its analysis scope
 * included); when it is not ready or fails, the syntax fallback (an empty server
 * answer is respected). Without a fallback the server error stands.
 * Cancel with `commands.cancelRequest(request)`.
 */
export async function fetchUsages(c: CaretContext, request: RequestId = nextRequestId()): Promise<FetchedUsages> {
  // Usage lines are read afresh: so are the files their syntax colours come from.
  clearLineTokens();
  let locs: Location[];
  let note: string | null = null;
  try {
    const refs = await lspRequest(() =>
      commands.lspReferences(request, c.doc, { line: c.line, col: c.col }, false, true),
    );
    locs = refs.locations;
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
  const files = await readManyFileLines(locs.map((l) => l.path));
  return { groups: groupUsages(locs, files), note };
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
  useUsagesPopup.setState({ open: false, symbol: null, groups: [], note: null });
}

export async function findUsages() {
  const c = caretContext();
  if (!c) {
    hint("Open a file to find usages");
    return;
  }
  const run = async (prev: number | null) => {
    const id = ++searchSeq;
    const base = { id, symbol: c.word, rerun: () => void run(id) };
    const loading = { ...base, loading: true, groups: [], error: null, note: null };
    if (prev !== null) cancelSearch(prev);
    if (prev === null || !replaceUsageTab(prev, loading)) openUsageTab(loading);
    toolWindowService().show("usages");
    const request = nextRequestId();
    inflight.set(id, request);
    try {
      const { groups, note } = await fetchUsages(c, request);
      replaceUsageTab(id, { ...base, loading: false, groups, error: null, note });
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
  await run(null);
}

/**
 * Shows already-found usages in the tool window (Safe Delete's "View Usages").
 * Ignores malformed arguments.
 */
export async function showUsageResults(arg: unknown) {
  const a = (arg ?? {}) as { symbol?: unknown; locations?: unknown };
  if (!Array.isArray(a.locations)) return;
  const locs = a.locations as Location[];
  const symbol = typeof a.symbol === "string" ? a.symbol : null;
  const id = ++searchSeq;
  const base = { id, symbol, rerun: null };
  openUsageTab({ ...base, loading: true, groups: [], error: null, note: null });
  toolWindowService().show("usages");
  clearLineTokens();
  const files = await readManyFileLines(locs.map((l) => l.path));
  replaceUsageTab(id, { ...base, loading: false, groups: groupUsages(locs, files), error: null, note: null });
}

export async function showUsagesPopup() {
  const c = caretContext();
  if (!c) {
    hint("Open a file to show usages");
    return;
  }
  if (popupRequest !== null) void commands.cancelRequest(popupRequest).catch(() => {});
  const request = nextRequestId();
  popupRequest = request;
  try {
    const { groups, note } = await fetchUsages(c, request);
    const total = usageCount(groups);
    if (!total) {
      const none = c.word ? `No usages of '${c.word}' found` : "No usages found";
      hint(note ? `${none}. ${note}` : none);
      return;
    }
    if (total === 1) {
      // IDEA jumps to the only usage and says so in the target editor.
      const u = groups[0]!.usages[0]!;
      await openLocation(u.path, u.line, u.col);
      hint("Only one usage in Project Files");
      return;
    }
    useUsagesPopup.setState({ open: true, anchor: caretPoint(), symbol: c.word, groups, note });
  } catch (e) {
    reportError(e);
  } finally {
    if (popupRequest === request) popupRequest = null;
  }
}
