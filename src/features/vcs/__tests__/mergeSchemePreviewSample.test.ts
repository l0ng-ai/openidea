import { expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { Chunk } from "@codemirror/merge";

// The Color Scheme › Diff & Merge sample (ColorSchemeBody.tsx) must keep showing all three
// change kinds without scrolling: the heads carry the modification and the deletion, the
// result gains `return value` right after the fold. Guards against edits that let
// `Chunk.build` collapse two of the kinds into a single modified chunk.
const UNCHANGED = Array.from({ length: 16 }, (_, i) => `        # unchanged context ${i + 1}`);
const HEAD_A = ["bar(123)", "def foo(self):", "    # Left changes", "    pass"];
const HEAD_R = ["class MyClass", "value = 123", "def foo(self):", "    pass"];
const MID = ["    print('mid')"];
const END = ["    print('end')", "def bar(self, a, b):", "    print a", "    print b"];

const classify = (x: string, y: string) =>
  Chunk.build(Text.of(x.split("\n")), Text.of(y.split("\n"))).map((c) =>
    c.fromA === c.toA ? "inserted" : c.fromB === c.toB ? "deleted" : "modified",
  );

it("classifies the Diff & Merge sample into modified, inserted and deleted", () => {
  const a = [...HEAD_A, ...UNCHANGED, ...MID, ...END].join("\n");
  const r = [...HEAD_R, ...UNCHANGED, ...MID, "    return value", ...END].join("\n");
  const b = [...HEAD_R, ...UNCHANGED, ...MID, ...END].join("\n");
  const vsLeft = classify(a, r);
  const vsRight = classify(b, r);
  expect(vsLeft).toContain("modified");
  expect(vsLeft).toContain("deleted");
  expect(vsLeft).toContain("inserted");
  expect(vsRight).toContain("inserted");
});
