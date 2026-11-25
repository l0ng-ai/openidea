import { describe, expect, it } from "vitest";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { completedSyntaxTree } from "@/test/syntax";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { findLanguageDescription, loadSupport } from "./languages";
import { thymeleafAttributeCompletion } from "./thymeleaf";

async function tokens(source: string) {
  const desc = findLanguageDescription("Thymeleaf", "index.html")!;
  const support = await loadSupport(desc);
  const state = EditorState.create({ doc: source, extensions: [support!] });
  const result: { text: string; style: string }[] = [];
  highlightTree(completedSyntaxTree(state), classHighlighter, (from, to, style) =>
    result.push({ text: source.slice(from, to), style }),
  );
  return result;
}

function complete(source: string) {
  const pos = source.indexOf("|");
  const state = EditorState.create({ doc: source.replace("|", "") });
  return thymeleafAttributeCompletion(new CompletionContext(state, pos, true));
}

describe("Thymeleaf mode", () => {
  it("highlights th:* values as expressions and leaves other attributes alone", async () => {
    const out = await tokens(
      `<p th:text="\${user.name} ?: #{guest}" data-th-if="\${#lists.isEmpty(items)} and 2 > 1" title="\${x}">x</p>`,
    );
    expect(out.filter((t) => t.text === "${" || t.text === "#{")).toHaveLength(3);
    expect(out).toContainEqual(expect.objectContaining({ text: "user", style: "tok-variableName" }));
    expect(out.some((t) => t.text === "#lists")).toBe(true);
    expect(out).toContainEqual(expect.objectContaining({ text: "and", style: "tok-operator" }));
    expect(out).toContainEqual(expect.objectContaining({ text: "2", style: "tok-number" }));
    expect(out).toContainEqual(expect.objectContaining({ text: '"${x}"', style: "tok-string" }));
  });

  it("highlights literal substitutions and fragment expressions", async () => {
    const out = await tokens(
      `<a th:href="@{/u/{id}(id=\${u.id})}" th:replace="~{nav :: menu}" th:title="|Hi \${n}!|">`,
    );
    expect(out.filter((t) => t.text === "@{" || t.text === "~{")).toHaveLength(2);
    expect(out).toContainEqual(expect.objectContaining({ text: "|Hi ", style: "tok-string" }));
    expect(out).toContainEqual(expect.objectContaining({ text: "n", style: "tok-variableName" }));
    expect(out).toContainEqual(expect.objectContaining({ text: "::", style: "tok-operator" }));
  });
});

describe("thymeleafAttributeCompletion", () => {
  it("offers th: and data-th- attributes inside a start tag", () => {
    const th = complete("<div th:te|");
    expect(th?.options.map((o) => o.label)).toContain("th:text");
    expect(complete("<div data-th-|")?.options.map((o) => o.label)).toContain("data-th-each");
    expect(complete("<div class=x t|")?.from).toBe(13);
  });

  it("stays out of text, values and other attributes", () => {
    expect(complete("<p>th|")).toBeNull();
    expect(complete('<p title="a th|')).toBeNull();
    expect(complete("<p cla|")).toBeNull();
  });
});
