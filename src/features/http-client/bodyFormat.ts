/**
 * Reformat Code in `.http` files: JSON request bodies are re-indented. `{{variables}}` and
 * number literals stay as written, so a body that is only JSON once its variables are
 * substituted is formatted too.
 */
import { getIndentUnit } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { ContributedFormatter } from "@/editor/api";

interface Block {
  /** 0-based request line. */
  line: number;
  /** 0-based last line of the block (inclusive). */
  endLine: number;
}

type Token = { kind: "punct"; text: "{" | "}" | "[" | "]" | ":" | "," } | { kind: "value"; text: string };

/** Values (strings, numbers, literals, `{{variables}}`) and punctuation; `null` when it can't be JSON. */
function tokenize(text: string): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (text.startsWith("{{", i)) {
      const end = text.indexOf("}}", i + 2);
      if (end < 0) return null;
      // A variable glued to more text (`{{base}}-1`) stays one value.
      let j = end + 2;
      while (j < text.length && !/[\s{}[\]:,"]/.test(text[j]!)) j++;
      out.push({ kind: "value", text: text.slice(i, j) });
      i = j;
    } else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (j >= text.length) return null;
      out.push({ kind: "value", text: text.slice(i, j + 1) });
      i = j + 1;
    } else if ("{}[]:,".includes(c)) {
      out.push({ kind: "punct", text: c as "{" });
      i++;
    } else {
      let j = i;
      while (j < text.length && !/[\s{}[\]:,"]/.test(text[j]!)) j++;
      const word = text.slice(i, j);
      if (!/^(-?\d|true$|false$|null$)/.test(word)) return null;
      out.push({ kind: "value", text: word });
      i = j;
    }
  }
  return out;
}

/** `text` as indented JSON (empty `{}` / `[]` stay inline), or `null` when it isn't one JSON value. */
export function formatJsonBody(text: string, indent: string): string | null {
  const tokens = tokenize(text);
  if (!tokens?.length) return null;
  let i = 0;
  const value = (depth: number): string | null => {
    const t = tokens[i++];
    if (!t) return null;
    if (t.kind === "value") return t.text;
    if (t.text !== "{" && t.text !== "[") return null;
    const object = t.text === "{";
    const close = object ? "}" : "]";
    if (tokens[i]?.text === close) {
      i++;
      return object ? "{}" : "[]";
    }
    const pad = indent.repeat(depth + 1);
    const items: string[] = [];
    for (;;) {
      let key = "";
      if (object) {
        const k = tokens[i++];
        if (k?.kind !== "value" || tokens[i++]?.text !== ":") return null;
        key = `${k.text}: `;
      }
      const v = value(depth + 1);
      if (v === null) return null;
      items.push(pad + key + v);
      const sep = tokens[i++];
      if (sep?.text === close) break;
      if (sep?.text !== ",") return null;
    }
    return `${t.text}\n${items.join(",\n")}\n${indent.repeat(depth)}${close}`;
  };
  const out = value(0);
  return out !== null && i === tokens.length ? out : null;
}

const HANDLER_OR_INPUT = /^(> \{%|<>|>>|> |< )/;

/** The body lines of the request at `block`: after its headers, up to a response handler or reference. */
function bodyRange(state: EditorState, block: Block): { from: number; to: number; json: boolean } | null {
  const doc = state.doc;
  const last = Math.min(block.endLine + 1, doc.lines);
  let n = block.line + 2;
  // Indented query continuation lines, then headers up to the first blank line.
  while (n <= last && /^[ \t]+[?&/]/.test(doc.line(n).text)) n++;
  let contentType: string | null = null;
  for (; n <= last; n++) {
    const text = doc.line(n).text;
    if (!text.trim()) break;
    const m = /^([^\s:]+)\s*:(.*)$/.exec(text);
    if (m && m[1]!.toLowerCase() === "content-type") contentType = m[2]!.trim().toLowerCase();
  }
  let first = 0;
  let end = 0;
  for (n++; n <= last; n++) {
    const text = doc.line(n).text;
    if (HANDLER_OR_INPUT.test(text.trimStart())) break;
    if (!text.trim()) continue;
    if (!first) first = n;
    end = n;
  }
  if (!first) return null;
  const json = contentType === null || contentType.includes("json");
  return { from: doc.line(first).from, to: doc.line(end).to, json };
}

/** Reformat Code for the JSON bodies of `blocks` that overlap `range` (all when `null`). */
export function httpBodyFormatter(blocks: (state: EditorState) => readonly Block[]): ContributedFormatter {
  return (state, range) => {
    const indent = " ".repeat(getIndentUnit(state));
    const changes: Array<{ from: number; to: number; insert: string }> = [];
    for (const block of blocks(state)) {
      const body = bodyRange(state, block);
      if (!body?.json || (range && (body.to < range.from || body.from > range.to))) continue;
      const text = state.sliceDoc(body.from, body.to);
      if (!/^[{[]/.test(text.trimStart())) continue;
      const formatted = formatJsonBody(text, indent);
      if (formatted !== null && formatted !== text) changes.push({ from: body.from, to: body.to, insert: formatted });
    }
    return changes;
  };
}
