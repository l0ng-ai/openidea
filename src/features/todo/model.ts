/**
 * TODO items: patterns, the Find-in-Files query, conversion of search
 * matches, local scanning of editor text, grouping and filters.
 */
import type { FileMatches, SearchQuery, SearchScope } from "@/platform/ipc";
import type { CustomScope } from "@/platform/search";
import { localChangedPaths, type LocalChangelist } from "@/workbench/contributions";

export interface TodoPattern {
  id: string;
  keyword: string;
  /** CSS colour token, e.g. `var(--info)`. */
  color: string;
  enabled: boolean;
}

export interface TodoSettings {
  patterns: TodoPattern[];
  caseSensitive: boolean;
  /** Only count matches that follow a comment marker on their line. */
  commentsOnly: boolean;
}

export const DEFAULT_PATTERNS: TodoPattern[] = [
  { id: "todo", keyword: "TODO", color: "var(--info)", enabled: true },
  { id: "fixme", keyword: "FIXME", color: "var(--danger)", enabled: true },
  { id: "hack", keyword: "HACK", color: "var(--warning)", enabled: true },
  { id: "xxx", keyword: "XXX", color: "var(--warning)", enabled: true },
];

export const DEFAULT_TODO_SETTINGS: TodoSettings = {
  patterns: DEFAULT_PATTERNS,
  caseSensitive: true,
  commentsOnly: true,
};

export interface TodoItem {
  path: string;
  /** 0-based line. */
  line: number;
  /** UTF-16 column of the keyword in the real line. */
  col: number;
  /** Pattern keyword as configured (e.g. `TODO`). */
  keyword: string;
  /** Text from the keyword to the end of the comment. */
  text: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const activePatterns = (s: TodoSettings) => s.patterns.filter((p) => p.enabled && p.keyword.trim());

/** `\b(TODO|FIXME|HACK|XXX)\b.*`, or null when no pattern is enabled. */
export function todoRegexSource(s: TodoSettings): string | null {
  const kws = activePatterns(s).map((p) => escapeRe(p.keyword.trim()));
  return kws.length ? `\\b(${kws.join("|")})\\b.*` : null;
}

export function buildTodoQuery(s: TodoSettings, scope: SearchScope = { kind: "project" }): SearchQuery | null {
  const pattern = todoRegexSource(s);
  if (!pattern) return null;
  return {
    pattern,
    isRegex: true,
    caseSensitive: s.caseSensitive,
    wholeWord: false,
    include: [],
    exclude: [],
    scope,
    maxMatches: 0,
  };
}

// 注释开符，行内任意位置（行首或空白后）都算：// /* <!-- # -- {- (* 。
// 杀掉 URL 里的 //、字符串里的 #、f(*)、a * b 这类代码误报。残留误报
// （语言感知才能根除）："x # y" 字符串、--y 前置自减。
// `*` `;` `%` `"""` `'''` 是代码字符，只在行首算注释（LINE_START_MARKER）。
// IDEA 的默认模式匹配注释内任意位置的 TODO，所以关键字不要求"引领"注释。
const INLINE_MARKER = /(?:^|\s)(?:\/\/|\/\*|<!--|#|--|\{-|\(\*)/;
const LINE_START_MARKER = /^\s*(?:\*|;|%|"""|''')/;
// 长行被后端截断（ide-search line.rs：textOffset > 0）时 prefix 不始于真实行首，
// 锚定无从判定——退回只查开符存在，宁误报不漏报。
const LENIENT_MARKER = /(\/\/|\/\*|<!--|#|--|\{-|\(\*|\*|;|%|"""|''')/;

export function looksLikeComment(prefix: string, truncated = false): boolean {
  if (truncated) return LENIENT_MARKER.test(prefix);
  return INLINE_MARKER.test(prefix) || LINE_START_MARKER.test(prefix);
}

function cleanText(text: string): string {
  return text.replace(/\s*(\*\/|-->|-\}|\*\)|"""|''')\s*$/, "").replace(/\s+$/, "");
}

function patternFor(s: TodoSettings, matched: string): TodoPattern | undefined {
  const pats = activePatterns(s);
  return s.caseSensitive
    ? pats.find((p) => matched.startsWith(p.keyword.trim()))
    : pats.find((p) => matched.toLowerCase().startsWith(p.keyword.trim().toLowerCase()));
}

/** Converts one file's search matches to TODO items. */
export function itemsFromMatches(fm: FileMatches, s: TodoSettings): TodoItem[] {
  const out: TodoItem[] = [];
  for (const lm of fm.matches) {
    for (const [start, end] of lm.ranges) {
      const matched = lm.text.slice(start, end);
      const p = patternFor(s, matched);
      if (!p) continue;
      if (s.commentsOnly && !looksLikeComment(lm.text.slice(0, start), lm.textOffset > 0)) continue;
      out.push({
        path: fm.path,
        line: lm.line,
        col: lm.textOffset + start,
        keyword: p.keyword.trim(),
        text: cleanText(matched),
      });
    }
  }
  return out;
}

