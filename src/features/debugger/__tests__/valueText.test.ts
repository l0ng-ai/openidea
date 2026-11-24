import { describe, expect, it } from "vitest";
import type { Variable } from "@/platform/ipc";
import { stringText, valueText } from "../valueText";

const v = (name: string, value: string, variablesReference = 0): Variable =>
  ({ name, value, variablesReference, typeName: null, evaluateName: null }) as Variable;

const fetcher = (tree: Record<number, Variable[]>) => async (ref: number) => tree[ref] ?? [];

describe("valueText", () => {
  it("returns a scalar as is", async () => {
    expect(await valueText({ value: "42", reference: 0 }, fetcher({}))).toBe("42");
  });

  it("copies a PHP array with its nested elements", async () => {
    const tree = {
      1: [v("name", '"Ann"'), v("tags", "array(2)", 2)],
      2: [v("0", '"a"'), v("1", '"b"')],
    };
    expect(await valueText({ value: "array(2)", reference: 1 }, fetcher(tree))).toBe(
      ["array(2)", '  name: "Ann"', "  tags: array(2)", '    0: "a"', '    1: "b"'].join("\n"),
    );
  });

  it("does not open a lazy child, whose reference holds only its uncomputed value", async () => {
    const tree = { 1: [{ ...v("total", "(...)", 2), lazy: true }], 2: [v("", "3")] };
    expect(await valueText({ value: "Cart", reference: 1 }, fetcher(tree))).toBe("Cart\n  total: (...)");
  });

  it("stops at a cycle", async () => {
    const tree = { 1: [v("self", "Node", 1)] };
    expect(await valueText({ value: "Node", reference: 1 }, fetcher(tree))).toBe("Node\n  self: Node");
  });

  it("truncates past the entry limit", async () => {
    const tree = { 1: [v("0", "a"), v("1", "b"), v("2", "c")] };
    const text = await valueText({ value: "arr", reference: 1 }, fetcher(tree), { depth: 8, entries: 2 });
    expect(text).toBe("arr\n  0: a\n  1: b\n  …");
  });

  it("truncates past the depth limit", async () => {
    const tree = { 1: [v("a", "x", 2)], 2: [v("b", "y", 3)], 3: [v("c", "z")] };
    const text = await valueText({ value: "r", reference: 1 }, fetcher(tree), { depth: 2, entries: 100 });
    expect(text).toBe("r\n  a: x\n    b: y\n      …");
  });
});

describe("stringText (#4747)", () => {
  it("shows a quoted string as its text, escapes resolved", () => {
    expect(stringText('"Name: app\\nPort: \\"3306\\"\\tok\\\\"')).toBe('Name: app\nPort: "3306"\tok\\');
    expect(stringText("'it\\'s'")).toBe("it's");
    expect(stringText('"caf\\u00e9 \\x41 \\u{1F600}"')).toBe("café A 😀");
  });

  it("leaves anything that isn't one quoted literal alone", () => {
    for (const value of ["42", "[]string len: 2", '"a" + "b', "Foo@12"]) expect(stringText(value)).toBe(value);
  });
});
