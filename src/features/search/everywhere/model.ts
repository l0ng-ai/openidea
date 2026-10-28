/**
 * Search Everywhere result model: item types, per-section merging/ranking
 * and the flat row list (section headers + "more" rows) the dialog renders.
 */
import type { Action } from "@/platform/actions";
import type { FileMatch, LineMatch, SymbolMatch, WorkspaceSymbol } from "@/platform/ipc";
import type { SettingsSearchEntry } from "@/workbench/contributions";
import { tx } from "@/platform/i18n";
import { basename, isTypeKind, relDir, symbolDisplayName } from "../common/open";
import { byScore, matchText } from "../common/rank";

export type SeTab = "all" | "classes" | "files" | "symbols" | "actions" | "text";
export type SectionId = "recent" | "recentActions" | "classes" | "files" | "symbols" | "actions" | "text";

export const TABS: ReadonlyArray<{ id: SeTab; label: string }> = [
  { id: "all", label: "All" },
  { id: "classes", label: "Classes" },
  { id: "files", label: "Files" },
  { id: "symbols", label: "Symbols" },
  { id: "actions", label: "Actions" },
  { id: "text", label: "Text" },
];

export const SECTION_ORDER: readonly SectionId[] = [
  "recent",
  "recentActions",
  "classes",
  "files",
  "symbols",
  "actions",
  "text",
];

export const SECTION_TITLES: Record<SectionId, string> = {
  recent: "Recent Files",
  recentActions: "Recent Actions",
  classes: "Classes",
  files: "Files",
  symbols: "Symbols",
  actions: "Actions",
  text: "Text",
};

/** Sections a tab queries, for a non-empty and an empty query. */
export function sectionsFor(tab: SeTab, emptyQuery: boolean): SectionId[] {
  if (emptyQuery) {
    switch (tab) {
      case "all":
        return ["recent", "recentActions"];
      case "files":
        return ["recent"];
      case "actions":
        return ["recentActions"];
      default:
        return [];
    }
  }
  return tab === "all" ? ["classes", "files", "symbols", "actions", "text"] : [tab];
}

export const ALL_TAB_LIMIT = 6;
export const TAB_LIMIT = 50;
export const MORE_STEP_ALL = 15;
export const MORE_STEP_TAB = 50;
export const RECENT_LIMIT = 15;

export interface FileItem {
  kind: "file";
  key: string;
  path: string;
  rel: string;
  name: string;
  dir: string;
  nameIndices: number[];
  line: number | null;
  col: number | null;
}

export interface SymbolItem {
  kind: "symbol";
  key: string;
  name: string;
  display: string;
  symbolKind: string;
  container: string | null;
  path: string;
  rel: string;
  line: number;
  col: number;
  indices: number[];
  /** From the language server rather than the index. */
  lsp?: boolean;
}

export interface ActionItem {
  kind: "action";
  key: string;
  id: string;
  title: string;
  category?: string;
  icon?: string;
  enabled: boolean;
  indices: number[];
  score: number;
}

export interface TextItem {
  kind: "text";
  key: string;
  path: string;
  rel: string;
  line: number;
  col: number;
  endCol: number;
  /** The line with its indentation collapsed to at most two spaces. */
  text: string;
  indices: number[];
}

/** A settings page or option, listed among actions ("Settings: Editor | General"). */
export interface SettingItem {
  kind: "setting";
  key: string;
  pageId: string;
  title: string;
  path: string[];
  indices: number[];
  score: number;
}

export type SeItem = FileItem | SymbolItem | ActionItem | TextItem | SettingItem;

export type SeRow =
  | { kind: "section"; key: string; section: SectionId; title: string }
  | { kind: "command"; key: string; name: string; tab: SeTab; label: string }
  | { kind: "more"; key: string; section: SectionId }
  | (SeItem & { section: SectionId });

export interface SectionState {
  items: SeItem[];
  hasMore: boolean;
  loading: boolean;
}

// ---------------------------------------------------------------------------
// Item builders

export function fileItem(
  m: Pick<FileMatch, "path" | "relPath" | "indices">,
  line: number | null = null,
  col: number | null = null,
): FileItem {
  const name = basename(m.relPath);
  const nameStart = m.relPath.length - name.length;
  return {
    kind: "file",
    key: `f:${m.path}`,
    path: m.path,
    rel: m.relPath,
    name,
    dir: relDir(m.relPath),
    nameIndices: m.indices.filter((i) => i >= nameStart).map((i) => i - nameStart),
    line,
    col,
  };
}

