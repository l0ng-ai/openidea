import { describe, expect, it } from "vitest";
import { Chunk, MergeView } from "@codemirror/merge";
import { ChangeSet, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { applyChunk, arrowControls } from "../diffControls";
import {
  DEFAULT_DIFF_OPTIONS,
  parseDiffOptions,
  ideaChunks,
  ideaDiffConfig,
  transferChunk,
  type IgnorePolicy,
} from "../diffOptions";
import { clipboardDiffData, compareFilesData, parseTextsArg } from "../compare";
import { diffInput, diffTitle, sideFile, sideKey } from "../diffInput";
import { changedLineGutters, chunkKind, diffWords, viewerBase } from "../cm";

const doc = (s: string) => Text.of(s.split("\n"));

function chunks(a: string, b: string, ignore: IgnorePolicy) {
  return ideaChunks(doc(a), doc(b), ignore, "words");
}

describe("diff options", () => {
  it("parses stored options with per-field defaults", () => {
    expect(parseDiffOptions(null)).toEqual(DEFAULT_DIFF_OPTIONS);
    expect(
      parseDiffOptions({
        mode: "split",
        ignore: "trim",
        highlight: "lines",
        collapse: false,
        syncScroll: false,
        alignChanges: false,
      }),
    ).toEqual({
      mode: "split",
      ignore: "trim",
      highlight: "lines",
      collapse: false,
      syncScroll: false,
      alignChanges: false,
    });
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

  it("colours lines by their chunk's type, as IDEA does", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const extensions = [viewerBase({ readOnly: true }), diffWords];
    const mv = new MergeView({
      a: { doc: "keep\nremoved one\nremoved two\nmid\nvalue = old\nend\n", extensions },
      b: { doc: "keep\nmid\nvalue = new\nadded\nend\n", extensions },
      parent,
      highlightChanges: false,
      diffConfig: ideaDiffConfig("none", "words"),
    });
    const lines = (v: EditorView, kind: string) =>
      [...v.dom.querySelectorAll(`.cm-diffLine-${kind}`)].map((e) => e.textContent);
    expect(lines(mv.a, "deleted")).toEqual(["removed one", "removed two"]);
    // A block with lines on both sides is modified as a whole, on both sides.
    expect(lines(mv.a, "modified")).toEqual(["value = old"]);
    expect(lines(mv.b, "modified")).toEqual(["value = new", "added"]);
    expect(lines(mv.b, "inserted")).toEqual([]);
    expect(chunkKind(mv.chunks[1]!)).toBe("modified");
    mv.destroy();
    parent.remove();
  });

  it("highlights the words of a modified block by their own type", async () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const extensions = [viewerBase({ readOnly: true }), diffWords];
    const mv = new MergeView({
      a: { doc: "x\n  syncScroll: boolean;\ny\n", extensions },
      b: { doc: "x\n  /** Docs. */\n  syncScrolling: boolean;\ny\n", extensions },
      parent,
      highlightChanges: false,
      diffConfig: ideaDiffConfig("none", "words"),
    });
    // The left pane highlights its words once the right one exists.
    await Promise.resolve();
    const words = (v: EditorView, kind: string) =>
      [...v.dom.querySelectorAll(`.cm-diffWord.cm-diffWord-${kind}`)].map((e) => e.textContent);
    // The edited identifier is highlighted whole, joined by the comment added before it.
    expect(words(mv.a, "modified")).toEqual(["syncScroll"]);
    expect(words(mv.b, "modified").join("")).toBe("/** Docs. */  syncScrolling");
    expect(mv.a.dom.classList.contains("cm-diffWords")).toBe(true);
    mv.destroy();
    parent.remove();
  });

  it("marks inserted and deleted words inside a modified line", async () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const extensions = [viewerBase({ readOnly: true }), diffWords];
    const mv = new MergeView({
      a: { doc: "call(first, extra, last)\n", extensions },
      b: { doc: "call(first, last, more)\n", extensions },
      parent,
      highlightChanges: false,
      diffConfig: ideaDiffConfig("none", "words"),
    });
    // The left pane highlights its words once the right one exists.
    await Promise.resolve();
    const words = (v: EditorView, kind: string) =>
      [...v.dom.querySelectorAll(`.cm-diffWord.cm-diffWord-${kind}`)].map((e) => e.textContent);
    expect(words(mv.a, "deleted").join("")).toContain("extra");
    expect(words(mv.b, "inserted").join("")).toContain("more");
    expect(words(mv.a, "inserted")).toEqual([]);
    expect(words(mv.b, "deleted")).toEqual([]);
    mv.destroy();
    parent.remove();
  });

  it("diffs changed blocks by words (ByWord)", () => {
    const pairs = (a: string, b: string) =>
      chunks(a, b, "none").flatMap((ch) =>
        ch.changes.map((c) => [
          a.slice(ch.fromA + c.fromA, ch.fromA + c.toA),
          b.slice(ch.fromB + c.fromB, ch.fromB + c.toB),
        ]),
      );
    // An edited identifier is changed whole.
    expect(pairs("  syncScroll: boolean;", "  syncScrolling: boolean;")).toEqual([["syncScroll", "syncScrolling"]]);
    // Punctuation is matched between matched words only: two changed words around ":" are one fragment.
    expect(pairs("  syncScroll: true,", "  syncScrolling: false,")).toEqual([
      ["syncScroll: true", "syncScrolling: false"],
    ]);
    expect(pairs("f(a, b)", "f(a, x, b)")).toEqual([["", " x,"]]);
    // Each character of a script written without spaces is a word.
    expect(pairs("你好世界", "你们世界")).toEqual([["好", "们"]]);
    expect(pairs("a  b", "a b")).toEqual([[" ", ""]]);
    // A 10,000-line block edited on every line still pairs up its words.
    const big = (kw: string) =>
      Array.from({ length: 10_000 }, (_, i) => `export ${kw} value${i} = compute(${i});\n`).join("");
    const changes = pairs(big("const"), big("let"));
    expect(changes).toHaveLength(10_000);
    expect(changes.every(([a, b]) => a === "const" && b === "let")).toBe(true);
  });

  it("keeps a line with only words added modified on both sides", async () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const extensions = [viewerBase({ readOnly: true }), diffWords];
    const mv = new MergeView({
      a: { doc: "f() {\n  return a;\n}\n", extensions },
      b: { doc: "f() {\n  return a + b;\n}\n", extensions },
      parent,
      highlightChanges: false,
      diffConfig: ideaDiffConfig("none", "words"),
    });
    await Promise.resolve();
    expect([...mv.a.dom.querySelectorAll(".cm-diffLine-modified")].map((e) => e.textContent)).toEqual(["  return a;"]);
    expect([...mv.b.dom.querySelectorAll(".cm-diffLine-modified")].map((e) => e.textContent)).toEqual([
      "  return a + b;",
    ]);
    // IDEA keeps the space before an inserted word in the fragment.
    expect([...mv.b.dom.querySelectorAll(".cm-diffWord-inserted")].map((e) => e.textContent).join("")).toBe(" + b");
    // and marks where it would be on the other side
    expect(mv.a.dom.querySelectorAll(".cm-diffWordEmpty.cm-diffWord-inserted")).toHaveLength(1);
    mv.destroy();
    parent.remove();
  });

  it("carries the change background into the line number gutter", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const extensions = [viewerBase({ readOnly: true }), changedLineGutters];
    const mv = new MergeView({
      a: { doc: "keep\nlet x = 1;\nend\n", extensions },
      b: { doc: "keep\nlet x = 2;\nadded\nend\nnew\n", extensions },
      parent,
      gutter: false,
      diffConfig: ideaDiffConfig("none", "words"),
    });
    const numbers = (v: typeof mv.a, cls: string) =>
      [...v.dom.querySelectorAll(`.cm-lineNumbers .${cls}`)].map((e) => e.textContent);
    expect(numbers(mv.a, "cm-diffGutter-modified")).toEqual(["2"]);
    expect(numbers(mv.b, "cm-diffGutter-modified")).toEqual(["2", "3"]);
    expect(numbers(mv.b, "cm-diffGutter-inserted")).toEqual(["5"]);
    mv.destroy();
    parent.remove();
  });

  it("shows a final line break added as an inserted empty line, gutter included", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const extensions = [viewerBase({ readOnly: true }), changedLineGutters];
    const mv = new MergeView({
      a: { doc: "alpha\nbeta", extensions },
      b: { doc: "alpha\nbeta\n", extensions },
      parent,
      gutter: false,
      diffConfig: ideaDiffConfig("none", "words"),
    });
    const lines = [...mv.b.contentDOM.querySelectorAll(".cm-line")].map((l) => l.classList.contains("cm-diffLine"));
    const gutters = [...mv.b.dom.querySelectorAll(".cm-lineNumbers .cm-gutterElement:not([style*='hidden'])")]
      .filter((e) => e.textContent)
      .map((e) => e.classList.contains("cm-diffChangedGutter"));
    // IDEA compares lines without their breaks: "beta" is unchanged, the empty last line inserted.
    expect(lines).toEqual([false, false, true]);
    expect(gutters).toEqual(lines);
    expect(mv.b.contentDOM.querySelectorAll(".cm-diffLine-inserted")).toHaveLength(1);
    mv.destroy();
    parent.remove();
  });

  it("shows a last line removed as a deleted line only", async () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const extensions = [viewerBase({ readOnly: true }), diffWords];
    const mv = new MergeView({
      a: { doc: "keep\ngone", extensions },
      b: { doc: "keep", extensions },
      parent,
      highlightChanges: false,
      diffConfig: ideaDiffConfig("none", "words"),
    });
    await Promise.resolve();
    // "keep" loses its line break, which IDEA does not count as a change.
    expect([...mv.a.dom.querySelectorAll(".cm-diffLine")].map((e) => e.textContent)).toEqual(["gone"]);
    expect(mv.a.dom.querySelectorAll(".cm-diffLine-deleted")).toHaveLength(1);
    mv.destroy();
    parent.remove();
  });

  it("keeps word highlighting for a single-line replacement", async () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const mv = new MergeView({
      a: { doc: "before\nvalue = old\nafter\n", extensions: [viewerBase({ readOnly: true }), diffWords] },
      b: { doc: "before\nvalue = new\nafter\n", extensions: [viewerBase({ readOnly: true }), diffWords] },
      parent,
      highlightChanges: false,
      diffConfig: ideaDiffConfig("none", "words"),
    });
    // The left pane highlights its words once the right one exists.
    await Promise.resolve();
    expect([...mv.a.dom.querySelectorAll(".cm-diffWord-modified")].map((e) => e.textContent)).toEqual(["old"]);
    expect([...mv.b.dom.querySelectorAll(".cm-diffWord-modified")].map((e) => e.textContent)).toEqual(["new"]);
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

describe("oversized line comparison", () => {
  it("falls back to transferable chunks on initial comparison and either-side edits", () => {
    const a = doc("alpha\n".repeat(12000) + "beta\n".repeat(12000));
    const b = doc("beta\n".repeat(12000) + "alpha\n".repeat(12000));
    const config = ideaDiffConfig("none", "words");
    const built = Chunk.build(a, b, config);
    const editB = ChangeSet.of({ from: 0, insert: "header\n" }, b.length);
    const nextB = editB.apply(b);
    const updatedB = Chunk.updateB(built, a, nextB, editB, config);
    const editA = ChangeSet.of({ from: 0, insert: "other\n" }, a.length);
    const nextA = editA.apply(a);
    const updatedA = Chunk.updateA(built, nextA, b, editA, config);
    for (const [chunks, source, target] of [
      [built, a, b],
      [updatedB, a, nextB],
      [updatedA, nextA, b],
    ] as const) {
      expect(chunks.length).toBeGreaterThan(0);
      let restored = target;
      for (const chunk of [...chunks].reverse()) {
        const edit = transferChunk(chunk, "a", source, restored);
        restored = restored.replace(edit.from, edit.to, doc(edit.insert));
      }
      expect(restored.toString()).toBe(source.toString());
    }
  }, 20000);
});
