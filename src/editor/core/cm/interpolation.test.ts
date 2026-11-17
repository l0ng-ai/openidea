import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { getIndentation, indentUnit } from "@codemirror/language";
import { completedSyntaxTree } from "@/test/syntax";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { findLanguageDescription, loadSupport, loadedSupport } from "./languages";

async function tokens(mode: string, source: string) {
  const desc = findLanguageDescription(mode, "")!;
  const support = await loadSupport(desc);
  expect(loadedSupport(desc)).toBe(support);
  const state = EditorState.create({ doc: source, extensions: [support!] });
  const result: { text: string; style: string; from: number; to: number }[] = [];
  highlightTree(completedSyntaxTree(state), classHighlighter, (from, to, style) =>
    result.push({ text: source.slice(from, to), style, from, to }),
  );
  return result;
}

describe("Kotlin soft keywords", () => {
  const styleOf = (out: Awaited<ReturnType<typeof tokens>>, text: string, nth = 0) =>
    out.filter((t) => t.text === text)[nth]?.style ?? "";

  it("colours a soft keyword only where it acts as one", async () => {
    const source = [
      "import top.ttb.data.Model",
      "data class Point(val x: Int)",
      "open class Base { val data = result.data; private fun f() {} }",
      "val open: Int get() = 1",
      "fun g(data: String) = try { } catch (e: Exception) { } finally { }",
    ].join("\n");
    const out = await tokens("Kotlin", source);
    // Package path, property access and names.
    expect(styleOf(out, "data", 0)).not.toContain("tok-keyword");
    expect(styleOf(out, "data", 2)).not.toContain("tok-keyword");
    expect(styleOf(out, "data", 3)).not.toContain("tok-keyword");
    expect(styleOf(out, "data", 4)).not.toContain("tok-keyword");
    expect(styleOf(out, "open", 1)).not.toContain("tok-keyword");
    // Modifiers and accessors.
    expect(styleOf(out, "import")).toContain("tok-keyword");
    expect(styleOf(out, "data", 1)).toContain("tok-keyword");
    expect(styleOf(out, "open", 0)).toContain("tok-keyword");
    expect(styleOf(out, "private")).toContain("tok-keyword");
    expect(styleOf(out, "get")).toContain("tok-keyword");
    expect(styleOf(out, "catch")).toContain("tok-keyword");
    expect(styleOf(out, "finally")).toContain("tok-keyword");
    // Hard keywords stay keywords.
    expect(styleOf(out, "class")).toContain("tok-keyword");
    expect(styleOf(out, "val")).toContain("tok-keyword");
    expect(styleOf(out, "fun")).toContain("tok-keyword");
  });
});

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

  it.each(["Kotlin", "Scala", "Dart", "Groovy", "C#"])(
    "%s indents brackets opened after a string from the line's indentation",
    async (mode) => {
      const support = await loadSupport(findLanguageDescription(mode, "")!);
      const doc = 'f(\n    pair("a", g(\n        x\n    )),\n)';
      const state = EditorState.create({
        doc,
        extensions: [support!, indentUnit.of("    "), EditorState.tabSize.of(4)],
      });
      completedSyntaxTree(state);
      const indent = (line: number) => getIndentation(state, state.doc.line(line).from);
      expect(indent(3)).toBe(8);
      // C#'s mode leaves a closing bracket's indentation to the editor.
      if (mode !== "C#") expect(indent(4)).toBe(4);
    },
  );

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
