/** TODO patterns and matching shared by the editor, search and commit checks. */
import { create } from "zustand";
import type { FileMatches, SearchQuery, SearchScope } from "./ipc";

export interface TodoPattern {
  id: string;
  keyword: string;
  /** CSS colour token, e.g. `var(--info)`. */
  color: string;
  enabled: boolean;
}

export interface TodoFilter {
  id: string;
  name: string;
  patternIds: string[];
}

export interface TodoSettings {
  patterns: TodoPattern[];
  filters: TodoFilter[];
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
  filters: [],
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
  /** Comment preview beginning at the keyword. */
  text: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const activePatterns = (s: TodoSettings) => s.patterns.filter((p) => p.enabled && p.keyword.trim());

/** A deleted selection falls back to all patterns. An existing empty filter matches nothing. */
export function todoFilterKeywords(settings: TodoSettings, id: string | null): ReadonlySet<string> | null {
  const filter = settings.filters.find((candidate) => candidate.id === id);
  if (!filter) return null;
  const ids = new Set(filter.patternIds);
  return new Set(
    activePatterns(settings)
      .filter((pattern) => ids.has(pattern.id))
      .map((pattern) => pattern.keyword.trim()),
  );
}

/** Matches individual keywords so a scan can find several patterns on one line. */
export function todoRegexSource(s: TodoSettings): string | null {
  const kws = activePatterns(s)
    .map((p) => p.keyword.trim())
    .sort((a, b) => b.length - a.length)
    .map(escapeRe);
  return kws.length ? `\\b(${kws.join("|")})\\b` : null;
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

// Comment openers that count anywhere on the line, at its start or after whitespace: // /* <!-- # -- {- (*.
// The whitespace rule drops `//` in URLs, `#` in strings, `f(*)` and `a * b`. Left over without knowing
// the language: `"x # y"` in a string and a prefix `--y`.
// `*` `;` `%` `"""` `'''` are code characters too, so they count only at the line start (LINE_START_MARKER).
// The default pattern matches a TODO anywhere inside a comment, so the keyword need not lead it.
const INLINE_MARKER = /(?:^|\s)(?:\/\/|\/\*|<!--|#|--|\{-|\(\*)/;
const LINE_START_MARKER = /^\s*(?:\*|;|%|"""|''')/;
// A long line the backend truncated (ide-search line.rs, `textOffset > 0`) doesn't start at the real line
// start, so neither rule can apply: any marker counts, a false positive rather than a missed TODO.
const LENIENT_MARKER = /(\/\/|\/\*|<!--|#|--|\{-|\(\*|\*|;|%|"""|''')/;

export function looksLikeComment(prefix: string, truncated = false): boolean {
  if (truncated) return LENIENT_MARKER.test(prefix);
  return INLINE_MARKER.test(prefix) || LINE_START_MARKER.test(prefix);
}

function cleanText(text: string): string {
  return text.replace(/\s*(\*\/|-->|-\}|\*\)|"""|''')\s*$/, "").replace(/\s+$/, "");
}

function patternFor(s: TodoSettings, matched: string): TodoPattern | undefined {
  const keyword = s.caseSensitive ? matched : matched.toLowerCase();
  return s.patterns.find((p) => {
    const pattern = p.keyword.trim();
    return p.enabled && keyword === (s.caseSensitive ? pattern : pattern.toLowerCase());
  });
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
        text: cleanText(lm.text.slice(start)),
      });
    }
  }
  return out;
}

// Match the preview size of an indexed search line.
const TODO_PREVIEW_LENGTH = 500;

/** Scans document text locally (open editors), same rules as the backend search. */
export function scanText(path: string, text: string, s: TodoSettings): TodoItem[] {
  const source = todoRegexSource(s);
  if (!source) return [];
  const re = new RegExp(source, s.caseSensitive ? "gu" : "giu");
  const out: TodoItem[] = [];
  let line = 0;
  let lineStart = 0;
  let lineEnd = text.indexOf("\n");
  for (const m of text.matchAll(re)) {
    const idx = m.index!;
    while (lineEnd !== -1 && lineEnd < idx) {
      line++;
      lineStart = lineEnd + 1;
      lineEnd = text.indexOf("\n", lineStart);
    }
    const p = patternFor(s, m[0]);
    if (!p) continue;
    if (s.commentsOnly && !looksLikeComment(text.slice(lineStart, idx), false)) continue;
    const previewEnd = Math.min(lineEnd === -1 ? text.length : lineEnd, idx + TODO_PREVIEW_LENGTH);
    out.push({
      path,
      line,
      col: idx - lineStart,
      keyword: p.keyword.trim(),
      text: cleanText(text.slice(idx, previewEnd)),
    });
  }
  return out;
}

const SETTINGS_KEY = "openidea.todo.v1";

function loadSettings(): TodoSettings {
  try {
    const raw = globalThis.localStorage?.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_TODO_SETTINGS, ...JSON.parse(raw) };
  } catch {
    // ignore
  }
  return DEFAULT_TODO_SETTINGS;
}

export const useTodoSettings = create<TodoSettings>(() => loadSettings());

export function updateTodoSettings(patch: Partial<TodoSettings>) {
  useTodoSettings.setState(patch);
  try {
    globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(useTodoSettings.getState()));
  } catch {
    // ignore
  }
}

/** Picks up changes saved by another window (the Settings window). */
export function syncTodoSettingsFromStorage(): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === SETTINGS_KEY) useTodoSettings.setState(loadSettings(), true);
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
