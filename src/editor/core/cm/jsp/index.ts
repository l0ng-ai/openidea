/**
 * JSP pages, layered like IntelliJ's JSP view provider: `jsp.grammar` parses
 * the JSP layer, and the template text around its elements is one HTML
 * document. That is an overlay, so markup split by a scriptlet still nests
 * and `value="<%= id %>"` is an attribute with a hole. The scriptlets are
 * one Java method body, an overlay too (`<% for (…) { %> … <% } %>` balances
 * its braces), each expression and declaration Java of its own.
 */
import { LRLanguage, LanguageSupport, foldInside, foldNodeProp } from "@codemirror/language";
import { html } from "@codemirror/lang-html";
import { javaLanguage } from "@codemirror/lang-java";
import { styleTags, tags as t } from "@lezer/highlight";
import {
  Parser,
  parseMixed,
  type Input,
  type NestedParse,
  type PartialParse,
  type SyntaxNode,
  type SyntaxNodeRef,
  type TreeFragment,
} from "@lezer/common";
import { JAVA_TAGS } from "../languages";
import { parser } from "./parser";

const baseHTML = html({ selfClosingTags: true });

const JSP_COMMENT = { block: { open: "<%--", close: "--%>" } };

const baseParser = parser.configure({
  props: [
    styleTags({
      JspComment: t.blockComment,
      '"<%" "<%=" "<%!" "<%@" "%>"': t.processingInstruction,
      // Not `ELExpression/"}"`: the cursor highlighting a page does not match
      // that context once the expression's content is mounted.
      '"${" "#{" ELEnd/...': t.special(t.brace),
      DirectiveName: t.keyword,
      AttributeName: t.attributeName,
      AttributeValue: t.attributeValue,
      Is: t.definitionOperator,
      VariableName: t.variableName,
      PropertyName: t.propertyName,
      "CallExpression/MemberExpression/PropertyName": t.function(t.propertyName),
      "CallExpression/VariableName FunctionName": t.function(t.variableName),
      Namespace: t.namespace,
      Number: t.number,
      String: t.string,
      BooleanLiteral: t.bool,
      null: t.null,
      "not empty div mod lt gt le ge instanceof eq ne and or": t.operatorKeyword,
      ArithOp: t.arithmeticOperator,
      CompareOp: t.compareOperator,
      LogicOp: t.logicOperator,
      '"->"': t.operator,
      '"."': t.derefOperator,
      "( )": t.paren,
      "[ ]": t.squareBracket,
      'SetOrMapLiteral/"{" SetOrMapLiteral/"}"': t.brace,
      ", ;": t.separator,
      '":"': t.punctuation,
    }),
    foldNodeProp.add({
      "Scriptlet Declaration JspExpression": foldInside,
      JspComment: (node, state) => ({
        from: node.from + 4,
        to: state.sliceDoc(node.to - 4, node.to) == "--%>" ? node.to - 4 : node.to,
      }),
    }),
  ],
});

const javaParser = javaLanguage.parser.configure({ props: [styleTags(JAVA_TAGS)] });

/** `input` with a `;` at `at`. */
class TerminatedInput implements Input {
  constructor(
    private readonly input: Input,
    private readonly at: number,
  ) {}

  get length() {
    return this.input.length;
  }

  get lineChunks() {
    return this.input.lineChunks;
  }

  chunk(from: number): string {
    if (from == this.at) return ";";
    const text = this.input.chunk(from);
    return from < this.at && this.at < from + text.length ? text.slice(0, this.at - from) : text;
  }

  read(from: number, to: number): string {
    const text = this.input.read(from, to);
    return from <= this.at && this.at < to
      ? text.slice(0, this.at - from) + ";" + text.slice(this.at - from + 1)
      : text;
  }
}

/**
 * Java has no expression top: an expression is parsed as a statement, its
 * trailing space read as the `;` (`<%= name %>`), so that a lone name is not
 * a call missing its arguments. Without one, it ends in an error node.
 */
class ExpressionParser extends Parser {
  private readonly java = javaParser.configure({});

  createParse(
    input: Input,
    fragments: readonly TreeFragment[],
    ranges: readonly { from: number; to: number }[],
  ): PartialParse {
    const end = ranges[ranges.length - 1]!.to;
    const terminated = /\s/.test(input.read(end - 1, end)) ? new TerminatedInput(input, end - 1) : input;
    return this.java.createParse(terminated, fragments, ranges);
  }
}

// To reuse old inner trees, parseMixed takes those that the node at a mount's
// start and its ancestors had with the same parser, so each kind of mount has
// its own instance: an expression at the start of a page would otherwise take
// the scriptlets' tree.
const htmlMixed: NestedParse = { parser: baseHTML.language.parser, overlay: (node) => node.name == "Text" },
  scriptletParser = javaParser.configure({}),
  expressionMixed = { parser: new ExpressionParser() },
  declarationMixed = { parser: javaParser.configure({ top: "ClassContent" }) },
  elMixed = { parser: baseParser.configure({ top: "EL" }) };

/** The code of the scriptlets in `template`. */
function scriptletCode(template: SyntaxNode): { from: number; to: number }[] {
  const code: { from: number; to: number }[] = [];
  for (const scriptlet of template.getChildren("Scriptlet")) {
    const java = scriptlet.getChild("JavaCode");
    if (java) code.push({ from: java.from, to: java.to });
  }
  return code;
}

// The HTML overlay is on the document and the scriptlets' on the template it
// holds: a node mounts one tree, and an overlay's predicate does not see the
// nodes of an overlay inside it.
function mixJsp(node: SyntaxNodeRef): NestedParse | null {
  switch (node.name) {
    case "Document":
      return htmlMixed;
    case "Template": {
      const overlay = scriptletCode(node.node);
      return overlay.length ? { parser: scriptletParser, overlay } : null;
    }
    case "JavaCode": {
      const element = node.node.parent?.name;
      return element == "JspExpression" ? expressionMixed : element == "Declaration" ? declarationMixed : null;
    }
    case "ELContent":
      return elMixed;
  }
  return null;
}

export const jspLanguage = LRLanguage.define({
  name: "jsp",
  parser: baseParser.configure({ wrap: parseMixed(mixJsp) }),
  languageData: { commentTokens: JSP_COMMENT },
});

export function jsp(): LanguageSupport {
  return new LanguageSupport(jspLanguage, [
    baseHTML.support,
    // Markup comments out of the page, with a JSP comment, as in IntelliJ.
    baseHTML.language.data.of({ commentTokens: JSP_COMMENT }),
  ]);
}