export function symbolItem(m: SymbolMatch): SymbolItem {
  return {
    kind: "symbol",
    key: `s:${m.path}:${m.range.start.line}:${m.range.start.col}:${m.name}`,
    name: m.name,
    display: symbolDisplayName(m.name, m.kind),
    symbolKind: m.kind,
    container: m.container,
    path: m.path,
    rel: m.relPath,
    line: m.range.start.line,
    col: m.range.start.col,
    indices: m.indices,
  };
}

const isExact = (name: string, query: string) => name.toLowerCase() === query.trim().toLowerCase();

const dedupeKey = (path: string, line: number, name: string) => `${path}\u0000${line}\u0000${name}`;

/**
 * Index results keep the backend's order; language-server symbols that the
 * index doesn't know are scored locally and appended (or interleaved when they
 * clearly match better, e.g. an exact name hit).
 */
export function mergeSymbols(
  index: readonly SymbolMatch[],
  lsp: readonly WorkspaceSymbol[],
  query: string,
  opts: { root: string | null; includeNonProject: boolean; typesOnly: boolean; excludeTypes: boolean; limit: number },
): { items: SymbolItem[]; hasMore: boolean } {
  const keep = (kind: string) => (opts.typesOnly ? isTypeKind(kind) : opts.excludeTypes ? !isTypeKind(kind) : true);
  const seen = new Set<string>();
  const scored: Array<{ item: SymbolItem; score: number }> = [];
  index.forEach((m, i) => {
    if (!keep(m.kind)) return;
    const k = dedupeKey(m.path, m.range.start.line, m.name);
    if (seen.has(k)) return;
    seen.add(k);
    // Backend order is authoritative within each tier (exact name / other).
    scored.push({ item: symbolItem(m), score: (isExact(m.name, query) ? 4000 : 3000) - i });
  });
  for (const s of lsp) {
    if (!keep(s.kind)) continue;
    const path = s.location.path;
    const inProject = !!opts.root && (path === opts.root || path.startsWith(opts.root + "/"));
    if (!inProject && !opts.includeNonProject) continue;
    const line = s.location.range.start.line;
    const k = dedupeKey(path, line, s.name);
    if (seen.has(k)) continue;
    const hit = matchText(s.name, query);
    if (!hit) continue;
    seen.add(k);
    const rel = opts.root && inProject ? path.slice(opts.root.length + 1) : path;
    scored.push({
      item: {
        kind: "symbol",
        key: `s:${path}:${line}:${s.location.range.start.col}:${s.name}`,
        name: s.name,
        display: symbolDisplayName(s.name, s.kind),
        symbolKind: s.kind,
        container: s.container,
        path,
        rel,
        line,
        col: s.location.range.start.col,
        indices: hit.indices,
        lsp: true,
      },
      // Exact LSP hits follow exact index hits but beat fuzzy ones.
      score: isExact(s.name, query) ? 3500 : hit.score,
    });
  }
  const sorted = byScore(scored).map((s) => s.item);
  return { items: sorted.slice(0, opts.limit), hasMore: sorted.length > opts.limit };
}

export function matchActions(
  actions: readonly Action[],
  query: string,
  opts: { isEnabled: (a: Action) => boolean; recent: readonly string[]; includeDisabled?: boolean },
): ActionItem[] {
  const q = query.trim();
  if (!q) return [];
  const out: ActionItem[] = [];
  const recentRank = new Map(opts.recent.map((id, i) => [id, i]));
  for (const a of actions) {
    if (a.hidden) continue;
    const enabled = opts.isEnabled(a);
    if (!enabled && opts.includeDisabled === false) continue;
    let score: number;
    let indices: number[] = [];
    const translated = tx(a.title);
    const title = matchText(translated, q, { wordAligned: true });
    // The English title still matches; its indices don't apply to the translated text.
    const english = title || translated === a.title ? undefined : matchText(a.title, q, { wordAligned: true });
    if (title) {
      score = title.score;
      indices = title.indices;
    } else if (english) {
      score = english.score;
    } else {
      const extra = [a.category ? tx(a.category) : "", a.description, ...(a.keywords ?? [])].filter(
        (s): s is string => !!s,
      );
      const best = Math.max(-Infinity, ...extra.map((s) => matchText(s, q, { wordAligned: true })?.score ?? -Infinity));
      const idHit = a.id.toLowerCase().includes(q.toLowerCase()) ? 0 : -Infinity;
      score = Math.max(best, idHit) - 400;
      if (!Number.isFinite(score)) continue;
    }
    if (!enabled) score -= 150;
    const r = recentRank.get(a.id);
    if (r !== undefined) score += 40 - Math.min(30, r * 3);
    out.push({
      kind: "action",
      key: `a:${a.id}`,
      id: a.id,
      title: translated,
      category: a.category ? tx(a.category) : a.category,
      icon: a.icon,
      enabled,
      indices,
      score,
    });
  }
  return byScore(out);
}

