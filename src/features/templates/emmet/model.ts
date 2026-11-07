/**
 * Emmet, as in IDEA's Settings › Editor › Emmet: abbreviation expansion
 * (`ul>li.item*3` + Tab) in HTML-like and stylesheet files, and "Update Tag
 * with Emmet" on the enclosing tag. Pure functions over document text; the
 * editor glue lives in `./editor`.
 */
import type { UserConfig } from "emmet";

type Emmet = typeof import("emmet");
let emmet: Emmet | null = null;
let loading: Promise<Emmet> | null = null;

/** Loads the Emmet engine, kept out of start-up; expansion finds nothing until it has. */
export function loadEmmet(): Promise<Emmet> {
  return (loading ??= import("emmet").then(
    (m) => (emmet = m),
    (e: unknown) => {
      loading = null;
      throw e;
    },
  ));
}

export interface EmmetSyntax {
  type: "markup" | "stylesheet";
  syntax: string;
}

/** Languages with markup expansion; `<style>` / `<script>` regions are handled. */
const MARKUP_LANGUAGES = new Set(["html", "vue", "svelte"]);
const STYLESHEET_LANGUAGES: Record<string, string> = { css: "css", scss: "scss", less: "less", sass: "sass" };

/** Whether `language` files expand Emmet abbreviations. */
export const hasEmmet = (language: string) => MARKUP_LANGUAGES.has(language) || language in STYLESHEET_LANGUAGES;

/** Text before the caret that is scanned for context. */
const CONTEXT_LIMIT = 200_000;

function lastMatch(text: string, re: RegExp): number {
  let at = -1;
  for (const m of text.matchAll(re)) at = m.index;
  return at;
}

