/**
 * Custom folding regions: `//region Name` … `//endregion`, `#region` (C#, Python…),
 * `<editor-fold desc="Name">` … `</editor-fold>`, in the language’s configured line or block comments.
 * The backend folds them; this names their placeholders and lists them for
 * Navigate › Custom Folding (⌥⌘.).
 */
import type { EditorState, Line } from "@codemirror/state";

export type RegionMarker = { start: true; name: string } | { start: false };

export interface RegionCommentTokens {
  line?: string;
  block?: { open: string; close: string };
}

const START = /^#?region\b\s*(.*)$/i;
const END = /^(?:#?endregion\b|<\/editor-fold\s*>$)/i;
const FOLD = /^<editor-fold\b([^>]*)>/i;
const DESC = /\bdesc\s*=\s*"([^"]*)"/i;

/** The region marker on a line of text, if it is one. */
export function regionMarker(line: string, tokens: RegionCommentTokens): RegionMarker | null {
  if (!/region|editor-fold/i.test(line)) return null;
  const text = line.trim();
  let body: string;
  if (/^#(?:end)?region\b/i.test(text)) {
    body = text;
  } else if (tokens.block && text.startsWith(tokens.block.open)) {
    body = text.slice(tokens.block.open.length).trimEnd();
    if (!body.endsWith(tokens.block.close)) return null;
    body = body.slice(0, -tokens.block.close.length);
    if (tokens.block.open === "/*") body = body.replace(/^\*+/, "");
  } else if (tokens.line && text.startsWith(tokens.line)) {
    body = text.slice(tokens.line.length);
    if (tokens.line === "//") body = body.replace(/^\/+/, "");
    if (tokens.line === ";") body = body.replace(/^;+/, "");
  } else {
    return null;
  }
  body = body.trim();
  if (/[\r\n]/.test(body)) return null;
  if (END.test(body)) return { start: false };
  const fold = FOLD.exec(body);
  if (fold) return { start: true, name: DESC.exec(fold[1]!)?.[1]?.trim() ?? "" };
  const region = START.exec(body);
  if (!region) return null;
  const name = region[1]!
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .trim();
  return { start: true, name };
}

export interface CustomRegion {
  name: string;
  /** 1-based lines of the start and end markers. */
  startLine: number;
  endLine: number;
}

/** The marker using the configured comment syntax at this line. */
export function regionMarkerAt(state: EditorState, line: Line): RegionMarker | null {
  const tokens = state.languageDataAt<RegionCommentTokens>("commentTokens", line.from)[0] ?? {};
  return regionMarker(line.text, tokens);
}

/** Every matched region, in document order of its start marker. */
export function customRegions(state: EditorState): CustomRegion[] {
  const doc = state.doc;
  const out: CustomRegion[] = [];
  const open: { name: string; line: number; index: number }[] = [];
  for (let n = 1; n <= doc.lines; n++) {
    const m = regionMarkerAt(state, doc.line(n));
    if (!m) continue;
    if (m.start) {
      open.push({ name: m.name, line: n, index: out.length });
      out.push({ name: m.name, startLine: n, endLine: -1 });
    } else {
      const s = open.pop();
      if (s) out[s.index]!.endLine = n;
    }
  }
  return out.filter((r) => r.endLine > 0);
}

/** The name of the region whose start marker begins at `pos` (a fold's start), for its placeholder. */
export function regionNameAt(state: EditorState, pos: number): string | null {
  const line = state.doc.lineAt(pos);
  if (state.sliceDoc(line.from, pos).trim()) return null;
  const m = regionMarkerAt(state, line);
  return m?.start && m.name ? m.name : null;
}