/** Settings below equally good actions, as IDEA's option matches. */
const SETTING_PENALTY = 120;

export function matchSettings(entries: readonly SettingsSearchEntry[], query: string): SettingItem[] {
  const q = query.trim();
  if (!q) return [];
  const out: SettingItem[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const title = tx(e.title);
    const hit = matchText(title, q, { wordAligned: true });
    const english = hit || title === e.title ? null : matchText(e.title, q, { wordAligned: true });
    let score: number;
    let indices: number[] = [];
    if (hit) {
      score = hit.score;
      indices = hit.indices;
    } else if (english) {
      score = english.score;
    } else {
      const extra = [...e.path.map((p) => tx(p)), ...(e.keywords ?? [])];
      const best = Math.max(-Infinity, ...extra.map((t) => matchText(t, q, { wordAligned: true })?.score ?? -Infinity));
      if (!Number.isFinite(best)) continue;
      score = best - 400;
    }
    const key = `set:${e.pageId}:${e.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: "setting", key, pageId: e.pageId, title, path: e.path, indices, score: score - SETTING_PENALTY });
  }
  return byScore(out);
}

/** Actions and settings in one relevance order (ties keep actions first). */
export function mergeActionResults(actions: readonly ActionItem[], settings: readonly SettingItem[]): SeItem[] {
  return byScore<ActionItem | SettingItem>([...actions, ...settings]);
}

export function actionItem(a: Action, enabled: boolean): ActionItem {
  return {
    kind: "action",
    key: `a:${a.id}`,
    id: a.id,
    title: tx(a.title),
    category: a.category ? tx(a.category) : a.category,
    icon: a.icon,
    enabled,
    indices: [],
    score: 0,
  };
}

export function textItems(path: string, rel: string, matches: readonly LineMatch[]): TextItem[] {
  const out: TextItem[] = [];
  for (const m of matches) {
    const ws = m.text.length - m.text.trimStart().length;
    // Like IDEA: a hint of indentation shows nesting without wasting the row.
    const indent = " ".repeat(Math.min(ws, 2));
    const lead = ws - indent.length;
    const text = indent + m.text.slice(ws).trimEnd();
    const indices: number[] = [];
    for (const [s, e] of m.ranges)
      for (let i = Math.max(s, ws); i < e; i++) if (i - lead < text.length) indices.push(i - lead);
    const first = m.ranges[0] ?? [0, 0];
    out.push({
      kind: "text",
      key: `t:${path}:${m.line}:${first[0]}`,
      path,
      rel,
      line: m.line,
      col: first[0] + m.textOffset,
      endCol: first[1] + m.textOffset,
      text,
      indices,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rows

/** Sections the All tab mixes into one relevance-ordered list. */
const MIXED: readonly SectionId[] = ["classes", "files", "symbols", "actions", "text"];

/**
 * Weight of a text hit: a literal substring in a line ranks below name
 * matches that start a word but above scattered name subsequences.
 */
export const TEXT_WEIGHT = 350;

/** Comparable match degree of an item's name against the query (IDEA's `MatchingDegree`). */
export function itemWeight(item: SeItem, query: string): number {
  const name = (text: string) => matchText(text, query)?.score;
  switch (item.kind) {
    case "file":
      return name(item.name) ?? (name(item.rel) ?? 0) - 200;
    case "symbol":
      return name(item.name) ?? (item.container ? name(`${item.container}.${item.name}`) : undefined) ?? 0;
    case "action":
    case "setting":
      return item.score;
    case "text":
      return TEXT_WEIGHT;
  }
}

interface Mixed {
  item: SeItem;
  section: SectionId;
  weight: number;
}

/**
 * The All tab's results interleaved by weight. Within a section the source's
 * order wins (the index already ranks with recency etc.), so weights are
 * clamped to be non-increasing; ties keep the section order.
 */
export function mixItems(sections: ReadonlyMap<SectionId, SectionState>, query: string): Mixed[] {
  const out: Array<Mixed & { rank: number }> = [];
  MIXED.forEach((id, rank) => {
    let cap = Infinity;
    for (const item of sections.get(id)?.items ?? []) {
      cap = Math.min(cap, itemWeight(item, query));
      out.push({ item, section: id, weight: cap, rank });
    }
  });
  return out
    .map((m, i) => ({ m, i }))
    .sort((a, b) => b.m.weight - a.m.weight || a.m.rank - b.m.rank || a.i - b.i)
    .map(({ m }) => m);
}

/**
 * Flat rows the dialog renders. With `mix` (the All tab's query) results are
 * interleaved by relevance and "more" rows follow them; otherwise sections
 * keep their fixed order.
 */
export function buildRows(
  sections: ReadonlyMap<SectionId, SectionState>,
  opts: { headers: boolean; mix?: string },
): SeRow[] {
  const rows: SeRow[] = [];
  if (opts.mix?.trim()) {
    for (const m of mixItems(sections, opts.mix.trim())) rows.push({ ...m.item, section: m.section });
    for (const id of MIXED) if (sections.get(id)?.hasMore) rows.push({ kind: "more", key: `+${id}`, section: id });
    return rows;
  }
  for (const id of SECTION_ORDER) {
    const s = sections.get(id);
    if (!s || !s.items.length) continue;
    if (opts.headers) rows.push({ kind: "section", key: `#${id}`, section: id, title: SECTION_TITLES[id] });
    for (const item of s.items) rows.push({ ...item, section: id });
    if (s.hasMore) rows.push({ kind: "more", key: `+${id}`, section: id });
  }
  return rows;
}

