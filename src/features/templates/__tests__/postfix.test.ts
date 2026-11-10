import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { completedSyntaxState } from "@/test/syntax";
import { languages } from "@codemirror/language-data";
import {
  candidatesFor,
  findPostfixTarget,
  isCompound,
  postfixTemplatesFor,
  scanExpressionStart,
} from "../postfix/model";
import { expandTemplate } from "../live/model";

const MODES: Record<string, string> = {
  typescript: "TypeScript",
  rust: "Rust",
  python: "Python",
  go: "Go",
  java: "Java",
  kotlin: "Kotlin",
};

async function target(language: string, doc: string) {
  const desc = languages.find((l) => l.name === MODES[language])!;
  const state = completedSyntaxState(EditorState.create({ doc, extensions: [await desc.load()] }));
  return findPostfixTarget(state, doc.length, language);
}

const scan = (text: string, language: string) => text.slice(scanExpressionStart(text, text.length, language));

describe("expression scanning", () => {
  it("handles call chains, indexing, strings and generics", () => {
    expect(scan("const x = foo.bar(1, (2)).baz[0]", "typescript")).toBe("foo.bar(1, (2)).baz[0]");
    expect(scan('return "a.b".length', "typescript")).toBe('"a.b".length');
    expect(scan("let v = vec![1, 2].iter().map(|x| x * 2)", "rust")).toBe("vec![1, 2].iter().map(|x| x * 2)");
    expect(scan("    file.read()?", "rust")).toBe("file.read()?");
    expect(scan("x = Foo::<u8>::new()", "rust")).toBe("Foo::<u8>::new()");
    expect(scan("var a = new ArrayList<String>()", "java")).toBe("new ArrayList<String>()");
    expect(scan("val n = user?.name!!", "kotlin")).toBe("user?.name!!");
    expect(scan("print(len(xs))", "python")).toBe("print(len(xs))");
    expect(scan("a + b", "go")).toBe("b");
    expect(scan("  f(", "go")).toBe("");
  });

  it("detects compound expressions", () => {
    expect(isCompound("a + b")).toBe(true);
    expect(isCompound("a.b(c + d)")).toBe(false);
    expect(isCompound("Foo::new()")).toBe(false);
    expect(isCompound("user?.name")).toBe(false);
    expect(isCompound("x > 0")).toBe(true);
  });
});

describe("postfix target", () => {
  it("TypeScript: call chain and wider binary expression", async () => {
    const t = (await target("typescript", "items.filter(Boolean).for"))!;
    expect(t.key).toBe("for");
    expect(t.candidates.map((c) => c.text)).toEqual(["items.filter(Boolean)"]);
    expect(t.candidates[0]!.statement).toBe(true);

    const b = (await target("typescript", "a + b.if"))!;
    expect(b.candidates.map((c) => c.text)).toEqual(["b", "a + b"]);
    const tpl = postfixTemplatesFor("typescript").find((x) => x.key === "if")!;
    expect(candidatesFor(tpl, b).map((c) => c.text)).toEqual(["a + b"]);
  });

  it("Rust: method chain with ?", async () => {
    const t = (await target("rust", "fn f() {\n    std::fs::read(path)?.len().let"))!;
    expect(t.key).toBe("let");
    expect(t.candidates[0]!.text).toBe("std::fs::read(path)?.len()");
  });

  it("Python: not a statement inside a call", async () => {
    const t = (await target("python", "print(xs.len"))!;
    expect(t.candidates[0]!.text).toBe("xs");
    expect(t.candidates[0]!.statement).toBe(false);
    const ifT = postfixTemplatesFor("python").find((x) => x.key === "if")!;
    expect(candidatesFor(ifT, t)).toEqual([]);
  });

  it("Go, Java, Kotlin", async () => {
    expect((await target("go", "func f() {\n\tos.Open(name).var"))!.candidates[0]!.text).toBe("os.Open(name)");
    expect((await target("java", "class A { void f() {\n  new Foo(1).var"))!.candidates[0]!.text).toBe("new Foo(1)");
    expect((await target("kotlin", "fun f() {\n  user?.name.nn"))!.candidates[0]!.text).toBe("user?.name");
  });

  it("returns null without a key position or expression", async () => {
    expect(await target("typescript", "foo")).toBeNull();
    expect(await target("typescript", "  .if")).toBeNull();
    expect(await target("typescript", "x = 1.")).toBeNull();
  });

  it("expands with $EXPR$ and a suggested name", () => {
    const tpl = postfixTemplatesFor("typescript").find((x) => x.key === "const")!;
    const e = expandTemplate(tpl, {
      predefined: { EXPR: "user.getName()" },
      fns: { suggestVariableName: () => "name" },
    });
    expect(e.snippet).toBe("const ${1:name} = user.getName();${0}");
  });

  it("every language has the core keys", () => {
    for (const lang of ["typescript", "rust", "python", "go", "java", "kotlin"]) {
      const keys = postfixTemplatesFor(lang).map((t) => t.key);
      for (const k of ["if", "not", "return", "par", "nn"].filter((k) => !(lang === "rust" && k === "nn")))
        expect(keys).toContain(k);
    }
    expect(postfixTemplatesFor("typescript", new Set(["ts.if"])).some((t) => t.key === "if")).toBe(false);
  });
});
