import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { findLanguageDescription, loadSupport } from "./languages";

async function tokens(source: string) {
  const desc = findLanguageDescription("ERB", "show.html.erb")!;
  const support = await loadSupport(desc);
  const state = EditorState.create({ doc: source, extensions: [support!] });
  ensureSyntaxTree(state, source.length, 1000);
  const result: { text: string; style: string }[] = [];
  highlightTree(syntaxTree(state), classHighlighter, (from, to, style) =>
    result.push({ text: source.slice(from, to), style }),
  );
  return result;
}

describe("ERB mode", () => {
  it("highlights HTML outside and Ruby inside the tags", async () => {
    const out = await tokens('<div class="x"><%= user.name if user %></div>\n<%# note %>\n<% 42 %>');
    expect(out).toContainEqual(expect.objectContaining({ text: "div", style: "tok-typeName" }));
    expect(out).toContainEqual(expect.objectContaining({ text: "if", style: "tok-keyword" }));
    expect(out).toContainEqual(expect.objectContaining({ text: "42", style: "tok-number" }));
    expect(out).toContainEqual(expect.objectContaining({ text: "<%# note %>", style: "tok-comment" }));
    expect(out.filter((t) => t.text === "<%=" || t.text === "%>")).toHaveLength(3);
  });

  it("keeps Ruby state across lines", async () => {
    const out = await tokens('<% s = "a\n<p>" %><p>');
    expect(out.filter((t) => t.text === "p")).toHaveLength(1);
  });
});
