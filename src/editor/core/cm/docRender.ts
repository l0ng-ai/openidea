/**
 * Doc comment → HTML, for rendered doc comments (`renderedDocs.ts`) and anything else that
 * wants a comment as prose.
 *
 * One path serves Javadoc, KDoc, JSDoc, PHPDoc and rustdoc: the body is handed to
 * the Markdown renderer, which passes the raw HTML of a Javadoc body (`<p>`, `<b>`,
 * `<code>`) straight through while rendering the Markdown of a KDoc or rustdoc one.
 * Inline tags (`{@code}`, `{@link}`…) and block tags (`@param`, `@return`…) are
 * ours to expand, and neither Markdown nor HTML knows them.
 *
 * Inline tags become placeholders before the Markdown runs and their HTML goes back
 * in afterwards: their text is code, not Markdown, and `{@code a_b_c}` must not come
 * out italicised. The HTML put back is built here from escaped text, so it is safe
 * although it never passes through the sanitizer.
 */

/** A doc comment's text, by the markers that open it. */
export type DocStyle = "block" | "line";

export interface DocComment {
  /** Document offset of the first character of the comment. */
  from: number;
  /** Document offset just past its last character. */
  to: number;
  style: DocStyle;
  /** The comment verbatim, markers included. */
  text: string;
}

/**
 * Block tags given their own section, in the order IDEA lists them. Named tags start
 * with what they document (`@param name`, `@throws Type`). Any other tag still shows,
 * after these, under its own name.
 */
const BLOCK_SECTIONS: Array<{ tag: string; title: string; named: boolean }> = [
  { tag: "param", title: "Params", named: true },
  { tag: "tparam", title: "Type params", named: true },
  { tag: "template", title: "Type params", named: true },
  { tag: "property", title: "Properties", named: true },
  { tag: "receiver", title: "Receiver", named: false },
  { tag: "constructor", title: "Constructor", named: false },
  { tag: "return", title: "Returns", named: false },
  { tag: "returns", title: "Returns", named: false },
  { tag: "throws", title: "Throws", named: true },
  { tag: "exception", title: "Throws", named: true },
  { tag: "see", title: "See also", named: false },
  { tag: "since", title: "Since", named: false },
  { tag: "author", title: "Author", named: false },
  { tag: "version", title: "Version", named: false },
  { tag: "deprecated", title: "Deprecated", named: false },
  { tag: "apiNote", title: "API Note", named: false },
  { tag: "implSpec", title: "Implementation Requirements", named: false },
  { tag: "implNote", title: "Implementation Note", named: false },
  { tag: "example", title: "Examples", named: false },
  { tag: "sample", title: "Samples", named: false },
];

const SECTION_BY_TAG = new Map(BLOCK_SECTIONS.map((s) => [s.tag, s]));

/** `@tag` at the start of a stripped line opens a block tag; `@` inside a sentence does not. */
const BLOCK_TAG = /^@(\w+)[ \t]*([\s\S]*)$/;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * The comment's content without its markers: the opening and closing ones, and the
 * leading `*` of each line, or the `///` of each line. The indent that follows a
 * marker is kept, so an indented code block inside the comment still is one.
 */
export function stripMarkers(text: string, style: DocStyle): string {
  const lines = text.split("\n");
  if (style === "line") {
    return lines.map((l) => l.replace(/^[ \t]*\/\/[/!][ \t]?/, "")).join("\n");
  }
  const body = lines.map((line, i) => {
    let l = line;
    if (i === 0) l = l.replace(/^[ \t]*\/\*+[ \t]?/, "");
    if (i === lines.length - 1) l = l.replace(/[ \t]*\*+\/[ \t]*$/, "");
    if (i > 0) l = l.replace(/^[ \t]*\*(?!\/)[ \t]?/, "");
    return l;
  });
  // A comment opening on its own line leaves a blank first line, and closing on its own a blank last one.
  while (body.length && !body[0]!.trim()) body.shift();
  while (body.length && !body.at(-1)!.trim()) body.pop();
  return body.join("\n");
}

export interface BlockTag {
  tag: string;
  /** The first word for `@param name text` and `@throws Type text`; null otherwise. */
  name: string | null;
  /** The type a JSDoc (`@param {number} a`) or PHPDoc (`@param int $a`) tag gives; null otherwise. */
  type: string | null;
  text: string;
}

