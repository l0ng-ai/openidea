import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EditorState } from "@codemirror/state";
import { foldable, matchBrackets } from "@codemirror/language";
import type { Tree } from "@lezer/common";
import { buildParserFile } from "@lezer/generator";
import { highlightTree, tagHighlighter, tags as t } from "@lezer/highlight";
import { completedSyntaxState, completedSyntaxTree } from "@/test/syntax";
import { findLanguageDescription, loadSupport } from "../languages";
import { jsp, jspLanguage } from "./index";

const highlighter = tagHighlighter([
  { tag: t.processingInstruction, class: "pi" },
  { tag: t.special(t.brace), class: "el" },
  { tag: t.blockComment, class: "comment" },
  { tag: t.operatorKeyword, class: "opkw" },
  { tag: t.keyword, class: "keyword" },
  { tag: t.bool, class: "bool" },
  { tag: t.namespace, class: "ns" },
  { tag: t.typeName, class: "type" },
  { tag: t.definition(t.variableName), class: "def" },
  { tag: t.function(t.variableName), class: "call" },
  { tag: t.function(t.propertyName), class: "method" },
  { tag: t.variableName, class: "var" },
  { tag: t.propertyName, class: "prop" },
  { tag: t.attributeName, class: "attr" },
  { tag: t.attributeValue, class: "value" },
  { tag: t.string, class: "str" },
  { tag: t.number, class: "num" },
  { tag: t.tagName, class: "tag" },
]);

/** `text:class` of the styled tokens of `doc`, from `tree` or a fresh parse. */
function tokens(doc: string, tree: Tree = jspLanguage.parser.parse(doc)): string[] {
  const out: string[] = [];
  highlightTree(tree, highlighter, (from, to, cls) => out.push(`${doc.slice(from, to)}:${cls}`));
  return out;
}

/** The error nodes of `doc`'s tree, with the text they start. */
function errors(doc: string): string[] {
  const out: string[] = [];
  jspLanguage.parser.parse(doc).iterate({
    enter: (node) => void (node.type.isError && out.push(doc.slice(node.from, node.from + 8))),
  });
  return out;
}

/** The tree of `state`, parsed to the end. */
function stateTree(state: EditorState): Tree {
  return completedSyntaxTree(state, 5000);
}

/** A ~8 KB page with directives, scriptlets around markup, expressions and EL. */
function page(): string {
  let doc = `<%@ page contentType="text/html;charset=UTF-8" %>\n<%@ taglib prefix="c" uri="jakarta.tags.core" %>\n`;
  for (let i = 0; i < 40; i++) {
    doc +=
      `<%-- row ${i} --%>\n<% if (rows${i} != null) { %>\n` +
      `  <tr class="r${i}"><td><%= rows${i}.size() %></td><td>\${fn:length(names${i})}</td></tr>\n` +
      `<% } %>\n<c:out value="\${user${i}.name}"/>\n`;
  }
  return doc;
}

