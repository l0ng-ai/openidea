import { describe, expect, it } from "vitest";
import { Chunk, MergeView } from "@codemirror/merge";
import { Text } from "@codemirror/state";
import { applyChunk, arrowControls } from "../diffControls";
import {
  DEFAULT_DIFF_OPTIONS,
  parseDiffOptions,
  transferChunk,
  whitespaceDiff,
  type IgnorePolicy,
} from "../diffOptions";
import { clipboardDiffData, compareFilesData, parseTextsArg } from "../compare";
import { diffInput, diffTitle, sideFile, sideKey } from "../diffInput";
import { viewerBase } from "../cm";

const doc = (s: string) => Text.of(s.split("\n"));

function chunks(a: string, b: string, ignore: IgnorePolicy) {
  const override = whitespaceDiff(ignore);
  return Chunk.build(doc(a), doc(b), { override });
}

describe("diff options", () => {
  it("parses stored options with per-field defaults", () => {
    expect(parseDiffOptions(null)).toEqual(DEFAULT_DIFF_OPTIONS);
    expect(
      parseDiffOptions({ mode: "split", ignore: "trim", highlight: "lines", collapse: false, syncScroll: false }),
    ).toEqual({ mode: "split", ignore: "trim", highlight: "lines", collapse: false, syncScroll: false });
    expect(parseDiffOptions({ ignore: "bogus", highlight: 3, collapse: "x" })).toEqual(DEFAULT_DIFF_OPTIONS);
  });

  it("ignore whitespace policies", () => {
    const a = "fn main() {\n  let x = 1;\n}\n";
    const indented = "fn main() {\n    let x = 1;   \n}\n";
    const inner = "fn main() {\n  let x=1;\n}\n";
    const blank = "fn main() {\n\n  let x = 1;\n}\n";
    expect(chunks(a, indented, "none")).toHaveLength(1);
    expect(chunks(a, indented, "trim")).toHaveLength(0);
    expect(chunks(a, inner, "trim")).toHaveLength(1);
    expect(chunks(a, inner, "whitespace")).toHaveLength(0);
    expect(chunks(a, blank, "whitespace")).toHaveLength(1);
    expect(chunks(a, blank, "whitespaceAndLines")).toHaveLength(0);
  });

  it("keeps real changes (with word-level ranges) when ignoring whitespace", () => {
    const a = "x\nlet total = compute(first);\ny\n";
    const b = "x\n   let total = compute(second);\ny\n";
    const [c, ...rest] = chunks(a, b, "whitespace");
    expect(rest).toHaveLength(0);
    expect(c).toMatchObject({ fromA: 2, fromB: 2 });
    // Inner changes are character-precise, not whole lines.
    expect(c!.changes.every((ch) => ch.toB - ch.fromB < 20)).toBe(true);
  });

  it("keeps distant insertions separate in a long file", () => {
    const lines = Array.from({ length: 1200 }, (_, i) => `line_${i}: ${"content ".repeat(8)}${i}`);
    const changed = [...lines];
    for (let i = 1000; i >= 100; i -= 100) changed.splice(i, 0, `insert_${i} ${"x".repeat(90)}`);
    const a = lines.join("\n");
    const b = changed.join("\n");
    const result = chunks(a, b, "none");
    expect(result).toHaveLength(10);
    expect(result.every((c) => c.fromA === c.toA && c.toB - c.fromB < 120)).toBe(true);
    let restored = doc(b);
    for (const c of [...result].reverse()) {
      const edit = transferChunk(c, "a", doc(a), restored);
      restored = restored.replace(edit.from, edit.to, Text.of(edit.insert.split("\n")));
    }
    expect(restored.toString()).toBe(a);
  });

  it("keeps distant edits separate in a very long file", () => {
    const lines = Array.from({ length: 50000 }, (_, i) => `const v${i} = ${i * 7};`);
    const changed = [...lines];
    for (let i = 49000; i > 0; i -= 2500) changed.splice(i, 1, `inserted ${i}`, `${changed[i]} // edited`);
    const result = chunks(lines.join("\n"), changed.join("\n"), "none");
    expect(result).toHaveLength(20);
    expect(result.every((c) => c.toB - c.fromB < 60)).toBe(true);
  });

  it("matches unchanged lines between many small edits", () => {
    const lines = Array.from({ length: 4000 }, (_, i) => `line ${i}`);
    const a = lines.join("\n");
    const b = lines.map((l, i) => (i % 2 ? `${l} changed` : l)).join("\n");
    expect(chunks(a, b, "none")).toHaveLength(2000);
    expect(chunks(a, b, "whitespace")).toHaveLength(2000);
  });

  it("handles empty documents", () => {
    expect(chunks("", "", "none")).toHaveLength(0);
    const [ins] = chunks("", "one\ntwo\n", "none");
    expect(ins).toMatchObject({ fromA: 0, toA: 0, fromB: 0 });
    const [del] = chunks("one\ntwo\n", "", "whitespace");
    expect(del).toMatchObject({ fromA: 0, fromB: 0, toB: 0 });
  });

  it("detects a missing final newline", () => {
    for (const [a, b] of [
      ["same\n", "same"],
      ["same", "same\n"],
    ]) {
      const [chunk] = chunks(a!, b!, "none");
      expect(chunk).toBeDefined();
      const edit = transferChunk(chunk!, "a", doc(a!), doc(b!));
      expect(
        doc(b!)
          .replace(edit.from, edit.to, Text.of(edit.insert.split("\n")))
          .toString(),
      ).toBe(a);
    }
  });

  it("decorates consecutive inserted and deleted lines as whole lines", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const mv = new MergeView({
      a: { doc: "before\nremoved one\nremoved two\nafter\n", extensions: viewerBase({ readOnly: true }) },
      b: { doc: "before\nafter\n", extensions: viewerBase({ readOnly: true }) },
      parent,
      diffConfig: { override: whitespaceDiff("none") },
    });
    expect(mv.a.dom.querySelectorAll(".cm-diffWholeLine")).toHaveLength(2);
    expect(mv.b.dom.querySelectorAll(".cm-diffWholeLine")).toHaveLength(0);
    mv.destroy();
    parent.remove();
  });

  it("keeps word highlighting on paired lines of a multi-line replacement", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const mv = new MergeView({
      a: {
        doc: "before\nfrom old.first import X\nfrom old.second import Y\nafter\n",
        extensions: viewerBase({ readOnly: true }),
      },
      b: {
        doc: "before\nfrom new.first import A\nfrom new.second import B\nadded line\nafter\n",
        extensions: viewerBase({ readOnly: true }),
      },
      parent,
      diffConfig: { override: whitespaceDiff("none") },
    });
    expect(mv.a.dom.querySelectorAll(".cm-changedLine")).toHaveLength(2);
    expect(mv.a.dom.querySelector(".cm-diffWholeLine")).toBeNull();
    expect([...mv.a.dom.querySelectorAll(".cm-changedText")].map((e) => e.textContent)).toEqual([
      "old",
      "X",
      "old",
      "Y",
    ]);
    expect(mv.b.dom.querySelectorAll(".cm-changedLine")).toHaveLength(3);
    expect([...mv.b.dom.querySelectorAll(".cm-diffWholeLine")].map((e) => e.textContent)).toEqual(["added line"]);
    expect(mv.b.dom.querySelectorAll(".cm-changedLine:not(.cm-diffWholeLine) .cm-changedText")).toHaveLength(4);
    mv.destroy();
    parent.remove();
  });

  it("marks a deleted last line as a whole line", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const mv = new MergeView({
      a: { doc: "keep\ngone", extensions: viewerBase({ readOnly: true }) },
      b: { doc: "keep", extensions: viewerBase({ readOnly: true }) },
      parent,
      diffConfig: { override: whitespaceDiff("none") },
    });
    expect([...mv.a.dom.querySelectorAll(".cm-diffWholeLine")].map((e) => e.textContent)).toEqual(["gone"]);
    mv.destroy();
    parent.remove();
  });

  it("keeps word highlighting for a single-line replacement", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const mv = new MergeView({
      a: { doc: "before\nvalue = old\nafter\n", extensions: viewerBase({ readOnly: true }) },
      b: { doc: "before\nvalue = new\nafter\n", extensions: viewerBase({ readOnly: true }) },
      parent,
      diffConfig: { override: whitespaceDiff("none") },
    });
    expect(mv.a.dom.querySelector(".cm-diffWholeLine")).toBeNull();
    expect(mv.b.dom.querySelector(".cm-diffWholeLine")).toBeNull();
    expect(mv.a.dom.querySelector(".cm-changedText")).not.toBeNull();
    expect(mv.b.dom.querySelector(".cm-changedText")).not.toBeNull();
    mv.destroy();
    parent.remove();
  });

  it("gives a read-only side a tab stop and leaves an editable side alone", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const mv = new MergeView({
      a: { doc: "old\n", extensions: viewerBase({ readOnly: true }) },
      b: { doc: "new\n", extensions: viewerBase({ readOnly: false }) },
      parent,
    });
    expect(mv.a.contentDOM.getAttribute("contenteditable")).toBe("false");
    expect(mv.a.contentDOM.getAttribute("tabindex")).toBe("0");
    expect(mv.b.contentDOM.getAttribute("contenteditable")).toBe("true");
    expect(mv.b.contentDOM.hasAttribute("tabindex")).toBe(false);
    mv.destroy();
    parent.remove();
  });

  it("transfers a chunk between sides (>> / << / Revert)", () => {
    const a = doc("x\nold\ny\n");
    const b = doc("x\nnew\nnewer\ny\n");
    const [c] = Chunk.build(a, b);
    const toB = transferChunk(c!, "a", a, b);
    expect(b.replace(toB.from, toB.to, Text.of(toB.insert.split("\n"))).toString()).toBe("x\nold\ny\n");
    const toA = transferChunk(c!, "b", b, a);
    expect(a.replace(toA.from, toA.to, Text.of(toA.insert.split("\n"))).toString()).toBe("x\nnew\nnewer\ny\n");
  });

  it("applies chunks in a merge view through the arrow controls", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    let mv: MergeView | null = null;
    mv = new MergeView({
      a: { doc: "1\nleft\n3\n" },
      b: { doc: "1\nright\n3\n" },
      parent,
      revertControls: "a-to-b",
      renderRevertControl: arrowControls(() => mv, { toA: true, toB: true }),
    });
    const holder = arrowControls(() => mv, { toA: true, toB: true })();
    expect([...holder.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual([
      expect.stringContaining("right"),
      expect.stringContaining("left"),
    ]);
    // "<<": the right side's text replaces the left chunk.
    holder.dataset.chunk = "0";
    holder.querySelectorAll("button")[1]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(mv.a.state.doc.toString()).toBe("1\nright\n3\n");
    expect(mv.chunks).toHaveLength(0);
    mv.a.dispatch({ changes: { from: 2, to: 7, insert: "LEFT" } });
    applyChunk(mv, 0, "a");
    expect(mv.b.state.doc.toString()).toBe("1\nLEFT\n3\n");
    mv.destroy();
    parent.remove();
  });
});

