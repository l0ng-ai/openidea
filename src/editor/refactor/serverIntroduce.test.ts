import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { CodeAction } from "@/bindings";

const { openPopup, applyCodeAction } = vi.hoisted(() => ({
  openPopup: vi.fn(),
  applyCodeAction: vi.fn(async () => {}),
}));
vi.mock("@/editor/lsp/popupStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/editor/lsp/popupStore")>()),
  openPopup,
}));
vi.mock("@/editor/lsp/intentions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/editor/lsp/intentions")>()),
  applyCodeAction,
}));

const { chooseOccurrences, introducedName, occurrenceVariants } = await import("./serverIntroduce");

const spansText = (text: string, spans: { from: number; to: number }[]) => spans.map((s) => text.slice(s.from, s.to));

describe("introducedName", () => {
  it("finds the server's variable: declaration and replaced occurrence", () => {
    const before = "function f() {\n  return price * 2 + 1;\n}\n";
    const after = "function f() {\n  const newLocal = price * 2;\n  return newLocal + 1;\n}\n";
    const found = introducedName(before, after)!;
    expect(found.name).toBe("newLocal");
    expect(found.spans).toHaveLength(2);
    expect(spansText(after, found.spans)).toEqual(["newLocal", "newLocal"]);
  });

  it("ignores names that were already there and keywords / types written once", () => {
    const before = "void f() {\n  g(a.b(), a.b());\n}\n";
    const after = "void f() {\n  String b = a.b();\n  g(b, b);\n}\n";
    const found = introducedName(before, after)!;
    expect(found.name).toBe("b");
    // `b` already existed in `a.b()`; only the three new tokens count.
    expect(found.spans.map((s) => after.slice(s.from - 1, s.to + 1))).toEqual([" b ", "(b,", " b)"]);
  });

  it("handles an extracted function placed after its call", () => {
    const before = "fn main() {\n    let x = 1 + 2;\n}\n";
    const after = "fn main() {\n    let x = fun_name();\n}\n\nfn fun_name() -> i32 {\n    1 + 2\n}\n";
    expect(introducedName(before, after)?.name).toBe("fun_name");
  });

  it("is null without a new name used twice", () => {
    expect(introducedName("a + b", "(a + b)")).toBeNull();
    expect(introducedName("x", "x")).toBeNull();
  });
});

describe("occurrenceVariants", () => {
  const action = (title: string): CodeAction => ({
    title,
    kind: "refactor.extract.variable",
    isPreferred: false,
    disabledReason: null,
    edit: null,
    command: null,
    data: null,
    server: 1,
  });

  it("pairs the single and the all-occurrences action", () => {
    const one = action("Extract to local variable");
    const all = action("Extract to local variable (replace all occurrences)");
    expect(occurrenceVariants([one, all])).toEqual({ one, all });
    expect(occurrenceVariants([one])).toBeNull();
    expect(occurrenceVariants([one, action("Extract to field"), all])).toBeNull();
  });
});

describe("chooseOccurrences", () => {
  const action = (title: string) => ({ title, kind: "refactor.extract.variable", server: 1 }) as CodeAction;
  const one = action("Extract to local variable");
  const all = action("Extract to local variable (replace all occurrences)");
  const viewOf = (doc: string, selected: string) => {
    const from = doc.indexOf(selected);
    return new EditorView({
      state: EditorState.create({ doc, selection: { anchor: from, head: from + selected.length } }),
    });
  };

  it("asks when the selected expression occurs more than once", () => {
    openPopup.mockClear();
    expect(chooseOccurrences(viewOf("f(a + b); g(a + b);", "a + b"), [one, all], "extractVariable")).toBe(true);
    expect(openPopup).toHaveBeenCalledWith(expect.objectContaining({ title: "Multiple occurrences found" }));
  });

  it("introduces it directly when it occurs once", async () => {
    openPopup.mockClear();
    applyCodeAction.mockClear();
    expect(chooseOccurrences(viewOf("f(a + b); g(c);", "a + b"), [one, all], "extractVariable")).toBe(true);
    expect(openPopup).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(applyCodeAction).toHaveBeenCalledWith(expect.anything(), one));
  });
});
