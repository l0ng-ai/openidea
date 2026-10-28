/**
 * Custom folding regions: `//region Name` … `//endregion`, `#region` (C#, Python…),
 * `<editor-fold desc="Name">` … `</editor-fold>`, in any line comment style.
 * The backend folds them; this names their placeholders and lists them for
 * Navigate › Custom Folding (⌥⌘.).
 */
import type { EditorState, Text } from "@codemirror/state";

export type RegionMarker = { start: true; name: string } | { start: false };

const COMMENT_START = /^\s*(?:\/\/+|\/\*+|#|--|;+|%|<!--|')?\s*/;
const START = /^#?region\b\s*(.*)$/i;
const END = /^(?:#?endregion\b|<\/editor-fold\s*>)/i;
const FOLD = /^<editor-fold\b([^>]*)>/i;
const DESC = /\bdesc\s*=\s*"([^"]*)"/i;

/** The region marker on a line of text, if it is one. */
export function regionMarker(line: string): RegionMarker | null {
  if (!/region|editor-fold/i.test(line)) return null;
  const body = line.replace(COMMENT_START, "").trimEnd();
  if (END.test(body)) return { start: false };
  const fold = FOLD.exec(body);
  if (fold) return { start: true, name: DESC.exec(fold[1]!)?.[1]?.trim() ?? "" };
  const region = START.exec(body);
  if (!region) return null;
  const name = region[1]!
    .replace(/\s*(?:\*\/|-->)\s*$/, "")
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

/** Every matched region of `doc`, in document order of their start markers. */
export function customRegions(doc: Text): CustomRegion[] {
  const out: CustomRegion[] = [];
  const open: { name: string; line: number; index: number }[] = [];
  for (let n = 1; n <= doc.lines; n++) {
    const m = regionMarker(doc.line(n).text);
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
  const m = regionMarker(line.text);
  return m?.start && m.name ? m.name : null;
}