describe("compare entry points", () => {
  it("Compare Files makes both sides live files", () => {
    const data = compareFilesData("/p/a.ts", "/p/b.ts");
    expect(sideFile(data.left, data.path)).toBe("/p/a.ts");
    expect(sideFile(data.right, data.path)).toBe("/p/b.ts");
    expect(diffTitle(data)).toBe("a.ts ↔ b.ts");
  });

  it("Compare with Clipboard: the file, or the selection", () => {
    const whole = clipboardDiffData("/p/a.ts", "clip", null);
    expect(whole.left).toEqual({ type: "text", text: "clip", label: "Clipboard" });
    expect(sideFile(whole.right, whole.path)).toBe("/p/a.ts");
    const sel = clipboardDiffData("/p/a.ts", "clip", "sel");
    expect(sideFile(sel.right, sel.path)).toBeNull();
    expect(diffTitle(sel)).toBe("Clipboard ↔ a.ts (selection)");
  });

  it("text sides get distinct tabs per content; compareTexts arguments are validated", () => {
    const k1 = sideKey({ type: "text", text: "a", label: "Original" });
    const k2 = sideKey({ type: "text", text: "b", label: "Original" });
    expect(k1).not.toBe(k2);
    expect(
      parseTextsArg({ path: "/p/a", left: { text: "1", label: "L" }, right: { text: "2", label: "R" } }),
    ).toMatchObject({
      path: "/p/a",
    });
    expect(parseTextsArg({ path: "/p/a", left: { text: 1 } })).toBeNull();
    expect(diffInput(compareFilesData("/p/a", "/p/b")).key).toContain("file:/p/a");
  });
});