/** Inside an unclosed `<tag` of `before` (`<tag>` contents excluded). */
function openRegion(before: string, tag: string): RegExpMatchArray | null {
  const open = lastMatch(before, new RegExp(`<${tag}\\b`, "gi"));
  if (open < 0 || open < lastMatch(before, new RegExp(`</${tag}\\b`, "gi"))) return null;
  const head = /^<\w+\b((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(before.slice(open));
  return head;
}

function stylesheetContext(before: string): boolean {
  // Not in a comment, inside a rule, at the start of a declaration.
  if (lastMatch(before, /\/\*/g) > lastMatch(before, /\*\//g)) return false;
  let depth = 0;
  for (const c of before.replace(/"[^"\n]*"|'[^'\n]*'/g, "")) {
    if (c === "{") depth++;
    else if (c === "}") depth = Math.max(0, depth - 1);
  }
  return depth > 0;
}

/** The Emmet syntax at the end of `before` (text up to the caret) in a `language` file, or null for none. */
export function syntaxAt(language: string, before: string): EmmetSyntax | null {
  const text = before.length > CONTEXT_LIMIT ? before.slice(-CONTEXT_LIMIT) : before;
  const css = STYLESHEET_LANGUAGES[language];
  if (css) return stylesheetContext(text) ? { type: "stylesheet", syntax: css } : null;
  if (!MARKUP_LANGUAGES.has(language)) return null;
  if (lastMatch(text, /<!--/g) > lastMatch(text, /-->/g)) return null;
  if (openRegion(text, "script")) return null;
  const style = openRegion(text, "style");
  if (style) {
    const lang = /\blang\s*=\s*["']?(\w+)/i.exec(style[1] ?? "")?.[1]?.toLowerCase();
    const inner = text.slice(lastMatch(text, /<style\b/gi) + style[0].length);
    return stylesheetContext(inner) ? { type: "stylesheet", syntax: STYLESHEET_LANGUAGES[lang ?? ""] ?? "css" } : null;
  }
  // Not inside a tag (`<div cla|`).
  if (text.lastIndexOf("<") > text.lastIndexOf(">")) return null;
  return { type: "markup", syntax: "html" };
}

/** CodeMirror snippet fields (`${1:name}`) for Emmet's tab stops. */
function field(index: number, placeholder: string): string {
  const p = placeholder.replace(/[{}\\]/g, (c) => `\\${c}`);
  return p ? `\${${index}:${p}}` : `\${${index}}`;
}

/** Escapes text so CodeMirror's snippet parser leaves it as is. */
function escapeSnippet(text: string): string {
  return text.replace(/[$#]\{/g, (m) => `${m[0]}\\{`);
}

function config(syntax: EmmetSyntax, fields: boolean): UserConfig {
  return {
    type: syntax.type,
    syntax: syntax.syntax,
    options: {
      "output.field": fields ? field : () => "",
      "output.text": fields ? escapeSnippet : (t: string) => t,
      // Snippets turn leading tabs into the editor's indent unit.
      "output.indent": "\t",
    },
  };
}

export interface Expansion {
  /** Offsets in the line text. */
  from: number;
  to: number;
  /** CodeMirror snippet template. */
  snippet: string;
}

/** The abbreviation ending at `col` of `line` expanded, or null when there is none. */
export function expandAt(line: string, col: number, syntax: EmmetSyntax): Expansion | null {
  if (!emmet) {
    void loadEmmet().catch(() => {});
    return null;
  }
  const found = emmet.extract(line, col, { type: syntax.type, lookAhead: true });
  if (!found || !found.abbreviation.trim()) return null;
  const abbr = found.abbreviation;
  // A bare number or a closing-tag fragment is never meant as an abbreviation.
  if (/^\d/.test(abbr) || abbr.startsWith("/")) return null;
  let snippet: string;
  try {
    snippet = emmet.default(abbr, config(syntax, true));
  } catch {
    return null;
  }
  // Stylesheets: unknown words expand to themselves (`foo` → `foo: ;`) or nothing.
  if (!snippet || (syntax.type === "stylesheet" && !/[:;]/.test(snippet))) return null;
  return { from: found.start, to: found.end, snippet };
}

// ---------------------------------------------------------------------------
// Update Tag with Emmet

interface Attr {
  name: string;
  /** null for a boolean attribute. */
  value: string | null;
}

export interface TagRange {
  name: string;
  /** Start tag `<…>` offsets. */
  from: number;
  to: number;
  attrs: Attr[];
  selfClosing: boolean;
  /** Name offsets of the matching end tag. */
  close: { from: number; to: number } | null;
}

const VOID = new Set("area base br col embed hr img input link meta param source track wbr".split(" "));
const TAG_RE = /<!--[\s\S]*?-->|<(\/?)([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
const ATTR_RE = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

export function parseAttrs(text: string): Attr[] {
  return [...text.matchAll(ATTR_RE)].map((m) => ({ name: m[1]!, value: m[2] ?? m[3] ?? m[4] ?? null }));
}

/** The innermost element whose start tag, content or end tag contains `pos`. */
export function enclosingTag(text: string, pos: number): TagRange | null {
  const stack: TagRange[] = [];
  let best: TagRange | null = null;
  const finish = (tag: TagRange, end: number) => {
    if (tag.from <= pos && pos <= end && (!best || tag.from > best.from)) best = tag;
  };
  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(text); m; m = TAG_RE.exec(text)) {
    const name = m[2];
    if (!name) continue;
    const from = m.index;
    const to = from + m[0].length;
    if (m[1]) {
      const i = stack.map((t) => t.name.toLowerCase()).lastIndexOf(name.toLowerCase());
      if (i < 0) continue;
      // Unclosed elements end where their parent does.
      for (const open of stack.splice(i + 1)) finish(open, from);
      const open = stack.pop()!;
      open.close = { from: from + 2, to: from + 2 + name.length };
      finish(open, to);
      continue;
    }
    if (from > pos && !stack.some((t) => t.from <= pos)) break;
    const tag: TagRange = { name, from, to, attrs: parseAttrs(m[3] ?? ""), selfClosing: !!m[4], close: null };
    if (tag.selfClosing || VOID.has(name.toLowerCase())) {
      finish(tag, to);
      continue;
    }
    stack.push(tag);
    // Raw text: skip to the end tag.
    if (/^(script|style|textarea|title)$/i.test(name)) {
      const end = text.slice(to).search(new RegExp(`</${name}\\b`, "i"));
      if (end >= 0) TAG_RE.lastIndex = to + end;
    }
  }
  for (const open of stack) finish(open, text.length);
  return best;
}

export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

/**
 * Edits applying `abbreviation` to `tag`: a leading name renames the element
 * (start and end tag), `.class` adds classes, `#id` and `[attr=value]` set attributes.
 * Null when the abbreviation is not a single element.
 */
export function updateTagEdits(tag: TagRange, abbreviation: string): TextEdit[] | null {
  const abbr = abbreviation.trim();
  if (!abbr || /[>+^*{]/.test(abbr.replace(/\[[^\]]*\]/g, ""))) return null;
  if (!emmet) return null;
  let html: string;
  try {
    html = emmet.default(abbr, config({ type: "markup", syntax: "html" }, false));
  } catch {
    return null;
  }
  const m = /^<([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)\/?>/.exec(html);
  if (!m) return null;
  const name = /^[A-Za-z]/.test(abbr) ? m[1]! : tag.name;
  const attrs = tag.attrs.map((a) => ({ ...a }));
  for (const a of parseAttrs(m[2] ?? "")) {
    const old = attrs.find((x) => x.name.toLowerCase() === a.name.toLowerCase());
    if (!old) attrs.push(a);
    else if (a.name.toLowerCase() === "class" && old.value) {
      const have = old.value.split(/\s+/).filter(Boolean);
      old.value = [...have, ...(a.value ?? "").split(/\s+/).filter((c) => c && !have.includes(c))].join(" ");
    } else old.value = a.value;
  }
  const quote = (v: string) => (v.includes('"') ? `'${v}'` : `"${v}"`);
  const attrText = attrs.map((a) => (a.value === null ? ` ${a.name}` : ` ${a.name}=${quote(a.value)}`)).join("");
  const edits: TextEdit[] = [
    { from: tag.from, to: tag.to, insert: `<${name}${attrText}${tag.selfClosing ? " /" : ""}>` },
  ];
  if (tag.close && name !== tag.name) edits.push({ from: tag.close.from, to: tag.close.to, insert: name });
  return edits;
}
