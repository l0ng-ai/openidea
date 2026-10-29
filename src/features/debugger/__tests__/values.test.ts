import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { selectionExpression } from "../editor/valueTooltip";
import { classifyValue, identifiersIn, inlineValue, sortVariables } from "../values";
import { inlineValuesFor } from "../editor/execution";
import { frameLabel, groupFrames, isLibraryFrame } from "../frames";
import type { StackFrame } from "@/platform/ipc";

describe("value classification", () => {
  it.each([
    ["42", "number"],
    ["-3.5e10", "number"],
    ["0x1F", "number"],
    ["297.00", "number"],
    ["10u32", "number"],
    ['"hello"', "string"],
    ["'x'", "string"],
    ["b'bytes'", "string"],
    ["null", "keyword"],
    ["None", "keyword"],
    ["true", "keyword"],
    ["undefined", "keyword"],
    ["{CreateOrderRequest@4127}", "object"],
    ["CreateOrderRequest@4127", "object"],
    ["[1, 2, 3]", "object"],
    ["Vec(3)", "object"],
    ["<function main at 0x10>", "object"],
    ["some text", "plain"],
    ["", "plain"],
  ])("%s → %s", (value, kind) => {
    expect(classifyValue(value)).toBe(kind);
  });

  it("uses the type name as a fallback for strings", () => {
    expect(classifyValue("hello", "str")).toBe("string");
    expect(classifyValue("hello", "Order")).toBe("plain");
  });

  it("flattens and truncates inline values", () => {
    expect(inlineValue("a\n  b")).toBe("a b");
    expect(inlineValue("x".repeat(80), 10)).toBe("xxxxxxxxx…");
  });

  it("finds identifiers outside string literals", () => {
    expect(identifiersIn('log.info("total " + total)')).toEqual(["log", "info", "total"]);
  });

  it("formats inline values for known locals on a line", () => {
    const values = { req: "CreateOrderRequest@4127", total: "3", unused: "1" };
    expect(inlineValuesFor("fun create(req: CreateOrderRequest): OrderDto {", values)).toBe(
      "req: CreateOrderRequest@4127",
    );
    expect(inlineValuesFor("return 1", values)).toBeNull();
  });
});

const frame = (id: number, path: string | null, hint: string | null = null, line = 9): StackFrame => ({
  id,
  name: `f${id}`,
  path,
  line,
  column: 0,
  presentationHint: hint,
});

describe("frames", () => {
  const root = "/proj";
  it("detects library frames", () => {
    expect(isLibraryFrame(frame(1, "/proj/src/a.py"), root)).toBe(false);
    expect(isLibraryFrame(frame(1, "/proj/node_modules/x/i.js"), root)).toBe(true);
    expect(isLibraryFrame(frame(1, "/usr/lib/python3/x.py"), root)).toBe(true);
    expect(isLibraryFrame(frame(1, null), root)).toBe(true);
    expect(isLibraryFrame(frame(1, "/proj/a.py", "subtle"), root)).toBe(true);
    expect(isLibraryFrame(frame(1, "/elsewhere/a.py"), root)).toBe(true);
  });

  it("collapses runs of library frames but keeps the top and selected frames", () => {
    const frames = [
      frame(1, "/proj/a.py"),
      frame(2, null),
      frame(3, null),
      frame(4, null),
      frame(5, "/proj/b.py"),
      frame(6, null),
    ];
    const items = groupFrames(frames, root, 1, false);
    expect(items.map((i) => (i.kind === "hidden" ? `hidden${i.count}` : i.frame.id))).toEqual([1, "hidden3", 5, 6]);
    const selected = groupFrames(frames, root, 3, false);
    expect(selected.map((i) => (i.kind === "hidden" ? `hidden${i.count}` : i.frame.id))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(groupFrames(frames, root, 1, true)).toHaveLength(6);
  });

  it("labels frames with 1-based lines", () => {
    expect(frameLabel(frame(1, "/proj/a.py", null, 21))).toBe("f1:22");
    expect(frameLabel(frame(1, null))).toBe("f1");
  });
});

describe("sortVariables", () => {
  const names = (vs: { name: string }[]) => vs.map((v) => v.name);
  it("sorts by name, case-insensitively and with numbers compared numerically", () => {
    expect(names(sortVariables([{ name: "b" }, { name: "item10" }, { name: "A" }, { name: "item2" }]))).toEqual([
      "A",
      "b",
      "item2",
      "item10",
    ]);
  });
  it("keeps array elements in index order", () => {
    const items = [{ name: "[0]" }, { name: "[1]" }, { name: "[10]" }, { name: "[2]" }];
    expect(names(sortVariables(items))).toEqual(["[0]", "[1]", "[10]", "[2]"]);
  });
});

describe("selectionExpression", () => {
  const at = (doc: string, from: number, to: number) =>
    selectionExpression(EditorState.create({ doc, selection: EditorSelection.single(from, to) }));
  it("takes a one-line selection", () => {
    expect(at("total += item.price", 9, 19)).toEqual({ from: 9, text: "item.price" });
  });
  it("ignores empty, blank, multi-line and multiple selections", () => {
    expect(at("a + b", 2, 2)).toBeNull();
    expect(at("a   b", 1, 4)).toBeNull();
    expect(at("a\nb", 0, 3)).toBeNull();
    const multi = EditorState.create({
      doc: "a + b",
      selection: EditorSelection.create([EditorSelection.range(0, 1), EditorSelection.range(4, 5)]),
      extensions: EditorState.allowMultipleSelections.of(true),
    });
    expect(selectionExpression(multi)).toBeNull();
  });
});
