/**
 * Angular template language: HTML whose text and binding attributes are
 * Angular syntax (`angular.grammar`), expressions parsed as JavaScript. From
 * @codemirror/lang-angular 0.1.4 (MIT, see LICENSE); changed by OpenIDEA:
 * control-flow blocks, `@let`, key and animation binding names, structural
 * directives' microsyntax, runs of text that entities split (`a && b`)
 * parsed as one, and folding blocks.
 */
import { LRLanguage, LanguageSupport, foldService, matchBrackets, syntaxTree } from "@codemirror/language";
import { html } from "@codemirror/lang-html";
import { javascriptLanguage } from "@codemirror/lang-javascript";
import { styleTags, tags as t } from "@lezer/highlight";
import { IterMode, parseMixed, type Input, type NestedParse, type SyntaxNode, type SyntaxNodeRef } from "@lezer/common";
import { JS_TAGS } from "../jsTags";
import { parser } from "./parser";

const jsParser = javascriptLanguage.parser.configure({ props: [styleTags(JS_TAGS)] });
const exprParser = jsParser.configure({ top: "SingleExpression" });

const baseParser = parser.configure({
  props: [
    styleTags({
      Text: t.content,
      Is: t.definitionOperator,
      AttributeName: t.attributeName,
      "AttributeValue ExpressionAttributeValue StatementAttributeValue": t.attributeValue,
      Entity: t.character,
      InvalidEntity: t.invalid,
      // A name's own style covers the `.`s between its parts.
      "BoundAttributeName BoundAttributeName/Identifier BoundAttributeName/@": t.attributeName,
      "EventName EventName/Identifier EventName/@": t.special(t.attributeName),
      "ReferenceName/Identifier": t.variableName,
      'DirectiveName DirectiveName/Identifier DirectiveName/"*"': t.keyword,
      "{{ }}": t.special(t.brace),
      "( )": t.paren,
      "[ ]": t.bracket,
      "# :": t.punctuation,
      "@if @else @for @empty @switch @case @default if": t.controlKeyword,
      "@defer @placeholder @loading @error of as track on when prefetch hydrate never minimum after TriggerName BindingKey":
        t.keyword,
      "@let let": t.definitionKeyword,
      Brace: t.brace,
      "; ,": t.separator,
      VariableDefinition: t.definition(t.variableName),
      VariableName: t.variableName,
      Time: t.number,
    }),
  ],
});

const exprMixed = { parser: exprParser },
  statementMixed = { parser: jsParser };

const EXPRESSIONS = new Set(["InterpolationContent", "Expression", "BindingExpression"]);

const textParser = baseParser.configure({
  wrap: parseMixed((node) => (EXPRESSIONS.has(node.name) ? exprMixed : null)),
});

const microsyntaxMixed = { parser: textParser.configure({ top: "Microsyntax" }) };

// To reuse old inner trees, parseMixed takes those that the node at a mount's
// start and its ancestors had with the same parser. So each kind of mount has
// its own instance: the document's runs would take those of an element at its
// start, and a text those of its element's runs.
const runsParser = textParser.configure({}),
  documentRunsParser = textParser.configure({});

/** The parser of an attribute's interpolation or bound value (`node`). */
function attrValueMixed(node: SyntaxNode) {
  const value = node.parent;
  if (value?.name != "StatementAttributeValue") return exprMixed;
  return value.parent?.firstChild?.name == "DirectiveName" ? microsyntaxMixed : statementMixed;
}

const attrParser = baseParser.configure({
  wrap: parseMixed((node) =>
    node.name == "InterpolationContent"
      ? exprMixed
      : node.name == "AttributeInterpolation"
        ? attrValueMixed(node.node)
        : null,
  ),
  top: "Attribute",
});

const textMixed = { parser: textParser },
  attrMixed = { parser: attrParser };

// Text is parsed per node, like upstream, so an unfinished `{{` or `@if (`
// ends with it. But HTML splits text at each `&` (`@if (a && b) {`), so a run
// of text and entities is parsed as one: an overlay of the element (or the
// document) holding it.
const TEXT_NODES = new Set(["Text", "EntityReference", "CharacterReference", "InvalidEntity"]);

/** The runs of text directly in `node` that entities split, `null` without any. */
function entityRuns(node: SyntaxNode): { from: number; to: number }[] | null {
  const runs: { from: number; to: number }[] = [];
  let from = -1,
    to = -1,
    parts = 0;
  const child = node.cursor(IterMode.IgnoreMounts);
  if (child.firstChild()) {
    do {
      if (!TEXT_NODES.has(child.name)) continue;
      if (child.from == to) {
        to = child.to;
        parts++;
        continue;
      }
      if (parts > 1) runs.push({ from, to });
      ({ from, to } = child);
      parts = 1;
    } while (child.nextSibling());
  }
  if (parts > 1) runs.push({ from, to });
  return runs.length ? runs : null;
}

const baseHTML = html({ selfClosingTags: true });

function mixAngular(node: SyntaxNodeRef, input: Input): NestedParse | null {
  switch (node.name) {
    case "Attribute":
      return /^[*#([]|\{\{/.test(input.read(node.from, node.to)) ? attrMixed : null;
    // Text in a run is covered by its parent's overlay, so not asked about.
    case "Text":
      return textMixed;
    case "Document":
    case "Element": {
      const overlay = entityRuns(node.node);
      return overlay && { parser: node.name == "Document" ? documentRunsParser : runsParser, overlay };
    }
  }
  return null;
}

export const angularLanguage = (baseHTML.language as LRLanguage).configure({ wrap: parseMixed(mixAngular) }, "angular");

/**
 * The body of the first block opened on a line and closed on a later one, up
 * to its `}`, which stays visible: `@if (a) {…}`, `} @else {…}`. Its braces
 * pair like plain text, across elements.
 */
const blockFolding = foldService.of((state, lineStart, lineEnd) => {
  const text = state.sliceDoc(lineStart, lineEnd);
  const tree = syntaxTree(state);
  for (let i = text.indexOf("{"); i >= 0; i = text.indexOf("{", i + 1)) {
    const open = tree.resolveInner(lineStart + i, 1);
    if (open.name != "Brace" || open.parent?.name != "Block") continue;
    const match = matchBrackets(state, open.from, 1, { brackets: "{}", maxScanDistance: state.doc.length });
    if (match?.matched && match.end && match.end.from > lineEnd) return { from: open.to, to: match.end.from };
  }
  return null;
});

export function angular(): LanguageSupport {
  return new LanguageSupport(angularLanguage, [
    baseHTML.support,
    blockFolding,
    baseHTML.language.data.of({
      closeBrackets: { brackets: ["[", "{", '"'] },
      indentOnInput: /^\s*[}\]]$/,
    }),
  ]);
}
