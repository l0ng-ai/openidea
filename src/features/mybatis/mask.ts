/**
 * Masking for the MyBatis mappers: a same-length copy of the source with the
 * comment and string ranges blanked out, so structural scanning (interface
 * declarations, XML tags) can use plain regexes without ever matching inside a
 * comment, a SQL string or a CDATA block.
 *
 * Two producers feed the same shape. Open editors take their ranges from
 * `literalRanges` (the Lezer tree, or the backend's tree-sitter highlights for
 * languages without a CodeMirror mode), so the active mapper is masked by the
 * IDE's own grammar and needs no second parser. Files that are not open — the
 * project index — fall back to the local scanners below, which only have to
 * tell comments, strings and CDATA apart from markup.
 *
 * Blanking keeps every character position and every line break, so offsets in
 * the mask are offsets in the original: read structure from the mask, content
 * from the original.
 */
import type { LiteralRange } from "@/editor/core/cm/literals";

/** Half-open `[from, to)` pair, in UTF-16 offsets of the same text. */
export type MaskRange = readonly [from: number, to: number];

/** Comment or string spans of a text, sorted and non-overlapping. */
export type MaskSource = readonly MaskRange[];

/** `text` with every `ranges` span replaced by spaces, newlines preserved. */
export function blankOut(text: string, ranges: MaskSource): string {
  if (!ranges.length) return text;
  const out = text.split("");
  for (const [from, to] of ranges) {
    for (let i = from; i < to && i < out.length; i++) {
      const c = out[i]!;
      if (c !== "\n" && c !== "\r") out[i] = " ";
    }
  }
  return out.join("");
}

/** Literal ranges of an open document, in the shape the scanners expect. */
export function rangesFromLiterals(literals: readonly LiteralRange[]): MaskSource {
  return literals.map((l) => [l.from, l.to] as MaskRange);
}

/** 0-based line of `offset`, counting the line breaks before it. */
export function lineAt(text: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

/** 0-based UTF-16 column of `offset` inside its line. */
export function colAt(text: string, offset: number): number {
  const at = Math.min(offset, text.length);
  let i = at - 1;
  while (i >= 0 && text[i] !== "\n") i--;
  return at - i - 1;
}

/**
 * Spans of the `spans` delimiters that are not inside another span. Used for
 * Java: `//`, `/* *\/`, `"""text blocks"""`, `"..."`, `'c'`.
 */
export function scanJava(text: string): MaskSource {
  return scanSpans(text, [
    { open: "//" },
    { open: "/*", close: "*/" },
    { open: '"""', close: '"""', escaped: true },
    { open: '"', close: '"', stopAtNewline: true, escaped: true },
    { open: "'", close: "'", stopAtNewline: true, escaped: true },
  ]);
}

/**
 * Comments, CDATA blocks and attribute values of an XML text.
 *
 * Quotes are only masked *inside a tag*: SQL bodies are full of apostrophes
 * (`WHERE name = 'x'`, `don't`) and masking them as string literals would hide
 * every tag until the end of the line, including the element's own close tag.
 */
export function scanXml(text: string): MaskSource {
  const out: MaskRange[] = [];
  for (let i = 0; i < text.length;) {
    const block = matchBlock(text, i, "<!--", "-->") ?? matchBlock(text, i, "<![CDATA[", "]]>");
    if (block) {
      out.push(block);
      i = block[1];
      continue;
    }
    if (text[i] === "<") {
      const end = tagEnd(text, i);
      if (end > 0) {
        maskAttributes(text, i, end, out);
        i = end;
        continue;
      }
    }
    i++;
  }
  return out;
}

/** The span of a block comment opened at `from`, running to the end when unterminated. */
function matchBlock(text: string, from: number, open: string, close: string): MaskRange | null {
  if (!text.startsWith(open, from)) return null;
  const end = text.indexOf(close, from + open.length);
  return [from, end < 0 ? text.length : end + close.length];
}

/** Offset just past the `>` of the tag starting at `from`, or -1 when malformed. */
function tagEnd(text: string, from: number): number {
  for (let i = from + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const close = text.indexOf(c, i + 1);
      if (close < 0) return -1;
      i = close;
    } else if (c === ">") return i + 1;
    // A second `<` before any `>` means the previous tag was never closed.
    else if (c === "<") return -1;
  }
  return -1;
}

/** Masks every quoted attribute value between `from` and `end` (the tag span). */
function maskAttributes(text: string, from: number, end: number, out: MaskRange[]): void {
  for (let i = from; i < end; i++) {
    const c = text[i];
    if (c !== '"' && c !== "'") continue;
    const close = text.indexOf(c, i + 1);
    if (close < 0 || close >= end) continue;
    out.push([i, close + 1]);
    i = close;
  }
}

/**
 * A masked span from `open` to `close`. No `close` means a line comment: it
 * ends at the next newline, or at the end of the text. `stopAtNewline` marks a
 * ends at the next newline, or at the end of the text. `stopAtNewline` marks a
 * span that cannot legally cross a line break (a Java string literal): an
 * unterminated one ends at the newline instead of swallowing the rest of the
 * file, while an unterminated block comment runs on. `escaped` marks a span
 * whose closing delimiter can be backslash-escaped.
 */
interface SpanDef {
  open: string;
  close?: string;
  stopAtNewline?: boolean;
  escaped?: boolean;
}

/**
 * Delimiter scan, first opener wins in list order: put `"""` before `"` and
 * `<![CDATA[` before `<!--` so the longer form matches, and let a `//` inside a
 * string stay part of the string because the string consumed it first.
 */
function scanSpans(text: string, spans: readonly SpanDef[]): MaskSource {
  const out: MaskRange[] = [];
  for (let i = 0; i < text.length;) {
    const span = spans.find((s) => text.startsWith(s.open, i));
    if (!span) {
      i++;
      continue;
    }
    const body = i + span.open.length;
    const nl = text.indexOf("\n", body);
    let to: number;
    if (span.close === undefined) to = nl < 0 ? text.length : nl;
    else {
      const end = indexOfClose(text, span.close, body, span.escaped === true);
      if (end < 0) to = span.stopAtNewline && nl >= 0 ? nl : text.length;
      else if (span.stopAtNewline && nl >= 0 && nl < end) to = nl;
      else to = end + span.close.length;
    }
    out.push([i, to]);
    i = Math.max(to, body);
  }
  return out;
}

/** Offset of the next `close` at or after `from`, ignoring an escaped one. */
function indexOfClose(text: string, close: string, from: number, escapes: boolean): number {
  for (let i = text.indexOf(close, from); i >= 0; i = text.indexOf(close, i + 1)) {
    if (!escapes) return i;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) backslashes++;
    if (backslashes % 2 === 0) return i;
  }
  return -1;
}