/** A leading `{type}` (JSDoc), braces balanced, split from the rest of the tag's text. */
function leadingType(text: string): { type: string; rest: string } | null {
  if (!text.startsWith("{")) return null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return { type: text.slice(1, i).trim(), rest: text.slice(i + 1).trim() };
  }
  return null;
}

/** A tag's text after its name: JSDoc separates the two with ` - `, which is not part of it. */
const afterName = (text: string) => text.replace(/^-\s+/, "").trim();

/** Splits a named tag's text into what it documents, its type when given, and the rest. */
function namedTag(tag: string, text: string): Omit<BlockTag, "tag"> {
  const typed = leadingType(text);
  if (typed) {
    // `@throws {Error} when…`: the type is what the tag names.
    if (tag === "throws" || tag === "exception") {
      return { name: typed.type, type: null, text: afterName(typed.rest) };
    }
    const m = /^(\S+)\s*([\s\S]*)$/.exec(typed.rest);
    return { name: m?.[1] ?? null, type: typed.type, text: afterName(m?.[2] ?? "") };
  }
  // PHPDoc puts the type first and the variable second: `@param int $a`.
  const php = /^([^\s$]\S*)\s+(\$\S+)\s*([\s\S]*)$/.exec(text);
  if (php) return { name: php[2]!, type: php[1]!, text: afterName(php[3]!) };
  const m = /^(\S+)[ \t]*([\s\S]*)$/.exec(text);
  return { name: m?.[1] ?? null, type: null, text: afterName(m?.[2] ?? "") };
}

