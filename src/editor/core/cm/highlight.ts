/**
 * Syntax colours: lezer highlight tags → `--syn-*` tokens (PyCharm Islands
 * schemes). Each token also reads `--syn-<token>-bold / -italic / -bg /
 * -effect`, set by Settings › Editor › Color Scheme overrides.
 */
import { HighlightStyle, type TagStyle } from "@codemirror/language";
import { tags as t, type Tag } from "@lezer/highlight";

function token(
  tag: Tag | Tag[],
  name: string,
  defaults: { italic?: string; bold?: string; effect?: string } = {},
): TagStyle {
  return {
    tag,
    color: `var(--syn-${name})`,
    fontStyle: `var(--syn-${name}-italic, ${defaults.italic ?? "inherit"})`,
    fontWeight: `var(--syn-${name}-bold, ${defaults.bold ?? "inherit"})`,
    backgroundColor: `var(--syn-${name}-bg, transparent)`,
    textDecoration: `var(--syn-${name}-effect, ${defaults.effect ?? "none"})`,
  };
}

export const openideaHighlightStyle = HighlightStyle.define([
  // Markdown tags whole links / quotes; listed first so marks, URL and title inside keep their own colours.
  token(t.link, "link", { effect: "underline" }),
  token(t.quote, "string"),
  token(
    [
      t.keyword,
      t.controlKeyword,
      t.moduleKeyword,
      t.operatorKeyword,
      t.definitionKeyword,
      t.modifier,
      t.null,
      t.bool,
      t.unit,
    ],
    "keyword",
  ),
  token(t.self, "self"),
  token([t.string, t.special(t.string), t.character, t.attributeValue], "string"),
  token(t.docString, "docstring", { italic: "italic" }),
  token(t.escape, "escape"),
  token(t.regexp, "regexp"),
  token([t.number, t.integer, t.float], "number"),
  token([t.typeName, t.className, t.namespace, t.definition(t.typeName)], "type"),
  token([t.standard(t.typeName), t.standard(t.variableName), t.standard(t.function(t.variableName))], "builtin"),
  token([t.function(t.variableName), t.function(t.propertyName)], "function-call"),
  token(
    [
      t.function(t.definition(t.variableName)),
      t.definition(t.function(t.variableName)),
      t.function(t.definition(t.propertyName)),
    ],
    "function",
  ),
  token([t.comment, t.lineComment, t.blockComment], "comment", { italic: "var(--syn-comment-style)" }),
  token(t.docComment, "doc-comment", { italic: "italic" }),
  token([t.meta, t.annotation, t.macroName], "decorator"),
  // `<!doctype>` is a sub-tag of `meta`; PyCharm leaves the XML prologue as plain text.
  { tag: t.documentMeta, color: "var(--fg-editor)" },
  token([t.constant(t.variableName), t.atom, t.special(t.variableName)], "constant", { italic: "italic" }),
  token(t.labelName, "constant"),
  token([t.variableName, t.definition(t.variableName), t.local(t.variableName)], "variable"),
  token([t.propertyName, t.definition(t.propertyName)], "property"),
  token(t.attributeName, "attribute"),
  token(t.special(t.brace), "decorator"),
  token([t.tagName, t.angleBracket], "tag"),
  token([t.punctuation, t.bracket, t.separator, t.operator, t.derefOperator], "punct"),
  token(t.invalid, "invalid"),
  // Markup (Markdown, docs)
  token(t.heading, "markup-heading", { bold: "var(--fw-code-bold, 700)" }),
  token(t.processingInstruction, "keyword"),
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "var(--fw-code-bold, 700)" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  // Markdown, as IntelliJ: link destination like a static method, rules like markers.
  token(t.url, "function", { italic: "italic" }),
  token(t.monospace, "markup-code"),
  token(t.contentSeparator, "keyword"),
  { tag: t.inserted, color: "var(--vcs-added)" },
  { tag: t.deleted, color: "var(--danger)" },
  { tag: t.changed, color: "var(--vcs-modified)" },
]);
