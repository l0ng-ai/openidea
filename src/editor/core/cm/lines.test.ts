import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { reverseLinesSpec, sortLinesSpec, type SortLinesOrder } from "./lines";

const TOML = ['"github:PowerShell/PowerShellEditorServices" = "4.7"', '"github:opentofu/tofu-ls" = "0.5"'].join("\n");

const LOCALE_SORTED_TOML = [...TOML.split("\n")].reverse().join("\n");

function apply(doc: string, sel: EditorSelection | undefined, fn: typeof sortLinesSpec, order?: SortLinesOrder) {
  const state = EditorState.create({ doc, selection: sel, extensions: EditorState.allowMultipleSelections.of(true) });
  const spec = fn(state, order);
  return spec ? state.update(spec).state.doc.toString() : null;
}

describe("Sort Lines / Reverse Lines", () => {
  it("sorts the whole file without a selection", () => {
    expect(apply("c\na\nb", undefined, sortLinesSpec)).toBe("a\nb\nc");
    expect(apply("c\na\nb", undefined, reverseLinesSpec)).toBe("b\na\nc");
    expect(apply("c\nb\na\n", undefined, sortLinesSpec)).toBe("a\nb\nc\n");
    expect(apply("c\nb\na\n", undefined, reverseLinesSpec)).toBe("a\nb\nc\n");
  });

  it("sorts only the selected lines (a selection ending at a line start excludes that line)", () => {
    const doc = "z\nc\nb\na\ny";
    const sel = EditorSelection.single(2, 8); // "c\nb\na\n"
    expect(apply(doc, sel, sortLinesSpec)).toBe("z\na\nb\nc\ny");
  });

  it("handles several selections independently", () => {
    const doc = "b\na\n--\nd\nc";
    const sel = EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(7, 10)]);
    expect(apply(doc, sel, sortLinesSpec)).toBe("a\nb\n--\nc\nd");
  });

  it("does nothing for a single line or an already sorted block", () => {
    expect(apply("only", undefined, sortLinesSpec)).toBeNull();
    expect(apply("a\nb", undefined, sortLinesSpec)).toBeNull();
  });

  it("interleaves letter cases with the default locale collator (the issue's TOML sample)", () => {
    expect(apply(TOML, undefined, sortLinesSpec)).toBe(
      ['"github:opentofu/tofu-ls" = "0.5"', '"github:PowerShell/PowerShellEditorServices" = "4.7"'].join("\n"),
    );
  });

  it("puts every uppercase letter before every lowercase one with code-point order", () => {
    expect(apply("b\nA\na\nB", undefined, sortLinesSpec, "codePoint")).toBe("A\nB\na\nb");
    // The issue's TOML sample after today's locale sort: code-point order restores `LC_ALL=C sort`.
    expect(apply(LOCALE_SORTED_TOML, undefined, sortLinesSpec, "codePoint")).toBe(TOML);
    // The order applies to the selected lines as well.
    const doc = "1\nopentofu\nPowerShell\n2";
    const sel = EditorSelection.single(2, 22); // "opentofu\nPowerShell\n"
    expect(apply(doc, sel, sortLinesSpec, "codePoint")).toBe("1\nPowerShell\nopentofu\n2");
  });
});
