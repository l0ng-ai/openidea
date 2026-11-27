/**
 * Astro components: a TypeScript frontmatter between `---` fences
 * (`astro.grammar`), then an HTML template whose `{…}` expressions, in text
 * and in tags, are TSX. `<script>` is TypeScript, as Astro compiles it.
 */
import { LRLanguage, LanguageSupport } from "@codemirror/language";
import { html } from "@codemirror/lang-html";
import { tsxLanguage, typescriptLanguage } from "@codemirror/lang-javascript";
import { styleTags, tags as t } from "@lezer/highlight";
import { IterMode, parseMixed, type Input, type NestedParse, type SyntaxNodeRef } from "@lezer/common";
import { JS_TAGS } from "../jsTags";
import { parser } from "./parser";

const tsParser = typescriptLanguage.parser.configure({ props: [styleTags(JS_TAGS)] });
const tsxParser = tsxLanguage.parser.configure({ props: [styleTags(JS_TAGS)] });

// To reuse old inner trees, parseMixed takes those that the node at a mount's
// start and its ancestors had with the same parser. So each kind of mount has
// its own instance (see angular/index.ts).
const documentTextParser = tsxParser.configure({}),
  elementTextParser = tsxParser.configure({}),
  tagParser = tsxParser.configure({});

const templateHTML = html({
  selfClosingTags: true,
  // Other script types (`application/ld+json`) keep HTML's own nesting.
  nestedLanguages: [{ tag: "script", attrs: (a) => !a.type || a.type === "module", parser: tsParser }],
});

const BRACE_L = 123,
  BRACE_R = 125,
  BACKSLASH = 92,
  QUOTES = new Set([34, 39, 96]);

type Range = { from: number; to: number };

/** Where a scan of expression braces stands between two pieces of text. */
type Scan = { depth: number; quote: number };

function pushRange(out: Range[], from: number, to: number) {
  const last = out[out.length - 1];
  if (last && last.to === from) last.to = to;
  else out.push({ from, to });
}

/**
 * Appends to `out` the parts of `text`, which starts at `from`, inside `{…}`,
 * braces included. Strings count only inside braces, so prose apostrophes
 * stay text; in a tag (`attrQuotes`), quotes outside braces delimit attribute
 * values, whose braces are literal.
 */
function scanBraces(text: string, from: number, scan: Scan, out: Range[], attrQuotes = false) {
  let start = scan.depth > 0 ? 0 : -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (scan.quote) {
      if (ch === BACKSLASH && scan.depth > 0) i++;
      else if (ch === scan.quote) scan.quote = 0;
    } else if (QUOTES.has(ch) && (scan.depth > 0 || attrQuotes)) {
      scan.quote = ch;
    } else if (ch === BRACE_L) {
      if (scan.depth++ === 0) start = i;
    } else if (ch === BRACE_R && scan.depth > 0 && --scan.depth === 0) {
      pushRange(out, from + start, from + i + 1);
      start = -1;
    }
  }
  if (scan.depth > 0 && start >= 0) pushRange(out, from + start, from + text.length);
}

/**
 * Nodes of an element's own text. Markup inside an expression splits it into
 * several (`{ok && <b>yes</b>}`), and HTML reads `&&` as entities and the
 * fragment brackets `<>`, `</>` as incomplete tags.
 */
const TEXT_NODES = new Set([
  "Text",
  "EntityReference",
  "CharacterReference",
  "InvalidEntity",
  "IncompleteTag",
  "IncompleteCloseTag",
]);

/** The expressions in the text directly in `node`, `null` without any. */
function textExpressions(node: SyntaxNodeRef, input: Input): Range[] | null {
  const out: Range[] = [];
  const scan: Scan = { depth: 0, quote: 0 };
  const child = node.node.cursor(IterMode.IgnoreMounts);
  if (child.firstChild()) {
    do {
      if (TEXT_NODES.has(child.name)) scanBraces(input.read(child.from, child.to), child.from, scan, out);
    } while (child.nextSibling());
  }
  return out.length ? out : null;
}

/** The expressions in a tag: values, shorthands and spreads, also with spaces, which split HTML attributes. */
function tagExpressions(node: SyntaxNodeRef, input: Input): Range[] | null {
  const out: Range[] = [];
  scanBraces(input.read(node.from, node.to), node.from, { depth: 0, quote: 0 }, out, true);
  return out.length ? out : null;
}

const TAGS = new Set(["OpenTag", "SelfClosingTag", "OpenScriptTag", "OpenStyleTag", "OpenTextareaTag"]);

function mixExpressions(node: SyntaxNodeRef, input: Input): NestedParse | null {
  if (TAGS.has(node.name)) {
    const overlay = tagExpressions(node, input);
    return overlay && { parser: tagParser, overlay };
  }
  if (node.name === "Document" || node.name === "Element") {
    const overlay = textExpressions(node, input);
    return overlay && { parser: node.name === "Document" ? documentTextParser : elementTextParser, overlay };
  }
  return null;
}

const templateParser = (templateHTML.language as LRLanguage).parser.configure({ wrap: parseMixed(mixExpressions) });

const componentParser = parser.configure({
  props: [styleTags({ FrontmatterFence: t.processingInstruction })],
  wrap: parseMixed((node) => {
    if (node.name === "FrontmatterScript") return { parser: tsParser };
    if (node.name === "Template") return { parser: templateParser };
    return null;
  }),
});

export const astroLanguage = LRLanguage.define({ name: "astro", parser: componentParser });

export function astro(): LanguageSupport {
  return new LanguageSupport(astroLanguage, [templateHTML.support]);
}
