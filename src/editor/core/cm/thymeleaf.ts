/**
 * Thymeleaf templates: HTML whose `th:*` (and `data-th-*`) attribute values are Thymeleaf
 * standard expressions, highlighted with their own grammar (`${…}` variables, `*{…}`
 * selections, `#{…}` messages, `@{…}` links, `~{…}` fragments, `|…|` literal
 * substitutions, utility objects such as `#dates`), and completion of the attribute names.
 */
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { html } from "@codemirror/lang-html";
import { LanguageSupport, StreamLanguage, type StringStream } from "@codemirror/language";

/** The Standard Dialect's attributes (without `th:`). */
export const THYMELEAF_ATTRIBUTES = [
  "abbr",
  "accept",
  "accept-charset",
  "accesskey",
  "action",
  "align",
  "alt",
  "archive",
  "assert",
  "async",
  "attr",
  "attrappend",
  "attrprepend",
  "audio",
  "autocomplete",
  "autofocus",
  "autoplay",
  "axis",
  "background",
  "bgcolor",
  "block",
  "border",
  "case",
  "cellpadding",
  "cellspacing",
  "challenge",
  "charset",
  "checked",
  "cite",
  "class",
  "classappend",
  "classid",
  "codebase",
  "codetype",
  "cols",
  "colspan",
  "compact",
  "content",
  "contenteditable",
  "contextmenu",
  "controls",
  "data",
  "datetime",
  "declare",
  "default",
  "defer",
  "dir",
  "disabled",
  "draggable",
  "dropzone",
  "each",
  "enctype",
  "errorclass",
  "errors",
  "field",
  "for",
  "form",
  "formaction",
  "formenctype",
  "formmethod",
  "formnovalidate",
  "formtarget",
  "fragment",
  "frame",
  "frameborder",
  "headers",
  "height",
  "hidden",
  "high",
  "href",
  "hreflang",
  "hspace",
  "http-equiv",
  "icon",
  "id",
  "if",
  "include",
  "inline",
  "insert",
  "ismap",
  "keytype",
  "kind",
  "label",
  "lang",
  "list",
  "longdesc",
  "loop",
  "low",
  "manifest",
  "marginheight",
  "marginwidth",
  "max",
  "maxlength",
  "media",
  "method",
  "min",
  "multiple",
  "muted",
  "name",
  "novalidate",
  "nowrap",
  "object",
  "onabort",
  "onblur",
  "onchange",
  "onclick",
  "ondblclick",
  "onfocus",
  "oninput",
  "onkeydown",
  "onkeypress",
  "onkeyup",
  "onload",
  "onmousedown",
  "onmouseout",
  "onmouseover",
  "onmouseup",
  "onreset",
  "onresize",
  "onscroll",
  "onselect",
  "onsubmit",
  "onunload",
  "open",
  "optimum",
  "pattern",
  "placeholder",
  "poster",
  "preload",
  "radiogroup",
  "readonly",
  "ref",
  "rel",
  "remove",
  "replace",
  "required",
  "rev",
  "reversed",
  "rows",
  "rowspan",
  "rules",
  "sandbox",
  "scheme",
  "scope",
  "scoped",
  "scrolling",
  "seamless",
  "selected",
  "size",
  "sizes",
  "span",
  "spellcheck",
  "src",
  "srclang",
  "standby",
  "start",
  "step",
  "style",
  "styleappend",
  "subject",
  "summary",
  "switch",
  "tabindex",
  "target",
  "text",
  "title",
  "type",
  "unless",
  "usemap",
  "utext",
  "value",
  "valuetype",
  "vspace",
  "width",
  "with",
  "wrap",
  "xmlbase",
  "xmllang",
  "xmlspace",
];

/** The attributes most templates use, offered first. */
const COMMON = new Set([
  "text",
  "utext",
  "each",
  "if",
  "unless",
  "href",
  "src",
  "action",
  "value",
  "object",
  "field",
  "fragment",
  "replace",
  "insert",
  "with",
  "classappend",
]);

