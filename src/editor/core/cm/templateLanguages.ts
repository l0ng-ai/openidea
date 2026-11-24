/**
 * Embedded languages in JavaScript and TypeScript template literals, as WebStorm injects them:
 * CSS in styled-components / emotion / Lit (`styled.div`, `styled(Button).attrs(…)`, `css`,
 * `createGlobalStyle`, `keyframes`, `injectGlobal`), GraphQL (`gql`, `graphql`, also called as
 * `graphql(`…`)`), SQL (`sql`) and HTML (`html`). A `/* GraphQL *\/`-style comment right before
 * a plain template literal names its language too.
 *
 * The literal's text between `${…}` substitutions is parsed as one document of the embedded
 * language; the substitutions stay JavaScript.
 */
import { LanguageDescription, LanguageSupport, LRLanguage, ParseContext, type Language } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import type { LRParser } from "@lezer/lr";
import {
  parseMixed,
  type Input,
  type NestedParse,
  type Parser,
  type SyntaxNode,
  type SyntaxNodeRef,
} from "@lezer/common";

/** A mode by `LanguageDescription` name, with the tag patches of a file in that language. */
export type TemplateLanguageResolver = (name: string) => Language | LanguageDescription | null;

const CSS_TAGS = new Set(["css", "createGlobalStyle", "keyframes", "injectGlobal"]);

/** The embedded language a tag names, by mode name. */
function tagLanguage(tag: SyntaxNode, input: Input): string | null {
  if (rootName(tag, input) === "styled") return "CSS";
  const name = lastName(tag, input);
  if (!name) return null;
  if (CSS_TAGS.has(name)) return "CSS";
  if (name === "gql" || name === "graphql") return "GraphQL";
  if (name === "sql" || name === "SQL") return "SQL";
  if (name === "html") return "HTML";
  return null;
}

const COMMENT_LANGUAGES: Record<string, string> = {
  css: "CSS",
  graphql: "GraphQL",
  gql: "GraphQL",
  sql: "SQL",
  html: "HTML",
};

/** The language a `/* name *\/` comment names. */
function commentLanguage(comment: SyntaxNode, input: Input): string | null {
  const name = /^\/\*\s*([A-Za-z]+)\s*\*\/$/.exec(input.read(comment.from, comment.to))?.[1];
  return (name && COMMENT_LANGUAGES[name.toLowerCase()]) ?? null;
}

/** The identifier a tag expression starts from: `styled` in `styled(Button).attrs({})`. */
function rootName(node: SyntaxNode, input: Input): string | null {
  for (let n: SyntaxNode | null = node; n; n = n.firstChild) {
    if (n.name === "VariableName") return input.read(n.from, n.to);
    if (!["MemberExpression", "CallExpression", "InstantiationExpression"].includes(n.name)) return null;
  }
  return null;
}

/** The name a tag expression ends with: `sql` in `sql` and `Prisma.sql`, `css` in `css<Props>`. */
function lastName(node: SyntaxNode, input: Input): string | null {
  let n: SyntaxNode | null = node;
  if (n.name === "InstantiationExpression") n = n.firstChild;
  if (n?.name === "MemberExpression") n = n.lastChild;
  return n && (n.name === "VariableName" || n.name === "PropertyName") ? input.read(n.from, n.to) : null;
}

/** The literal's text between the backticks, without its `${…}` substitutions. */
function contentRanges(template: SyntaxNode, input: Input): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  let from = template.from + 1;
  for (const sub of template.getChildren("Interpolation")) {
    if (sub.from > from) ranges.push({ from, to: sub.from });
    from = sub.to;
  }
  const closed = template.to - template.from > 1 && input.read(template.to - 1, template.to) === "`";
  const to = closed ? template.to - 1 : template.to;
  if (to > from) ranges.push({ from, to });
  return ranges;
}

/** Styled-components and emotion bodies are declarations and nested rules, as in a `style` attribute. */
const declarationParsers = new WeakMap<Parser, Parser>();

function parserFor(name: string, resolve: TemplateLanguageResolver): Parser | null {
  const mode = resolve(name);
  if (!mode) return null;
  let language: Language;
  if (mode instanceof LanguageDescription) {
    if (!mode.support) return ParseContext.getSkippingParser(mode.load());
    language = mode.support.language;
  } else language = mode;
  if (name !== "CSS" || !(language instanceof LRLanguage)) return language.parser;
  let parser = declarationParsers.get(language.parser);
  if (!parser)
    declarationParsers.set(language.parser, (parser = (language.parser as LRParser).configure({ top: "Styles" })));
  return parser;
}

/** The nested parse for `node`, mounted on the tagged template or call so editing the tag re-parses it. */
export function templateInjection(resolve: TemplateLanguageResolver) {
  return (ref: SyntaxNodeRef, input: Input): NestedParse | null => {
    // Called for every node on each parse: rule out the rest before materializing the node.
    if (ref.name !== "TaggedTemplateExpression" && ref.name !== "CallExpression" && ref.name !== "TemplateString")
      return null;
    const node = ref.node;
    let template: SyntaxNode | null = null;
    let language: string | null = null;
    if (node.name === "TaggedTemplateExpression") {
      template = node.lastChild;
      const tag = node.firstChild;
      language = tag && template !== tag ? tagLanguage(tag, input) : null;
    } else if (node.name === "CallExpression") {
      // `graphql(`…`)` (gql.tada, GraphQL Code Generator's client preset).
      const callee = node.firstChild;
      const first = node.getChild("ArgList")?.firstChild?.nextSibling;
      if (callee && first?.name === "TemplateString" && tagLanguage(callee, input) === "GraphQL") {
        template = first;
        language = "GraphQL";
      }
    } else if (node.name === "TemplateString" && node.parent?.name !== "TaggedTemplateExpression") {
      const before = node.prevSibling;
      if (before?.name === "BlockComment") {
        template = node;
        language = commentLanguage(before, input);
      }
    }
    if (!template || template.name !== "TemplateString" || !language) return null;
    const overlay = contentRanges(template, input);
    if (!overlay.length) return null;
    const parser = parserFor(language, resolve);
    return parser ? { parser, overlay } : null;
  };
}

type JavaScriptConfig = NonNullable<Parameters<typeof javascript>[0]>;

/** `javascript(config)` that also parses embedded languages in template literals. */
export function javascriptWithTemplates(config: JavaScriptConfig, resolve: TemplateLanguageResolver): LanguageSupport {
  const base = javascript(config);
  const language = (base.language as LRLanguage).configure({ wrap: parseMixed(templateInjection(resolve)) });
  return new LanguageSupport(language, base.support);
}
