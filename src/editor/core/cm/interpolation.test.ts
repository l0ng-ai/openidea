import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { findLanguageDescription, loadSupport, loadedSupport } from "./languages";

async function tokens(mode: string, source: string) {
  const desc = findLanguageDescription(mode, "")!;
  const support = await loadSupport(desc);
  expect(loadedSupport(desc)).toBe(support);
  const state = EditorState.create({ doc: source, extensions: [support!] });
  ensureSyntaxTree(state, source.length, 1000);
  const result: { text: string; style: string; from: number; to: number }[] = [];
  highlightTree(syntaxTree(state), classHighlighter, (from, to, style) =>
    result.push({ text: source.slice(from, to), style, from, to }),
  );
  return result;
}

describe("frontend string interpolation", () => {
  it.each([
    ["Kotlin", 'println("$i + 1 = ${i + 1}")'],
    ["Scala", 'println(s"$i + 1 = ${i + 1}")'],
    ["Dart", 'print("$i + 1 = ${i + 1}")'],
    ["Groovy", 'println("$i + 1 = ${i + 1}")'],
    ["C#", 'Console.WriteLine($"{i} + 1 = {i + 1}")'],
  ])("%s separates delimiters, names, operators and numbers", async (mode, source) => {
    const out = await tokens(mode, source);
    expect(out.filter((t) => t.text === "i")).toHaveLength(2);
    expect(out.filter((t) => t.text === "i").every((t) => t.style.includes("tok-variableName"))).toBe(true);
    expect(out).toContainEqual(expect.objectContaining({ text: "+", style: "tok-operator" }));
    expect(out).toContainEqual(expect.objectContaining({ text: "1", style: "tok-number" }));
    expect(out.some((t) => t.text === (mode === "C#" ? "{" : "${") && !t.style.includes("tok-string"))).toBe(true);
    expect(out.some((t) => t.text === "}" && !t.style.includes("tok-string"))).toBe(true);
  });

  it.each(["Kotlin", "Scala", "Dart", "Groovy", "C#"])(
    "%s keeps nested braces, strings and comments inside expressions",
    async (mode) => {
      const source =
        mode === "C#"
          ? '$"{call(new Foo { n = 2 }, "}") /* } */ + 1} tail"'
          : `${mode === "Scala" ? "s" : ""}"\${call({ n -> 2 }, "}") /* } */ + 1} tail"`;
      const out = await tokens(mode, source);
      expect(out).toContainEqual(expect.objectContaining({ text: "1", style: "tok-number" }));
      expect(out.some((t) => t.text.includes("tail") && t.style === "tok-string")).toBe(true);
      expect(out.some((t) => t.text.includes("/* } */") && t.style === "tok-comment")).toBe(true);
    },
  );

  it("handles Kotlin multiline raw templates and nested templates", async () => {
    const out = await tokens("Kotlin", 'val s = """raw \\$name\n${list.map { "${it + 1}" }} tail"""\nval after = 3');
    for (const text of ["name", "it", "after"])
      expect(out.some((t) => t.text === text && t.style.includes("variableName"))).toBe(true);
    expect(out.filter((t) => t.style === "tok-number").map((t) => t.text)).toEqual(["1", "3"]);
  });

  it.each([
    ["Kotlin", '"\\$name \\${value}"'],
    ["Scala", '"$name ${value}"'],
    ["Scala", 's"$$name"'],
    ["Dart", 'r"$name ${value}"'],
    ["Groovy", "'$name ${value}'"],
    ["C#", '$"{{value}}"'],
  ])("%s preserves literal dollars and braces in %s", async (mode, source) => {
    const out = await tokens(mode, source);
    expect(out.filter((t) => t.style !== "tok-string" && t.text !== "r")).toEqual(
      mode === "Scala" && source.startsWith("s") ? [expect.objectContaining({ text: "s" })] : [],
    );
  });

  it("handles C# verbatim interpolation and doubled quotes", async () => {
    const out = await tokens("C#", '$@"say ""hello"" {i + 1}\nend"');
    expect(out).toContainEqual(expect.objectContaining({ text: "1", style: "tok-number" }));
    expect(out.some((t) => t.text.includes('say ""hello""') && t.style === "tok-string")).toBe(true);
  });
  it("handles C# raw interpolation with multiple-dollar delimiters", async () => {
    const out = await tokens("C#", '$$"""literal {brace} {{i + 1}} tail"""');
    expect(out).toContainEqual(expect.objectContaining({ text: "1", style: "tok-number" }));
    expect(out.some((t) => t.text === "{{" && !t.style.includes("string"))).toBe(true);
    expect(out.some((t) => t.text === "}}" && !t.style.includes("string"))).toBe(true);
    expect(out.some((t) => t.text.includes("{brace}") && t.style === "tok-string")).toBe(true);
  });

  it("keeps Groovy dotted interpolation in code", async () => {
    const out = await tokens("Groovy", '"$person.name tail"');
    expect(out).toContainEqual(expect.objectContaining({ text: "name", style: "tok-variableName" }));
    expect(out.some((t) => t.text.includes("tail") && t.style === "tok-string")).toBe(true);
  });
  it.each([
    ["Kotlin", "a.kt"],
    ["Scala", "a.scala"],
    ["Dart", "a.dart"],
    ["Groovy", "a.groovy"],
    ["C#", "a.cs"],
    ["Shell", "a.sh"],
  ])("%s uses the same patched mode by name, alias and filename", (mode, path) => {
    const description = findLanguageDescription(mode, path);
    expect(findLanguageDescription(null, path)).toBe(description);
    expect(findLanguageDescription(mode.toLowerCase(), path)).toBe(description);
  });
});
