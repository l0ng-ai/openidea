import { beforeAll, describe, expect, it } from "vitest";
import { ensureSyntaxTree, type LanguageSupport } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { highlightTree, tags as t, type Tag } from "@lezer/highlight";
import { toggleComment } from "@codemirror/commands";
import { findLanguageDescription, loadSupport } from "./languages";
import { openideaHighlightStyle } from "./highlight";

const supports: Record<string, LanguageSupport> = {};

beforeAll(async () => {
  // Embedded modes load lazily; load them up front so one parse covers the literals.
  for (const name of ["CSS", "GraphQL", "SQL", "HTML", "JavaScript", "TypeScript", "TSX", "Angular TypeScript"])
    supports[name] = (await loadSupport(findLanguageDescription(name, "")!))!;
});

function tokens(mode: string, doc: string): { text: string; cls: string }[] {
  const out: { text: string; cls: string }[] = [];
  highlightTree(supports[mode]!.language.parser.parse(doc), openideaHighlightStyle, (from, to, cls) => {
    out.push({ text: doc.slice(from, to), cls });
  });
  return out;
}

function expectTokens(mode: string, doc: string, expected: readonly (readonly [string, Tag])[]) {
  const got = tokens(mode, doc);
  for (const [text, tag] of expected) {
    const cls = openideaHighlightStyle.style([tag]);
    expect(cls, String(tag)).toBeTruthy();
    expect(got, text).toContainEqual({ text, cls });
  }
}

/** No string-coloured token contains `text`: the literal's body is not one string. */
function expectNotString(mode: string, doc: string, text: string) {
  const string = openideaHighlightStyle.style([t.string]);
  expect(tokens(mode, doc).filter((tok) => tok.cls === string && tok.text.includes(text))).toEqual([]);
}

