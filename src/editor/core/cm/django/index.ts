/**
 * Django templates: `django.grammar` parses the template layer (tags,
 * variables, comments), and the text between its elements is one HTML
 * document, an overlay as in JSP, so markup split by a tag still nests and
 * `href="{% url 'home' %}"` is an attribute with a hole. Block tags fold,
 * indent their content and match their end tags; typing `{%`, `{{` or `{#`
 * closes the pair, and finishing a block tag adds its end tag.
 */
import {
  LRLanguage,
  LanguageSupport,
  bracketMatchingHandle,
  foldNodeProp,
  indentNodeProp,
  syntaxTree,
  type TreeIndentContext,
} from "@codemirror/language";
import { html } from "@codemirror/lang-html";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { EditorSelection, Prec, type EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { styleTags, tags as t } from "@lezer/highlight";
import { NodeProp, parseMixed, type SyntaxNode, type SyntaxNodeRef } from "@lezer/common";
import { parser } from "./parser";
import { BLOCK_TAGS } from "./tokens";

export { BLOCK_TAGS };

const baseHTML = html({ selfClosingTags: true });

/** `{# #}` can't span lines: a multi-line block comment is a `comment` tag. */
const DJANGO_COMMENT = { block: { open: "{#", close: "#}" } };
const COMMENT_TAG = { open: "{% comment %}", close: "{% endcomment %}" };

const OPENERS = ["OpenTag", "CommentTag", "VerbatimTag"];

const startTagOf = (element: SyntaxNode) => element.firstChild;
const endTagOf = (element: SyntaxNode) => (element.lastChild?.name == "EndTag" ? element.lastChild : null);

/** The content of a block: from the end of its start tag to its end tag (or the end of the block). */
function foldBlock(element: SyntaxNode, state: EditorState) {
  const start = startTagOf(element);
  const end = endTagOf(element);
  if (!start) return null;
  // An end tag the parser inserted to recover is empty.
  const to = end && end.to > end.from ? end.from : element.to;
  return start.to < to && state.doc.lineAt(start.to).number < state.doc.lineAt(to).number
    ? { from: start.to, to }
    : null;
}

const CLOSING_LINE = /^\s*\{%-?\s*(end\w*|elif|else|empty|plural)\b/;

/** A block's content one unit in from its start tag's line; its middle and end tags at that line's indent. */
function indentBlock(cx: TreeIndentContext) {
  const start = startTagOf(cx.node);
  if (!start) return null;
  const base = cx.lineIndent(start.from);
  return CLOSING_LINE.test(cx.textAfter) ? base : base + cx.unit;
}

const tagName = (node: SyntaxNode) => node.getChild("TagName");

const templateParser = parser.configure({
  props: [
    styleTags({
      'TagStart OpenTagStart CommentTagStart VerbatimTagStart MidTagStart EndTagStart TagEnd "{{" "}}"': t.special(
        t.brace,
      ),
      TagName: t.keyword,
      "Comment CommentBody": t.blockComment,
      VariableName: t.variableName,
      PropertyName: t.propertyName,
      FilterName: t.function(t.variableName),
      FilterOp: t.operator,
      String: t.string,
      Number: t.number,
      BooleanLiteral: t.bool,
      None: t.null,
      CompareOp: t.compareOperator,
      AssignOp: t.definitionOperator,
      "and or not in is": t.operatorKeyword,
      "as with only from": t.keyword,
      '"."': t.derefOperator,
      '":"': t.punctuation,
    }),
    foldNodeProp.add({
      "Element CommentElement VerbatimElement": foldBlock,
    }),
    indentNodeProp.add({
      Element: indentBlock,
      // The raw content keeps its own indentation.
      "CommentElement VerbatimElement": () => null,
    }),
    NodeProp.closedBy.add({ "OpenTag CommentTag VerbatimTag": ["EndTag"] }),
    NodeProp.openedBy.add({ EndTag: OPENERS }),
    bracketMatchingHandle.add({ "OpenTag CommentTag VerbatimTag EndTag": tagName }),
  ],
});

// HTML's document gives no indentation past its last text; there the block around it does.
const htmlBase = (baseHTML.language as LRLanguage).parser;
const htmlDocumentIndent = htmlBase.nodeSet.types.find((type) => type.name == "Document")?.prop(indentNodeProp);
const htmlParser = htmlBase.configure({
  props: [indentNodeProp.add({ Document: (cx) => htmlDocumentIndent?.(cx) ?? cx.continue() })],
});

// The template text, and the content of `verbatim`, are one HTML document.
const htmlMixed = {
  parser: htmlParser,
  overlay: (node: SyntaxNodeRef) => node.name == "Text" || node.name == "VerbatimBody",
};

export const djangoLanguage = LRLanguage.define({
  name: "django",
  parser: templateParser.configure({ wrap: parseMixed((node) => (node.type.isTop ? htmlMixed : null)) }),
});

/** Where the template layer reaches: Django's own nodes, or the HTML outside `<script>` and `<style>`. */
function inTemplate(state: EditorState, pos: number): boolean {
  return state.languageDataAt<boolean>("djangoTemplate", pos).includes(true);
}

const PAIRS: Record<string, string> = { "%": "%", "{": "}", "#": "#" };

/**
 * After a `{`, typing `%`, `{` or `#` makes the pair: `{% | %}`, `{{ | }}`, `{# | #}`. The
 * `}` that closing brackets put after the first brace is reused.
 */
const closePair = EditorView.inputHandler.of((view, from, to, text) => {
  const close = PAIRS[text];
  const { state } = view;
  if (!close || from != to || state.selection.ranges.length > 1 || state.readOnly) return false;
  if (state.sliceDoc(from - 1, from) != "{" || state.sliceDoc(from - 2, from - 1) == "{") return false;
  if (!inTemplate(state, from)) return false;
  const reuse = state.sliceDoc(from, from + 1) == "}";
  const insert = `${text}  ${close}${reuse ? "" : "}"}`;
  view.dispatch({
    changes: { from, insert },
    selection: EditorSelection.cursor(from + text.length + 1),
    userEvent: "input.type",
  });
  return true;
});

const TAG_BEFORE = /\{%-?\s*([A-Za-z_]\w*)[^%]*%$/;

/** Whether the block `name` opened before `pos` has no end tag after it, nested blocks counted. */
function unclosed(state: EditorState, name: string, pos: number): boolean {
  const rest = state.sliceDoc(pos);
  const re = new RegExp(`\\{%-?\\s*(end)?${name}\\b`, "g");
  let depth = 0;
  for (let m; (m = re.exec(rest));) {
    if (!m[1]) depth++;
    else if (depth-- == 0) return false;
  }
  return true;
}

/** Typing the `}` of a block tag's `%}` adds its end tag after the caret when it has none. */
const closeBlock = EditorView.inputHandler.of((view, from, to, text) => {
  const { state } = view;
  if (text != "}" || from != to || state.selection.ranges.length > 1 || state.readOnly) return false;
  const line = state.doc.lineAt(from);
  const m = TAG_BEFORE.exec(state.sliceDoc(line.from, from));
  const name = m?.[1];
  if (!name || !BLOCK_TAGS.has(name) || !inTemplate(state, from - m[0].length)) return false;
  // A `}` closing brackets put there is typed over.
  const after = state.sliceDoc(from, from + 1) == "}" ? 1 : 0;
  if (!unclosed(state, name, from + after)) return false;
  view.dispatch({
    changes: { from, to: from + after, insert: `}{% end${name} %}` },
    selection: EditorSelection.cursor(from + 1),
    userEvent: "input.type",
  });
  return true;
});

/** The blocks open at `pos`, innermost first. */
function openBlocks(state: EditorState, pos: number): string[] {
  const names: string[] = [];
  for (let node: SyntaxNode | null = syntaxTree(state).resolve(pos, -1); node; node = node.parent) {
    if (!/^(Element|CommentElement|VerbatimElement)$/.test(node.name)) continue;
    const start = startTagOf(node);
    const name = start && tagName(start);
    if (start && name && start.to <= pos) names.push(state.sliceDoc(name.from, name.to));
  }
  return names;
}

/** `{% end…`: the end tags of the blocks open at the caret, innermost first. */
function endTagCompletion(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/\{%-?\s*\w*$/);
  if (!word) return null;
  const name = /\w*$/.exec(word.text)![0];
  if (!name && !context.explicit) return null;
  const from = word.to - name.length;
  // Template syntax, not UI text.
  const ends = openBlocks(context.state, from).map((block) => `end${block}`);
  const options = ends.map((end, i) => ({ label: end, type: "keyword", boost: 99 - i }));
  return options.length ? { from, options, validFor: /^\w*$/ } : null;
}

export function django(): LanguageSupport {
  return new LanguageSupport(djangoLanguage, [
    baseHTML.support,
    // Markup is commented out with a template comment, which Django drops from the page.
    baseHTML.language.data.of({ commentTokens: DJANGO_COMMENT, lineBoundComments: { multiline: COMMENT_TAG } }),
    baseHTML.language.data.of({ djangoTemplate: true, autocomplete: endTagCompletion }),
    djangoLanguage.data.of({
      djangoTemplate: true,
      autocomplete: endTagCompletion,
      commentTokens: DJANGO_COMMENT,
      lineBoundComments: { multiline: COMMENT_TAG },
    }),
    // A multi-line block comment, after `{# #}`, so that taking one out finds it.
    Prec.lowest([
      djangoLanguage.data.of({ commentTokens: { block: COMMENT_TAG } }),
      baseHTML.language.data.of({ commentTokens: { block: COMMENT_TAG } }),
    ]),
    Prec.high([closePair, closeBlock]),
  ]);
}
