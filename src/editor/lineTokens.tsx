/**
 * Syntax colours for result lines (Find in Files, Show Usages), like IDEA's
 * `ChunkExtractor`: each file is parsed whole once, so a line inside a block
 * comment or a multi-line string is coloured as such.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Text } from "@codemirror/state";
import { editorsFor } from "@/editor/api";
import { codeHighlighter, highlightTokens, languageForPath, type CodeToken } from "@/editor/lsp/markdown";
import { call, commands } from "@/platform/ipc";
import { isVirtualUri, virtualDocument } from "@/platform/virtualDocs";

export type { CodeToken };

/** Where a result line's `text` sits in its file: 0-based `line`, column `col`. */
export interface LineSource {
  path: string;
  line: number;
  col: number;
}

const texts = new Map<string, Promise<string>>();

/**
 * Text of a file that isn't open (a library source or a read-only backend
 * read that doesn't open a document), cached until `clearLineTokens`.
 */
export function readFileText(path: string): Promise<string> {
  let p = texts.get(path);
  if (!p) {
    p = isVirtualUri(path) ? virtualDocument(path).then((d) => d.text) : call(commands.fsReadText(path));
    p.catch(() => texts.delete(path));
    texts.set(path, p);
    if (texts.size > 40) texts.delete(texts.keys().next().value!);
  }
  return p;
}

/** Drops cached file texts and parses (a new search reads the files again). */
export function clearLineTokens() {
  texts.clear();
  highlighted.clear();
}

/** Bigger files aren't parsed whole: their result lines are coloured on their own. */
const MAX_PARSE = 500_000;

interface Parsed {
  doc: Text;
  highlight: (from: number, to: number) => CodeToken[];
}

/**
 * One file parsed whole: `source` is the editor document or the text it was
 * parsed from, so an edit (a new `Text`) or a re-read (a new string) parses
 * again.
 */
interface Highlighted {
  source: Text | string;
  parsed: Promise<Parsed | null>;
  /** Tokens per result line (`lineKey`). */
  lines: Map<string, CodeToken[]>;
}
const highlighted = new Map<string, Highlighted>();

const lineKey = (line: number, col: number, text: string) => `${line}\u0000${col}\u0000${text}`;

/** `lineTokens` already computed for the file as last parsed (for a first render without flicker). */
export function peekLineTokens({ path, line, col }: LineSource, text: string): CodeToken[] | null {
  return highlighted.get(path)?.lines.get(lineKey(line, col, text)) ?? null;
}

/**
 * Syntax tokens of a result line (`text` at `source`), positions within
 * `text`, coloured with the whole file as context. When the file no longer
 * has `text` there (changed since the search) or is too big, the line is
 * parsed on its own.
 */
export async function lineTokens({ path, line, col }: LineSource, text: string): Promise<CodeToken[]> {
  const language = languageForPath(path);
  if (!language || !text) return [];
  const source = editorsFor(path)[0]?.view.state.doc ?? (await readFileText(path).catch(() => null));
  if (source == null) return highlightTokens(text, language);
  let h = highlighted.get(path);
  if (h?.source !== source) {
    h = { source, parsed: parseWhole(source, language), lines: new Map() };
    highlighted.delete(path);
    highlighted.set(path, h);
    if (highlighted.size > 40) highlighted.delete(highlighted.keys().next().value!);
  }
  const key = lineKey(line, col, text);
  const known = h.lines.get(key);
  if (known) return known;
  const parsed = await h.parsed;
  let tokens: CodeToken[] | null = null;
  if (parsed && line < parsed.doc.lines) {
    const l = parsed.doc.line(line + 1);
    if (l.text.slice(col, col + text.length) === text) {
      const from = l.from + col;
      tokens = parsed.highlight(from, from + text.length).map((t) => ({ ...t, from: t.from - from, to: t.to - from }));
    }
  }
  tokens ??= await highlightTokens(text, language);
  h.lines.set(key, tokens);
  return tokens;
}

async function parseWhole(source: Text | string, language: string): Promise<Parsed | null> {
  if (source.length > MAX_PARSE) return null;
  const text = typeof source === "string" ? source : source.toString();
  const highlight = await codeHighlighter(text, language);
  if (!highlight) return null;
  // Splitting on "\n" alone keeps a "\r" in its line, so offsets match `text`.
  return { doc: typeof source === "string" ? Text.of(text.split("\n")) : source, highlight };
}

/** `lineTokens` for a rendered line; null until known (and without a `source`). */
export function useLineTokens(source: LineSource | undefined, text: string): CodeToken[] | null {
  const path = source?.path ?? null;
  const line = source?.line ?? 0;
  const col = source?.col ?? 0;
  const key = `${path}\u0000${line}\u0000${col}\u0000${text}`;
  const [loaded, setLoaded] = useState<{ key: string; tokens: CodeToken[] } | null>(null);
  useEffect(() => {
    if (path == null) return;
    let alive = true;
    void lineTokens({ path, line, col }, text).then((tokens) => {
      if (alive) setLoaded({ key, tokens });
    });
    return () => {
      alive = false;
    };
  }, [key, path, line, col, text]);
  if (path == null) return null;
  return loaded?.key === key ? loaded.tokens : peekLineTokens({ path, line, col }, text);
}

/**
 * `text` between `from` and `to` as spans with the tokens' `tok-*` classes
 * (styled by the caller); `key` prefixes the React keys.
 */
export function tokenSpans(
  text: string,
  from: number,
  to: number,
  tokens: readonly CodeToken[] | null,
  key = "",
): ReactNode[] {
  if (!tokens?.length) return [text.slice(from, to)];
  const out: ReactNode[] = [];
  let pos = from;
  for (const t of tokens) {
    if (t.to <= pos) continue;
    if (t.from >= to) break;
    const s = Math.max(t.from, pos);
    const e = Math.min(t.to, to);
    if (s > pos) out.push(text.slice(pos, s));
    out.push(
      <span key={`${key}${s}`} className={t.cls}>
        {text.slice(s, e)}
      </span>,
    );
    pos = e;
  }
  if (pos < to) out.push(text.slice(pos, to));
  return out;
}
