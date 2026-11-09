import { defineLanguageFacet, Language, languageDataProp } from "@codemirror/language";
import { type Input, NodeSet, NodeType, Parser, type PartialParse, Tree } from "@lezer/common";
import { styleTags, tags as t } from "@lezer/highlight";

// A flat token list instead of a StreamLanguage: an underlined section title is
// only known from the line after it, and stream modes cannot look ahead.
const STYLES = {
  heading: t.heading,
  strong: t.strong,
  emphasis: t.emphasis,
  monospace: t.monospace,
  role: t.keyword,
  interpreted: t.string,
  link: t.link,
  url: t.url,
  substitution: t.special(t.variableName),
  field: t.attributeName,
  label: t.labelName,
  directive: t.keyword,
  comment: t.comment,
};
type Style = keyof typeof STYLES;
const NAMES = ["Document", ...Object.keys(STYLES)];
const data = defineLanguageFacet({ commentTokens: { line: ".." } });
const nodeSet = new NodeSet(
  NAMES.map((name, id) =>
    NodeType.define({ id, name, top: id === 0, props: id === 0 ? [[languageDataProp, data]] : [] }),
  ),
).extend(styleTags(STYLES));

/** An indented body (after `::`, a code directive or `..`) lasting while lines are indented past `base`. */
type Block = { kind: "literal" | "code" | "comment"; base: number; options: boolean };

const ADORNMENT = /^([!-/:-@[-`{-~])\1*\s*$/;
const CODE_DIRECTIVES = new Set(["code", "code-block", "sourcecode"]);
// Lines docutils reads as another body element before trying a title.
const BODY_ELEMENT = /^(?:\.\.|__|[-*+•]|>>>|\|)(?:\s|$)|^:[^:\s][^:]*:(?:\s|$)/;
// Inline markup only starts after whitespace or opening punctuation.
const MARKUP_START = /[\s'"([{<\-/:]/;
const INLINE: [RegExp, Style][] = [
  [/``\S(?:.*?\S)?``/y, "monospace"],
  [/\*\*\S(?:.*?\S)?\*\*/y, "strong"],
  [/\*\S(?:.*?\S)?\*/y, "emphasis"],
  [/:[\w.+-]+(?::[\w.+-]+)*:(?=`)/y, "role"],
  [/`[^`]+`__?/y, "link"],
  [/`[^`]+`/y, "interpreted"],
  [/\|\S(?:[^|]*\S)?\|(?:__?)?/y, "substitution"],
  [/\[(?:\d+|#[\w-]*|\*|[\w.-]+)\]_/y, "link"],
  [/https?:\/\/[^\s<>`]*[^\s<>`.,;:!?)\]'"]/y, "url"],
  [/[A-Za-z0-9]+(?:[-_.:+][A-Za-z0-9]+)*__?(?!\w)/y, "link"],
];
const WORD = /\w+/y;

const adornment = (line: string) => (ADORNMENT.test(line) ? line.trimEnd() : null);
/** docutils accepts a short adornment (with a warning) unless it is under 4 characters. */
const fits = (title: string, adornment: string) => adornment.length >= Math.min(4, [...title.trimEnd()].length);

/** `[nodeId, from, to, 4]` for each token, in document order (a lezer tree buffer). */
function tokenize(text: string): number[] {
  const out: number[] = [];
  const add = (style: Style, from: number, to: number) => {
    if (to > from) out.push(NAMES.indexOf(style), from, to, 4);
  };
  const lines = text.split("\n");
  const starts: number[] = [];
  for (let i = 0, at = 0; i < lines.length; at += lines[i]!.length + 1, i++) starts.push(at);
  const end = (i: number) => starts[i]! + lines[i]!.trimEnd().length;

  let block: Block | null = null;
  let inPara = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const off = starts[i]!;
    const indent = line.length - line.trimStart().length;
    if (!line.trim()) {
      inPara = false;
      if (block) block.options = false;
      continue;
    }
    if (block) {
      if (indent > block.base) {
        const option = block.kind === "code" && block.options ? /^\s*:[\w-]+:/.exec(line) : null;
        if (option) add("field", off + indent, off + option[0].length);
        else add(block.kind === "comment" ? "comment" : "monospace", off + indent, end(i));
        continue;
      }
      block = null;
    }
    const over = adornment(line);
    if (!inPara) {
      const [next, after] = [lines[i + 1] ?? "", lines[i + 2] ?? ""];
      if (over && next.trim() && !adornment(next) && adornment(after) === over && fits(next, over)) {
        add("heading", off, end(i + 2));
        i += 2;
        continue;
      }
      const underline = !over && indent === 0 && !BODY_ELEMENT.test(line) ? adornment(next) : null;
      if (underline && fits(line, underline)) {
        add("heading", off, end(i + 1));
        i += 1;
        continue;
      }
    }
    if (over && over.length >= 4 && !inPara) {
      // A transition, or an adornment that matched no title (shorter ones, like `::`, are text).
      add("heading", off, end(i));
      inPara = false;
      continue;
    }
    inPara = true;

    let p = 0;
    const directive = /^\s*\.\.\s+(?:\|[^|]+\|\s+)?([\w:+.-]+)::/.exec(line);
    const target = /^\s*(?:\.\.\s+(?:_[^:]*:|\[[^\]]+\])|__(?=\s))/.exec(line);
    if (directive) {
      if (CODE_DIRECTIVES.has(directive[1]!)) block = { kind: "code", base: indent, options: true };
      add("directive", off + indent, off + directive[0].length);
      p = directive[0].length;
    } else if (target) {
      add("label", off + indent, off + target[0].length);
      p = target[0].length;
    } else if (/^\s*\.\.(?:\s|$)/.test(line)) {
      add("comment", off + indent, end(i));
      block = { kind: "comment", base: indent, options: false };
      continue;
    } else {
      const field = /^\s*:[^:\s][^:]*:(?=\s|$)/.exec(line);
      if (field) add("field", off + indent, off + field[0].length);
      p = field ? field[0].length : 0;
      if (line.trimEnd().endsWith("::")) block = { kind: "literal", base: indent, options: false };
    }

    while (p < line.length) {
      let matched = 0;
      if (MARKUP_START.test(p === 0 ? " " : line[p - 1]!)) {
        for (const [re, style] of INLINE) {
          re.lastIndex = p;
          const m = re.exec(line);
          if (m) {
            add(style, off + p, off + p + m[0].length);
            matched = m[0].length;
            break;
          }
        }
      }
      WORD.lastIndex = p;
      p += matched || WORD.exec(line)?.[0].length || 1;
    }
  }
  return out;
}

// ponytail: reparses the whole document on each change (no fragment reuse);
// fine for documentation-sized files, add incremental reuse if large ones lag.
class RstParser extends Parser {
  createParse(input: Input): PartialParse {
    return {
      parsedPos: input.length,
      stoppedAt: null,
      stopAt() {},
      advance: () => {
        const text = input.read(0, input.length);
        return Tree.build({ buffer: tokenize(text), nodeSet, topID: 0, length: text.length });
      },
    };
  }
}

export const restructuredtextLanguage = new Language(data, new RstParser(), [], "restructuredtext");
