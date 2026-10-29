/**
 * Angular template language: HTML whose text and binding attributes are
 * Angular syntax (`angular.grammar`), expressions parsed as JavaScript. From
 * @codemirror/lang-angular 0.1.4 (MIT, see LICENSE); changed by OpenIDEA:
 * control-flow blocks, `@let`, key and animation binding names, and runs of
 * text that entities split (`a && b`) parsed as one.
 */
import { LRLanguage, LanguageSupport } from "@codemirror/language";
import { html } from "@codemirror/lang-html";
import { javascriptLanguage } from "@codemirror/lang-javascript";
import { styleTags, tags as t } from "@lezer/highlight";
import { IterMode, parseMixed, type Input, type NestedParse, type SyntaxNode, type SyntaxNodeRef } from "@lezer/common";
import { parser } from "./parser";

const exprParser = javascriptLanguage.parser.configure({ top: "SingleExpression" });

const baseParser = parser.configure({
  props: [
    styleTags({
      Text: t.content,
      Is: t.definitionOperator,
      AttributeName: t.attributeName,
      "AttributeValue ExpressionAttributeValue StatementAttributeValue": t.attributeValue,
      Entity: t.character,
      InvalidEntity: t.invalid,
      "BoundAttributeName/Identifier BoundAttributeName/@": t.attributeName,
      "EventName/Identifier EventName/@": t.special(t.attributeName),
      "ReferenceName/Identifier": t.variableName,
      "DirectiveName/Identifier": t.keyword,
      "{{ }}": t.special(t.brace),
      "( )": t.paren,
      "[ ]": t.bracket,
      "# '*'": t.punctuation,
      "@if @else @for @empty @switch @case @default if": t.controlKeyword,
      "@defer @placeholder @loading @error of as track on when prefetch hydrate never minimum after TriggerName":
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
  statementMixed = { parser: javascriptLanguage.parser };

const textParser = baseParser.configure({
  wrap: parseMixed((node) => (node.name == "InterpolationContent" || node.name == "Expression" ? exprMixed : null)),
});

// To reuse old inner trees, parseMixed takes those that the node at a mount's
// start and its ancestors had with the same parser. So each kind of mount has
// its own instance: the document's runs would take those of an element at its
// start, and a text those of its element's runs.
const runsParser = textParser.configure({}),
  documentRunsParser = textParser.configure({});

const attrParser = baseParser.configure({
  wrap: parseMixed((node) =>
    node.name == "InterpolationContent"
      ? exprMixed
      : node.name != "AttributeInterpolation"
        ? null
        : node.node.parent?.name == "StatementAttributeValue"
          ? statementMixed
          : exprMixed,
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

export function angular(): LanguageSupport {
  return new LanguageSupport(angularLanguage, [
    baseHTML.support,
    baseHTML.language.data.of({
      closeBrackets: { brackets: ["[", "{", '"'] },
      indentOnInput: /^\s*[}\]]$/,
    }),
  ]);
}
