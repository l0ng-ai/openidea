import { describe, expect, it } from "vitest";
import { clearContext, evaluateWhen, getContext, setContext } from "./context";

describe("when clauses", () => {
  const ctx = { editorFocus: true, lang: "rust", count: 2, debug: false };
  it.each([
    ["", true],
    ["editorFocus", true],
    ["!editorFocus", false],
    ["editorFocus && debug", false],
    ["editorFocus || debug", true],
    ["lang == rust", true],
    ["lang == 'rust'", true],
    ["lang != rust", false],
    ["count == 2", true],
    ["!(debug || !editorFocus)", true],
    ["missing", false],
  ])("%s → %s", (expr, expected) => {
    expect(evaluateWhen(expr, ctx)).toBe(expected);
  });

  it("rejects malformed clauses", () => {
    expect(() => evaluateWhen("a &&", ctx)).toThrow();
    expect(() => evaluateWhen("(a", ctx)).toThrow();
  });
});

describe("clearContext", () => {
  it("deletes the key and keeps the others", () => {
    setContext("a.x", 1);
    setContext("a.y", 2);
    clearContext("a.x");
    expect("a.x" in getContext()).toBe(false);
    expect(getContext()["a.y"]).toBe(2);
    clearContext("a.y");
  });

  it("does nothing for an absent key", () => {
    const before = getContext();
    clearContext("a.never");
    expect(getContext()).toBe(before);
  });
});
