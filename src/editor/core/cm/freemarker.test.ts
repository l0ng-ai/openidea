import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { completedSyntaxTree } from "@/test/syntax";
import { highlightTree, tagHighlighter, tags as t } from "@lezer/highlight";
import { findLanguageDescription, loadSupport } from "./languages";

const highlighter = tagHighlighter([
  { tag: t.keyword, class: "keyword" },
  { tag: t.string, class: "string" },
  { tag: t.number, class: "number" },
  { tag: t.bool, class: "bool" },
  { tag: t.operator, class: "operator" },
  { tag: t.comment, class: "comment" },
  { tag: t.variableName, class: "variable" },
  { tag: t.function(t.variableName), class: "macro" },
  { tag: t.standard(t.function(t.variableName)), class: "builtin" },
  { tag: t.propertyName, class: "property" },
  { tag: t.special(t.brace), class: "delimiter" },
  { tag: t.tagName, class: "tag" },
  { tag: t.attributeName, class: "attribute" },
]);

async function tokens(source: string) {
  const desc = findLanguageDescription("FreeMarker", "orders.ftl")!;
  const support = await loadSupport(desc);
  const state = EditorState.create({ doc: source, extensions: [support!] });
  const result: { text: string; style: string }[] = [];
  highlightTree(completedSyntaxTree(state), highlighter, (from, to, style) =>
    result.push({ text: source.slice(from, to), style }),
  );
  return result;
}

const styleOf = (out: { text: string; style: string }[], text: string) =>
  out.filter((t) => t.text === text).map((t) => t.style);

describe("FreeMarker mode", () => {
  it("highlights directives, user directives and their closing tags", async () => {
    const out = await tokens(
      '<#list orders as order>\n<#if order.paid>\n<@badge label="new"/>\n</#if>\n</#list>\n<#import "/lib.ftl" as lib>',
    );
    expect(styleOf(out, "list")).toEqual(["keyword", "keyword"]);
    expect(styleOf(out, "if")).toEqual(["keyword", "keyword"]);
    expect(styleOf(out, "as")).toEqual(["keyword", "keyword"]);
    expect(styleOf(out, "badge")).toEqual(["macro"]);
    expect(styleOf(out, "label")).toEqual(["variable"]);
    expect(styleOf(out, ".paid")).toEqual(["property"]);
    expect(styleOf(out, '"/lib.ftl"')).toEqual(["string"]);
    expect(out.filter((t) => ["<#", "</#", "<@", "/>"].includes(t.text)).length).toBe(7);
  });

  it("highlights the expression inside interpolations", async () => {
    const out = await tokens('<p>${user.name!"Guest"} ${items?size + 1} ${price?string("0.00")}</p>');
    expect(styleOf(out, "p")).toEqual(["tag", "tag"]);
    expect(styleOf(out, "!")).toEqual(["operator"]);
    expect(styleOf(out, '"Guest"')).toEqual(["string"]);
    expect(styleOf(out, "?size")).toEqual(["builtin"]);
    expect(styleOf(out, "?string")).toEqual(["builtin"]);
    expect(styleOf(out, "1")).toEqual(["number"]);
    expect(styleOf(out, "${")).toHaveLength(3);
  });

  it("ends a directive at `>` but not inside brackets, strings or a hash", async () => {
    const out = await tokens('<#if (a > 1) && b == ">">yes</#if>\n${ {"k": 1}.k }<b>');
    expect(styleOf(out, "yes")).toEqual([]);
    expect(styleOf(out, '">"')).toEqual(["string"]);
    expect(styleOf(out, "b")).toEqual(["variable", "tag"]);
    expect(styleOf(out, ".k")).toEqual(["property"]);
  });

  it("keeps comments and directives across lines, inside HTML attributes", async () => {
    const out = await tokens('<#-- one\ntwo -->\n<a href="${url}" <#if x>class="on"</#if>>\n<#assign\n  n = 2\n>');
    expect(styleOf(out, "<#-- one")).toEqual(["comment"]);
    expect(styleOf(out, "two -->")).toEqual(["comment"]);
    expect(styleOf(out, "url")).toEqual(["variable"]);
    expect(styleOf(out, "href")).toEqual(["attribute"]);
    expect(styleOf(out, "class")).toEqual(["attribute"]);
    expect(styleOf(out, "n")).toEqual(["variable"]);
    expect(styleOf(out, "2")).toEqual(["number"]);
  });

  it("follows the tag syntax of the first directive", async () => {
    const square = await tokens("[#ftl]\n[#-- note --]\n[#list xs as x][=x]<i>${x}</i>[/#list]\n<#if a>");
    expect(styleOf(square, "list")).toEqual(["keyword", "keyword"]);
    expect(styleOf(square, "[#-- note --]")).toEqual(["comment"]);
    expect(styleOf(square, "x")).toEqual(["variable", "variable", "variable"]);
    expect(styleOf(square, "if")).toEqual([]);

    const angle = await tokens("<#if a>[#list xs as x][=x]</#if>");
    expect(styleOf(angle, "list")).toEqual([]);
    expect(styleOf(angle, "x")).toEqual([]);
  });

  it("stays fast on a long template", async () => {
    const block = [
      "<#-- row -->",
      '<#list orders as order><tr class="${order.status?lower_case}">',
      '  <td>${order.name!"-"}</td><td>${order.total?string("0.00")}</td>',
      '  <#if order.items?size gt 3><@badge label="bulk"/></#if>',
      "</tr></#list>",
    ].join("\n");
    const source = Array.from({ length: 250 }, () => block).join("\n");
    const start = performance.now();
    const out = await tokens(source);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(styleOf(out, "?lower_case")).toHaveLength(250);
  });
});