const OPERATORS = /^(?:and|or|not|eq|ne|neq|lt|gt|le|ge|div|mod)\b/;
const ATOMS = /^(?:true|false|null)\b/;

interface ExpressionState {
  /** Inside `|…|`: text with substituted expressions. */
  literal: boolean;
  /** Open `${`, `*{`, … */
  depth: number;
}

/** A Thymeleaf standard expression (an attribute value). */
const expression = StreamLanguage.define<ExpressionState>({
  name: "thymeleaf-expression",
  startState: () => ({ literal: false, depth: 0 }),
  token(stream: StringStream, state: ExpressionState) {
    if (stream.match(/^[$*#@~]\{/)) {
      state.depth++;
      return "meta";
    }
    if (stream.eat("}")) {
      state.depth = Math.max(0, state.depth - 1);
      return "meta";
    }
    if (state.literal && state.depth === 0) {
      if (stream.eat("|")) state.literal = false;
      else if (!stream.match(/^[^|$*#@~}]+/)) stream.next();
      return "string";
    }
    if (stream.eatSpace()) return null;
    if (stream.eat("|")) {
      state.literal = true;
      return "string";
    }
    if (stream.eat("'")) {
      while (!stream.eol()) {
        if (stream.eat("'")) {
          // '' is an escaped quote inside a literal.
          if (!stream.eat("'")) break;
        } else stream.next();
      }
      return "string";
    }
    if (stream.match(/^\d+(?:\.\d+)?/)) return "number";
    if (stream.match(/^#[A-Za-z_]\w*/)) return "builtin";
    if (stream.match(OPERATORS)) return "operator";
    if (stream.match(ATOMS)) return "atom";
    if (stream.match(/^[A-Za-z_][\w-]*/)) return "variable";
    if (stream.match(/^(?:::|[!=<>]=?|[-+*/%?:,.]|&&|\|\|)/)) return "operator";
    if (stream.match(/^[()[\]]/)) return "bracket";
    stream.next();
    return null;
  },
});

/** The attribute name being typed at `ctx.pos` inside a tag, when it may be a Thymeleaf one. */
export function thymeleafAttributeCompletion(ctx: CompletionContext): CompletionResult | null {
  const word = ctx.matchBefore(/[\w:-]+$/);
  if (!word) return null;
  const typed = word.text;
  const prefix =
    typed.startsWith("th:") || "th:".startsWith(typed)
      ? "th:"
      : typed.startsWith("data-th-") || (typed.startsWith("data-t") && "data-th-".startsWith(typed))
        ? "data-th-"
        : null;
  if (!prefix) return null;
  const before = ctx.state.sliceDoc(Math.max(0, word.from - 2000), word.from);
  // Inside a start tag, after whitespace, outside quoted values.
  if (!/\s$/.test(before) || before.lastIndexOf("<") <= before.lastIndexOf(">")) return null;
  const tag = before.slice(before.lastIndexOf("<"));
  if ((tag.match(/["']/g)?.length ?? 0) % 2 === 1) return null;
  const options: Completion[] = THYMELEAF_ATTRIBUTES.map((name) => ({
    label: prefix + name,
    detail: "Thymeleaf",
    type: "property",
    boost: COMMON.has(name) ? 1 : 0,
    apply: (view, completion, from, to) => {
      const hasValue = view.state.sliceDoc(to, to + 1) === "=";
      const text = hasValue ? completion.label : `${completion.label}=""`;
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + (hasValue ? text.length : text.length - 1) },
        userEvent: "input.complete",
      });
    },
  }));
  return { from: word.from, options, validFor: /^[\w:-]*$/ };
}

export function thymeleafSupport(): LanguageSupport {
  const attributes = THYMELEAF_ATTRIBUTES.flatMap((name) => [
    { name: `th:${name}`, parser: expression.parser },
    { name: `data-th-${name}`, parser: expression.parser },
  ]);
  const base = html({ nestedAttributes: attributes });
  return new LanguageSupport(base.language, [
    base.support,
    base.language.data.of({ openideaCompletion: thymeleafAttributeCompletion }),
  ]);
}