describe("JSP pages", () => {
  it("highlights directives and JSP comments", () => {
    expect(tokens(`<%@ page import="java.util.*" %><%-- <b>off</b> --%>`)).toEqual([
      "<%@:pi",
      "page:keyword",
      "import:attr",
      '"java.util.*":value',
      "%>:pi",
      "<%-- <b>off</b> --%>:comment",
    ]);
  });

  it("parses the scriptlets as one Java body, around the markup", () => {
    const doc = `<% for (String s : list) { %><li><%= s %></li><% } %>`;
    expect(errors(doc)).toEqual([]);
    expect(tokens(doc)).toEqual([
      "<%:pi",
      "for:keyword",
      "String:type",
      "s:def",
      "list:var",
      "%>:pi",
      "li:tag",
      "<%=:pi",
      "s:var",
      "%>:pi",
      "li:tag",
      "<%:pi",
      "%>:pi",
    ]);
    const state = completedSyntaxState(EditorState.create({ doc, extensions: jsp() }));
    const open = doc.indexOf("{");
    expect(matchBrackets(state, open, 1)?.end?.from).toBe(doc.lastIndexOf("}"));
  });

  it("keeps markup in a scriptlet's strings out of the page", () => {
    const doc = `<% String cell = "<td>"; %><p>x</p>`;
    expect(errors(doc)).toEqual([]);
    expect(tokens(doc)).toContain('"<td>":str');
    expect(tokens(doc).filter((s) => s.endsWith(":tag"))).toEqual(["p:tag", "p:tag"]);
  });

  it("highlights expressions and declarations as Java", () => {
    const doc = `<%= name %><%= req.getParameter("q") %><%! private int count = 0; %>`;
    expect(errors(doc)).toEqual([]);
    expect(tokens(doc)).toEqual([
      "<%=:pi",
      "name:var",
      "%>:pi",
      "<%=:pi",
      "req:var",
      "getParameter:call",
      '"q":str',
      "%>:pi",
      "<%!:pi",
      "private:keyword",
      "int:type",
      "count:def",
      "0:num",
      "%>:pi",
    ]);
  });

  it("highlights EL expressions", () => {
    const doc = `<p>\${fn:escapeXml(item.title)} #{a ? b : not empty c.d[0] and x.size() gt 2}</p>`;
    expect(errors(doc)).toEqual([]);
    expect(tokens(doc)).toEqual([
      "p:tag",
      "${:el",
      "fn:ns",
      "escapeXml:call",
      "item:var",
      "title:prop",
      "}:el",
      "#{:el",
      "a:var",
      "b:var",
      "not:opkw",
      "empty:opkw",
      "c:var",
      "d:prop",
      "0:num",
      "and:opkw",
      "x:var",
      "size:method",
      "gt:opkw",
      "2:num",
      "}:el",
      "p:tag",
    ]);
  });

  it("ends an EL expression at its own brace, past nested ones and strings", () => {
    const doc = `\${ {'k': '}'}.k == true }<b>`;
    expect(errors(doc)).toEqual([]);
    expect(tokens(doc)).toEqual(["${:el", "'k':str", "'}':str", "k:prop", "true:bool", "}:el", "b:tag"]);
  });

  it("parses markup with elements in attribute values and custom tags", () => {
    const doc =
      `<c:forEach var="i" items="\${items}"><c:out value="\${i}"/></c:forEach>` +
      `<input value="<%= x %>" onclick="go('<%= id %>')"><jsp:include page="f.jspf"/><p></p>`;
    expect(errors(doc)).toEqual([]);
    expect(tokens(doc).slice(0, 8)).toEqual([
      "c:forEach:tag",
      "var:attr",
      '"i":value',
      "items:attr",
      '":value',
      "${:el",
      "items:var",
      "}:el",
    ]);
  });

  it("parses EL in a script as EL, like the container", () => {
    expect(tokens(`<script>let n = \`\${user.name}\`;</script>`)).toContain("user:var");
  });

  it("keeps escaped elements as text", () => {
    expect(tokens(`<p>\\\${a} <\\% b %></p>`)).toEqual(["p:tag", "p:tag"]);
  });

  it("comments with JSP comments in the markup and Java ones in scriptlets", () => {
    const doc = `<p>x</p><% int a; %>`;
    const state = completedSyntaxState(EditorState.create({ doc, extensions: jsp() }));
    const at = (pos: number) =>
      state.languageDataAt<{ line?: string; block?: { open: string } }>("commentTokens", pos)[0];
    expect(at(4)?.block?.open).toBe("<%--");
    expect(at(doc.indexOf("int") + 1)?.line).toBe("//");
  });

  it("folds JSP comments and scriptlets", () => {
    const doc = `<%--\n a\n--%>\n<%\n int a;\n%>`;
    const state = completedSyntaxState(EditorState.create({ doc, extensions: jsp() }));
    expect(foldable(state, 0, 4)).toEqual({ from: 4, to: doc.indexOf("--%>") });
    const line = state.doc.line(4);
    expect(foldable(state, line.from, line.to)).toEqual({ from: line.to, to: doc.lastIndexOf("%>") });
  });

  it("highlights like a fresh parse after resuming and editing", () => {
    const doc = page();
    // Opening parses the first 3000 characters; the rest resumes from that tree.
    let state = EditorState.create({ doc, extensions: jsp() });
    expect(tokens(doc, stateTree(state))).toEqual(tokens(doc));
    const at = (text: string, n = 1) => {
      let pos = -1;
      for (let i = 0; i < n; i++) pos = state.doc.toString().indexOf(text, pos + 1);
      return pos;
    };
    const edits = [
      () => ({ from: at("rows12.size()") + 4, insert: "x" }),
      () => ({ from: at(".size() %>", 15) + 7, insert: "+1" }),
      () => ({ from: at("<% } %>", 20), insert: "<% int k = 0; %>\n" }),
      () => ({ from: at("<%-- row 7"), to: at("<%-- row 7") + 4 }),
      () => ({ from: at("names3"), to: at("names3") + 6, insert: "a.b[0]" }),
      () => ({ from: 0, insert: "${top}\n" }),
      () => ({ from: at("<tr", 10), insert: "<%= " }),
    ];
    for (const edit of edits) {
      state = state.update({ changes: edit() }).state;
      const text = state.doc.toString();
      expect(tokens(text, stateTree(state))).toEqual(tokens(text));
    }
  });

  it("is generated from jsp.grammar", () => {
    const dir = import.meta.dirname;
    const { parser, terms } = buildParserFile(readFileSync(resolve(dir, "jsp.grammar"), "utf8"), {
      fileName: "src/editor/core/cm/jsp/jsp.grammar",
      moduleStyle: "es",
      typeScript: true,
    });
    expect(parser).toBe(readFileSync(resolve(dir, "parser.ts"), "utf8"));
    expect(terms).toBe(readFileSync(resolve(dir, "parser.terms.ts"), "utf8"));
  });

  it("is the JSP mode", async () => {
    const desc = findLanguageDescription("JSP", "/p/index.jsp");
    expect((await loadSupport(desc!))?.language).toBe(jspLanguage);
  });
});