export const isSectionRow = (r: SeRow) => r.kind === "section";

/**
 * Next / Previous Group (PageDown / PageUp, ⌘↓ / ⌘↑): the first item of the
 * next section, or of the current (then previous) one; null without sections.
 */
export function groupJump(rows: readonly SeRow[], active: number, dir: 1 | -1): number | null {
  // Groups start where the section changes (the All tab may show no header rows).
  const starts: number[] = [];
  let last: string | null = null;
  rows.forEach((r, i) => {
    if (isSectionRow(r) || r.kind === "command" || !("section" in r)) return;
    if (r.section !== last) starts.push(i);
    last = r.section;
  });
  if (starts.length < 2) return null;
  if (dir === 1) return starts.find((s) => s > active) ?? starts[starts.length - 1]!;
  const current = [...starts].reverse().find((s) => s <= active) ?? starts[0]!;
  return current < active ? current : ([...starts].reverse().find((s) => s < active) ?? starts[0]!);
}

// ---------------------------------------------------------------------------
// "/" commands

export const COMMANDS: ReadonlyArray<{ name: string; tab: SeTab; label: string }> = TABS.filter(
  (t) => t.id !== "all",
).map((t) => ({ name: `/${t.id}`, tab: t.id, label: t.label }));

export type ParsedCommand = { kind: "list"; rows: SeRow[] } | { kind: "run"; tab: SeTab; rest: string };

/**
 * `/` or `/fi` lists the matching scope commands; `/files foo` switches to
 * Files and searches `foo`. Anything else (e.g. an absolute path) is a query.
 */
export function parseCommand(query: string): ParsedCommand | null {
  const m = /^\/(\S*)(?:\s+([\s\S]*))?$/.exec(query);
  if (!m) return null;
  const word = m[1]!.toLowerCase();
  if (m[2] !== undefined) {
    const cmd = COMMANDS.find((c) => c.name === `/${word}`);
    return cmd ? { kind: "run", tab: cmd.tab, rest: m[2] } : null;
  }
  const rows: SeRow[] = COMMANDS.filter((c) => c.name.startsWith(`/${word}`)).map((c) => ({
    kind: "command",
    key: `cmd:${c.tab}`,
    ...c,
  }));
  return rows.length ? { kind: "list", rows } : null;
}

/**
 * Whether the top result is final: every section above the first one with
 * items has finished. Enter typed before that waits (IDEA opens the first
 * result of the new query, never a stale row of the previous one).
 * With `mix`, any section can still outrank the top row; only a slow text
 * search is not waited for once the top row beats every text hit.
 */
export function topResultSettled(sections: ReadonlyMap<SectionId, SectionState>, mix?: string): boolean {
  if (mix?.trim()) {
    const top = mixItems(sections, mix.trim())[0]?.weight ?? -Infinity;
    return MIXED.every((id) => !sections.get(id)?.loading || (id === "text" && top > TEXT_WEIGHT));
  }
  for (const id of SECTION_ORDER) {
    const s = sections.get(id);
    if (!s) continue;
    if (s.loading) return false;
    if (s.items.length) return true;
  }
  return true;
}

/**
 * Keeps the selection on the same item while results stream in: returns the
 * index of `key` if still present, otherwise the first selectable row
 * (or the clamped previous index after the user navigated).
 */
export function stableIndex(rows: readonly SeRow[], key: string | null, prevIndex: number, userMoved: boolean): number {
  if (key) {
    const i = rows.findIndex((r) => r.key === key);
    if (i >= 0) return i;
  }
  if (userMoved && prevIndex >= 0 && rows.length) {
    for (let i = Math.min(prevIndex, rows.length - 1); i >= 0; i--) if (!isSectionRow(rows[i]!)) return i;
  }
  return rows.findIndex((r) => !isSectionRow(r));
}