describe("template literal languages", () => {
  it("highlights CSS in styled-components and emotion templates", () => {
    const doc = [
      "const Button = styled.button`",
      "  color: ${(p) => p.color};",
      "  padding: 4px 8px;",
      "  &:hover { background: #fff; }",
      "`;",
      "const Link = styled(Anchor).attrs({ role: 'link' })`margin: 0;`;",
      "const Global = createGlobalStyle`body { margin: 0 }`;",
      "const spin = keyframes`from { opacity: 0 } to { opacity: 1 }`;",
      "const mixin = css`display: flex;`;",
    ].join("\n");
    expectTokens("JavaScript", doc, [
      ["color", t.attributeName],
      ["padding", t.attributeName],
      ["4", t.number],
      ["px", t.attributeValue],
      ["background", t.attributeName],
      ["#fff", t.tagName],
      ["margin", t.attributeName],
      ["body", t.tagName],
      ["opacity", t.attributeName],
      ["display", t.attributeName],
      ["flex", t.attributeValue],
      // The substitution stays JavaScript.
      ["=>", t.punctuation],
    ]);
    expectNotString("JavaScript", doc, "padding");
  });

  it("follows TypeScript type arguments on the tag", () => {
    expectTokens("TypeScript", "const Box = styled.div<{ gap: number }>`gap: ${(p) => p.gap}px;`;", [
      ["gap", t.attributeName],
      ["number", t.typeName],
    ]);
  });

  it("highlights GraphQL in gql and graphql templates and calls", () => {
    const doc = [
      "const HERO = gql`",
      "  query Hero($id: ID!, $first: Int = 10) @cached {",
      "    hero(id: $id, episode: JEDI) { name friends(first: $first) { ...Friend } }",
      "  }",
      "  fragment Friend on Character { name }",
      "`;",
      "const Me = graphql(`query Me { me { id } }`, [Friend]);",
    ].join("\n");
    expectTokens("TypeScript", doc, [
      ["query", t.keyword],
      ["Hero", t.function(t.variableName)],
      ["$id", t.variableName],
      ["ID", t.typeName],
      ["Int", t.typeName],
      ["10", t.number],
      ["@cached", t.annotation],
      ["hero", t.propertyName],
      ["episode", t.variableName],
      ["JEDI", t.constant(t.variableName)],
      ["Friend", t.function(t.variableName)],
      ["fragment", t.keyword],
      ["Character", t.typeName],
      ["Me", t.function(t.variableName)],
      ["me", t.propertyName],
    ]);
  });

  it("highlights GraphQL schema definitions", () => {
    const doc = [
      "const typeDefs = gql`",
      "  type Query implements Node { hero(episode: Episode = JEDI): [Character!]! }",
      "  enum Episode { NEWHOPE JEDI }",
      "  union Result = Human | Droid",
      "`;",
    ].join("\n");
    expectTokens("JavaScript", doc, [
      ["type", t.keyword],
      ["Query", t.typeName],
      ["Node", t.typeName],
      ["hero", t.propertyName],
      ["episode", t.variableName],
      ["Episode", t.typeName],
      ["Character", t.typeName],
      ["NEWHOPE", t.constant(t.variableName)],
      ["Human", t.typeName],
      ["Droid", t.typeName],
    ]);
  });

  it("highlights SQL and HTML templates", () => {
    const doc = [
      "const rows = await sql`SELECT id, name FROM users WHERE id = ${id}`;",
      'const view = html`<button class="primary" @click=${go}>Go</button>`;',
    ].join("\n");
    expectTokens("JavaScript", doc, [
      ["SELECT", t.keyword],
      ["FROM", t.keyword],
      ["WHERE", t.keyword],
      ["button", t.tagName],
      ["class", t.attributeName],
      ['"primary"', t.attributeValue],
    ]);
    expectNotString("JavaScript", doc, "SELECT");
  });

  it("highlights a literal a /* language */ comment names", () => {
    expectTokens("TSX", "const q = /* GraphQL */ `query Q { a }`;\nconst s = /* sql */ `SELECT 1`;", [
      ["query", t.keyword],
      ["Q", t.function(t.variableName)],
      ["SELECT", t.keyword],
    ]);
  });

  it("leaves other template literals strings", () => {
    const doc = "const a = `color: red;`;\nconst b = tag`query Q { a }`;\nconst c = /* note */ `SELECT 1`;";
    const string = openideaHighlightStyle.style([t.string]);
    for (const text of ["`color: red;`", "`query Q { a }`", "`SELECT 1`"])
      expect(tokens("JavaScript", doc)).toContainEqual({ text, cls: string });
  });

  it("injects into Angular TypeScript files too", () => {
    expectTokens(
      "Angular TypeScript",
      "@Component({ template: '<p>{{ name }}</p>' })\nclass A {}\nconst q = gql`query Q { a }`;",
      [
        ["p", t.tagName],
        ["query", t.keyword],
      ],
    );
  });

  it.each([
    ["css", "tag", "const a = css`color: red;`;", "`color: red;`"],
    ["GraphQL", "note", "const a = /* GraphQL */ `query Q { a }`;", "`query Q { a }`"],
  ])("re-parses the literal when its %s tag changes", (from, to, doc, literal) => {
    let state = EditorState.create({ doc, extensions: [supports.JavaScript!] });
    ensureSyntaxTree(state, state.doc.length, 5000);
    const at = doc.indexOf(from);
    state = state.update({ changes: { from: at, to: at + from.length, insert: to } }).state;
    const tree = ensureSyntaxTree(state, state.doc.length, 5000)!;
    const parsed: string[] = [];
    highlightTree(tree, openideaHighlightStyle, (from, to) => parsed.push(state.sliceDoc(from, to)));
    expect(parsed).toContain(literal);
  });

  it("comments lines with the embedded language's comment syntax", () => {
    const doc = "const q = gql`\n  query Q { a }\n`;";
    let state = EditorState.create({
      doc,
      selection: { anchor: doc.indexOf("query") },
      extensions: [supports.JavaScript!],
    });
    ensureSyntaxTree(state, state.doc.length, 5000);
    toggleComment({ state, dispatch: (tr) => (state = tr.state) });
    expect(state.doc.line(2).text).toBe("  # query Q { a }");
  });
});
