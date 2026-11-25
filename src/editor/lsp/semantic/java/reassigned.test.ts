import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { javaLanguage } from "@codemirror/lang-java";
import { semanticRanges } from "../index";
import { reassignedNames } from "./reassigned";

/** `name@line` (1-based) of every underlined name in a method body. */
function underlined(body: string) {
  const source = `class A {\n${body}\n}`;
  const doc = Text.of(source.split("\n"));
  return [...reassignedNames(javaLanguage.parser.parse(source), doc)]
    .sort((a, b) => a - b)
    .map((from) => `${doc.sliceString(from, source.slice(from).search(/\W/) + from)}@${doc.lineAt(from).number - 1}`);
}

describe("Java reassigned locals and parameters", () => {
  it("underlines a local at its declaration and every use once it is assigned again", () => {
    expect(
      underlined(`int sum(int[] xs) {
  int total = 0;
  for (int x : xs) total += x;
  return total;
}`),
    ).toEqual(["total@2", "total@3", "total@4"]);
  });

  it("leaves locals assigned once alone, including a late or branch-exclusive assignment", () => {
    expect(
      underlined(`void m(boolean c, int k) {
  int once = 1;
  int late;
  late = 2;
  String s;
  if (c) s = "a"; else if (k > 0) s = "b"; else s = "c";
  int t = c ? (late) : once;
  String u;
  switch (k) { case 1: u = "x"; break; default: u = "y"; }
  String v;
  switch (k) { case 1 -> v = "x"; default -> { v = "y"; } }
  final int f;
  f = 3;
  print(once, late, s, t, u, v, f);
}`),
    ).toEqual([]);
  });

  it("counts compound assignments, increments and two unconditional assignments", () => {
    expect(
      underlined(`void m() {
  int a = 0; a++;
  int b = 0; --b;
  int c; c = 1; c = 2;
  int d; d = 1; d *= 2;
}`),
    ).toEqual(["a@2", "a@2", "b@3", "b@3", "c@4", "c@4", "c@4", "d@5", "d@5", "d@5"]);
  });

  it("counts assignments in case groups that fall through, not ones separated by a jump", () => {
    expect(
      underlined(`void m(int k) {
  String a;
  switch (k) { case 1: a = "x"; case 2: a = "y"; break; }
  String b;
  switch (k) { case 1: b = "x"; if (k > 0) break; case 2: case 3: b = "y"; }
  String c;
  switch (k) { case 1: c = "x"; break; case 2: { c = "y"; return; } case 3: c = "z"; throw new Error(); default: c = "w"; }
  print(a, b, c);
}`),
    ).toEqual(["a@2", "a@3", "a@3", "b@4", "b@5", "b@5", "a@8", "b@8"]);
  });

  it("underlines a local assigned in a loop it is declared outside of, and loop counters", () => {
    expect(
      underlined(`void m(int n) {
  int last;
  while (n-- > 0) { last = n; }
  for (int i = 0; i < 3; i++) { int inner; inner = i; }
}`),
    ).toEqual(["n@1", "last@2", "n@3", "last@3", "n@3", "i@4", "i@4", "i@4", "i@4"]);
  });

  it("underlines every kind of parameter once it is assigned", () => {
    expect(
      underlined(`void m(int p, String... rest) {
  p = 1;
  for (String s : rest) s = s.trim();
  try { run(); } catch (RuntimeException e) { e = null; }
  Op op = (z) -> z++;
  call(y -> y = 2);
  if (rest instanceof Object o) o = null;
  rest = null;
}`),
    ).toEqual([
      "p@1",
      "rest@1",
      "p@2",
      "s@3",
      "rest@3",
      "s@3",
      "s@3",
      "e@4",
      "e@4",
      "z@5",
      "z@5",
      "y@6",
      "y@6",
      "rest@7",
      "o@7",
      "o@7",
      "rest@8",
    ]);
  });

  it("leaves final variables, resources and unassigned parameters alone", () => {
    expect(
      underlined(`void m(final int p, int q) {
  try (var r = open()) { use(r, p, q); }
  for (final String s : list) use(s);
}`),
    ).toEqual([]);
  });

  it("matches uses by declaration, not by name", () => {
    expect(
      underlined(`int x;
void m(int k) {
  this.x = 1;
  x = 2;
  { int k2 = 0; k2 = 1; }
  { int k2 = 0; use(k2); }
  Runnable r = new Runnable() { int k; public void run() { k = 1; } };
  for (int j = 0; j < 1; j++) {}
  for (int j : arr) use(j);
}`),
    ).toEqual(["k2@5", "k2@5", "j@8", "j@8", "j@8"]);
  });

  it("follows a local into lambdas and nested classes", () => {
    expect(
      underlined(`void m() {
  int n = 0;
  n = 1;
  Runnable r = () -> use(n);
  Object o = new Object() { int f = n; };
}`),
    ).toEqual(["n@2", "n@3", "n@4", "n@5"]);
  });

  it("adds the underline class to jdtls's variable and parameter tokens only", () => {
    const source = "class A { void m(int p) { int t = 0; t = p; p = 1; int k = p; } }";
    const doc = Text.of([source]);
    const at = (name: string, nth = 0) => {
      let i = -1;
      for (let n = 0; n <= nth; n++) i = source.indexOf(` ${name} `, i + 1) + 1;
      return [0, i, name.length];
    };
    const tokens = {
      tokenTypes: ["variable", "parameter"],
      tokenModifiers: ["declaration"],
      data: [...at("p"), 1, 1, ...at("t"), 0, 1, ...at("k"), 0, 1],
    };
    // `m` is coloured by the declaration fallback, which jdtls's tokens here don't cover.
    const classes = semanticRanges(doc, tokens, false, "java", javaLanguage.parser.parse(source))
      .map((r) => [source.slice(r.from, r.to), r.className])
      .filter(([name]) => name !== "m");
    expect(classes).toEqual([
      ["t", "cm-sem-declaration cm-sem-mutable"],
      ["p", "cm-sem-parameter cm-sem-declaration cm-sem-mutable"],
      ["k", "cm-sem-declaration"],
    ]);
  });
});