/** A code block's opening or closing line: a Markdown fence, or HTML `<pre>`. */
const FENCE = /^(```|~~~)/;

/** How the `<pre>` blocks a line opens and closes change the depth of code it leaves. */
function preDepthChange(line: string): number {
  return (line.match(/<pre[\s>]/gi)?.length ?? 0) - (line.match(/<\/pre>/gi)?.length ?? 0);
}

export interface DocBody {
  description: string;
  tags: BlockTag[];
}

/**
 * Splits the stripped body into its description and block tags. A tag's text runs
 * to the next block tag, so a `@param` may wrap over several lines.
 */
export function splitBody(body: string): DocBody {
  const lines = body.split("\n");
  const description: string[] = [];
  const tags: BlockTag[] = [];
  let current: { tag: string; lines: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const section = SECTION_BY_TAG.get(current.tag);
    const text = current.lines.join("\n").trim();
    if (section?.named) {
      tags.push({ tag: current.tag, ...namedTag(current.tag, text) });
    } else {
      // `@returns {string} the name`: JSDoc types the value too.
      const typed = leadingType(text);
      tags.push({
        tag: current.tag,
        name: null,
        type: typed?.type ?? null,
        text: typed ? afterName(typed.rest) : text,
      });
    }
    current = null;
  };
  // Inside a code block, a line starting with `@` is code (`@Override`), not a block tag.
  let fenced = false;
  let pre = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    const m = fenced || pre > 0 ? null : BLOCK_TAG.exec(trimmed);
    if (FENCE.test(trimmed)) fenced = !fenced;
    pre = Math.max(0, pre + preDepthChange(line));
    if (m) {
      flush();
      current = { tag: m[1]!, lines: [m[2] ?? ""] };
    } else if (current) {
      current.lines.push(line);
    } else {
      description.push(line);
    }
  }
  flush();
  return { description: description.join("\n").trim(), tags };
}

/** The label an inline tag shows: `{@link Foo#bar(int) the label}` shows the label when it has one. */
function linkLabel(body: string): string {
  const trimmed = body.trim();
  const space = /\s/.exec(trimmed);
  if (!space) return trimmed;
  const target = trimmed.slice(0, space.index);
  const label = trimmed.slice(space.index).trim();
  return label || target;
}

/**
 * Replaces each `{@tag …}` with a placeholder, collecting the HTML it stands for.
 * Nesting is counted so `{@code Map<K, {@literal V}>}` ends at the right brace.
 */
export function extractInlineTags(text: string): { text: string; html: string[] } {
  const html: string[] = [];
  let out = "";
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf("{@", i);
    if (start < 0) {
      out += text.slice(i);
      break;
    }
    const m = /^\{@(\w+)[ \t]*/.exec(text.slice(start));
    if (!m) {
      out += text.slice(i, start + 2);
      i = start + 2;
      continue;
    }
    let depth = 1;
    let j = start + m[0].length;
    for (; j < text.length && depth > 0; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") depth--;
    }
    if (depth > 0) {
      // Unclosed: leave it as written rather than swallowing the rest of the comment.
      out += text.slice(i);
      break;
    }
    out += text.slice(i, start);
    out += placeholder(html.length);
    html.push(inlineTagHtml(m[1]!, text.slice(start + m[0].length, j - 1)));
    i = j;
  }
  return { text: out, html };
}

/**
 * U+E000 is in the private use area: no comment contains it, and Markdown leaves it
 * alone. The digits are delimited so `…0…` and `…01…` cannot be confused.
 */
function placeholder(index: number): string {
  return `${index}`;
}

const PLACEHOLDER = /(\d+)/g;

function inlineTagHtml(tag: string, body: string): string {
  switch (tag) {
    case "code":
    case "systemProperty":
      return `<code>${escapeHtml(body)}</code>`;
    case "literal":
      return escapeHtml(body);
    case "link":
    case "linkplain":
      return `<code class="cm-openidea-docLink">${escapeHtml(linkLabel(body))}</code>`;
    case "value":
      return `<code>${escapeHtml(linkLabel(body))}</code>`;
    case "inheritDoc":
      return "";
    default:
      return escapeHtml(body);
  }
}

/** Puts the inline tags' HTML back where their placeholders are. */
export function restoreInlineTags(html: string, tags: string[]): string {
  return html.replace(PLACEHOLDER, (all, index: string) => tags[Number(index)] ?? all);
}

export interface RenderedDoc {
  /** The description, as HTML. */
  description: string;
  /**
   * One entry per block-tag section: those of `BLOCK_SECTIONS` in its order, then any
   * other tag in the order it comes, titled by the tag as written (`@hide`), which is
   * code and is not translated.
   */
  sections: Array<{
    title: string;
    translate: boolean;
    rows: Array<{ name: string | null; type: string | null; html: string }>;
  }>;
}

/**
 * Whether `comment` has anything to render, without rendering it: `renderDoc` returns
 * null exactly when it has neither text nor tags. Cheap enough to ask of every comment
 * in a file, which rendering is not.
 */
export function hasContent(comment: string, style: DocStyle): boolean {
  const { description, tags } = splitBody(stripMarkers(comment, style));
  return description.trim() !== "" || tags.length > 0;
}

/**
 * Renders `comment` with `markdown`, the Markdown-to-safe-HTML function (so this
 * module stays free of the parser and its 40 KB). Returns null when the comment
 * carries nothing to show.
 */
export function renderDoc(comment: string, style: DocStyle, markdown: (md: string) => string): RenderedDoc | null {
  const { description, tags } = splitBody(stripMarkers(comment, style));
  const render = (text: string) => {
    if (!text.trim()) return "";
    const extracted = extractInlineTags(text);
    return restoreInlineTags(markdown(extracted.text), extracted.html);
  };
  const descriptionHtml = render(description);
  const sections: RenderedDoc["sections"] = [];
  const row = (t: BlockTag) => ({ name: t.name, type: t.type, html: render(t.text) });
  for (const section of BLOCK_SECTIONS) {
    const rows = tags.filter((t) => t.tag === section.tag).map(row);
    if (!rows.length) continue;
    // `@return` and `@returns` are the same section: extend the one already there.
    const existing = sections.find((s) => s.translate && s.title === section.title);
    if (existing) existing.rows.push(...rows);
    else sections.push({ title: section.title, translate: true, rows });
  }
  for (const t of tags) {
    if (SECTION_BY_TAG.has(t.tag)) continue;
    const title = `@${t.tag}`;
    const existing = sections.find((s) => !s.translate && s.title === title);
    if (existing) existing.rows.push(row(t));
    else sections.push({ title, translate: false, rows: [row(t)] });
  }
  if (!descriptionHtml && !sections.length) return null;
  return { description: descriptionHtml, sections };
}