/** Scans document text locally (open editors), same rules as the backend search. */
export function scanText(path: string, text: string, s: TodoSettings): TodoItem[] {
  const source = todoRegexSource(s);
  if (!source) return [];
  const re = new RegExp(source, s.caseSensitive ? "gu" : "giu");
  const out: TodoItem[] = [];
  let line = 0;
  let lineStart = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index!;
    for (let nl = text.indexOf("\n", lineStart); nl !== -1 && nl < idx; nl = text.indexOf("\n", nl + 1)) {
      line++;
      lineStart = nl + 1;
    }
    const p = patternFor(s, m[0]);
    if (!p) continue;
    if (s.commentsOnly && !looksLikeComment(text.slice(lineStart, idx), false)) continue;
    out.push({ path, line, col: idx - lineStart, keyword: p.keyword.trim(), text: cleanText(m[0]) });
  }
  return out;
}

export interface TodoGroup {
  path: string;
  items: TodoItem[];
}

export interface TodoFilter {
  /** Keywords to show; null = all. */
  keywords: ReadonlySet<string> | null;
  /** Restrict to one file (Current File tab). */
  path?: string | null;
  /** Restrict to these files (Changes tab). */
  paths?: ReadonlySet<string>;
}

export function filterItems(items: readonly TodoItem[], f: TodoFilter): TodoItem[] {
  return f.keywords ? items.filter((i) => f.keywords!.has(i.keyword)) : [...items];
}

/** Groups by file (sorted by path), items by position; empty groups dropped. */
export function groupTodos(map: ReadonlyMap<string, readonly TodoItem[]>, f: TodoFilter): TodoGroup[] {
  const all = f.path !== undefined ? (f.path && map.has(f.path) ? [f.path] : []) : [...map.keys()];
  const paths = f.paths ? all.filter((p) => f.paths!.has(p)) : all;
  const groups: TodoGroup[] = [];
  for (const path of paths) {
    const items = filterItems(map.get(path) ?? [], f).sort((a, b) => a.line - b.line || a.col - b.col);
    if (items.length) groups.push({ path, items });
  }
  return groups.sort((a, b) => a.path.localeCompare(b.path));
}

export const countItems = (groups: readonly TodoGroup[]) => groups.reduce((n, g) => n + g.items.length, 0);

/** Backend results with live editor scans layered on top. */
export function mergeLive(
  scanned: ReadonlyMap<string, readonly TodoItem[]>,
  live: ReadonlyMap<string, readonly TodoItem[]>,
): Map<string, readonly TodoItem[]> {
  const out = new Map(scanned);
  for (const [path, items] of live) out.set(path, items);
  return out;
}

/** A scope of the "Scope Based" tab: a built-in one or a custom scope (`custom:<name>`, `@/platform/search`). */
export type TodoScope = "projectFiles" | "productionFiles" | "testFiles" | "openFiles" | `custom:${string}`;

export const BUILTIN_TODO_SCOPES: ReadonlyArray<{ value: TodoScope; label: string }> = [
  { value: "projectFiles", label: "Project Files" },
  { value: "productionFiles", label: "Project Production Files" },
  { value: "testFiles", label: "Project Test Files" },
  { value: "openFiles", label: "Open Files" },
];

/** The backend scope to scan, or null when there is nothing to scan (no open files, unknown custom scope). */
export function todoSearchScope(
  scope: TodoScope,
  custom: readonly CustomScope[],
  openPaths: readonly string[],
): SearchScope | null {
  switch (scope) {
    case "projectFiles":
      return { kind: "project" };
    case "productionFiles":
      return { kind: "fileSet", set: "production" };
    case "testFiles":
      return { kind: "fileSet", set: "test" };
    case "openFiles":
      return openPaths.length ? { kind: "files", paths: [...openPaths] } : null;
  }
  const name = scope.slice("custom:".length);
  const found = custom.find((c) => c.name === name);
  return found ? { kind: "pattern", pattern: found.pattern } : null;
}

/**
 * Files with local changes in change list `listId` (the active one when unset or
 * gone), from the VCS change lists: unversioned and ignored files belong to no list.
 */
export function changedPaths(lists: readonly LocalChangelist[], listId?: string | null): Set<string> {
  const id = lists.find((l) => l.id === listId)?.id ?? lists.find((l) => l.active)?.id ?? lists[0]?.id;
  return new Set(id ? localChangedPaths(lists, id, true) : []);
}
