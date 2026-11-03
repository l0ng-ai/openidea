import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { EditorInput } from "@/workbench/contributions";

const texts = vi.hoisted(() => ({ before: "", after: "" }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      fsProbe: () => Promise.resolve({ status: "error", error: "missing" }),
      vcsFileAt: (_path: string, rev: string) =>
        Promise.resolve({ status: "ok", data: rev === "A" ? texts.before : texts.after }),
    },
  };
});

import { DiffEditor } from "../DiffEditor";
import { getDiffInsights, ideaChunks, transferChunk, type IgnorePolicy } from "../diffOptions";

const first = "function first() {\n  return 'first';\n}\n";
const second = "function second() {\n  return 'second';\n}\n";
const third = "function third() {\n  return 'third';\n}\n";
const doc = (text: string) => Text.of(text.split("\n"));
const compare = (a: string, b: string, ignore: IgnorePolicy = "none") => {
  const chunks = ideaChunks(doc(a), doc(b), ignore, "words");
  return { chunks, ...getDiffInsights(chunks) };
};
const input = {
  kind: "diff",
  key: "diff:moved",
  data: {
    path: "/p/example.ts",
    left: { type: "rev", rev: "A" },
    right: { type: "rev", rev: "B" },
  },
} as unknown as EditorInput;

beforeEach(() => {
  localStorage.clear();
  texts.before = first + second + third;
  texts.after = second + third + first;
});

describe("built-in moved block detection", () => {
  it("pairs a moved function while preserving all transferable line hunks", () => {
    const { chunks, moves } = compare(texts.before, texts.after);
    expect(moves).toHaveLength(1);
    const move = moves[0]!;
    expect(texts.before.slice(move.fromA, move.toA)).toBe(first.trimEnd());
    expect(texts.after.slice(move.fromB, move.toB)).toBe(first.trimEnd());
    let restored = doc(texts.after);
    for (const chunk of [...chunks].reverse()) {
      const edit = transferChunk(chunk, "a", doc(texts.before), restored);
      restored = restored.replace(edit.from, edit.to, doc(edit.insert));
    }
    expect(restored.toString()).toBe(texts.before);
  });

  it("recognizes reindented moved code and records token changes separately", () => {
    const reindented = first
      .split("\n")
      .map((l) => (l ? `    ${l}` : l))
      .join("\n");
    expect(compare(texts.before, second + third + reindented).moves).toHaveLength(1);
    expect(compare(texts.before, second + third + reindented).moves[0]!.changes).toEqual([]);
    const changed = first.replace("'first'", "'changed'");
    const { moves } = compare(texts.before, second + third + changed);
    expect(moves).toHaveLength(1);
    const move = moves[0]!;
    expect(move.changes.map((c) => [first.slice(c.start1, c.end1), changed.slice(c.start2, c.end2)])).toEqual([
      ["first", "changed"],
    ]);
  });

  it("does not label copied code, repeated blocks, braces or indentation-only edits as moves", () => {
    expect(compare(texts.before, texts.before + first).moves).toHaveLength(0);
    expect(compare(first + first + second + third, second + third + first + first).moves).toHaveLength(0);
    expect(compare("{\n}\nkeep\n", "keep\n{\n}\n").moves).toHaveLength(0);
    expect(compare(first, first.replace("  return", "    return")).moves).toHaveLength(0);
  });

  it("handles Unicode, no final newline and multiple independently moved blocks", () => {
    const unicode = "function привет() {\n  return '你好 😀';\n}\n";
    const a = unicode + second + third;
    const b = (second + third + unicode).trimEnd();
    const { moves } = compare(a, b);
    expect(moves).toHaveLength(1);
    expect(a.slice(moves[0]!.fromA, moves[0]!.toA)).toBe(unicode.trimEnd());
    expect(b.slice(moves[0]!.fromB, moves[0]!.toB)).toBe(unicode.trimEnd());
    const fourth = "function fourth() {\n  return 'fourth';\n}\n";
    const fifth = "function fifth() {\n  return 'fifth';\n}\n";
    expect(
      compare(first + second + third + fourth + fifth, second + third + first + fifth + fourth).moves,
    ).toHaveLength(2);
    expect(
      compare(first + second + third + fourth + fifth, second + third + first + fifth + fourth).moves.every(
        (m) => m.changes.length === 0,
      ),
    ).toBe(true);
  });

  it("classifies whitespace-only differences under every ignore policy", () => {
    for (const ignore of ["none", "trim", "whitespace", "whitespaceAndLines"] as const) {
      expect(compare("let a = 1;\n", "  let a = 1;\n\n", ignore).whitespaceOnly).toBe(true);
      expect(compare("let a = 1;\n", "let a = 2;\n", ignore).whitespaceOnly).toBe(false);
      expect(compare("same", "same", ignore).whitespaceOnly).toBe(false);
    }
  });
});

describe("edited moves", () => {
  const original =
    "function compute() {\n  const value = calculate(input);\n  record(value);\n  return value + 1;\n}\n";
  const inspect = (changed: string) => compare(original + second + third, second + third + changed);

  it.each([
    ["body edit", original.replace("+ 1", "+ 2")],
    ["added line", original.replace("  return", "  validate(value);\n  return")],
    ["deleted line", original.replace("  record(value);\n", "")],
    ["renamed function", original.replace("compute", "renamed")],
    [
      "reindent and edit",
      original
        .replace("+ 1", "+ 2")
        .split("\n")
        .map((l) => (l ? `  ${l}` : l))
        .join("\n"),
    ],
  ])("pairs a moved block with a %s and preserves revert", (_name, changed) => {
    const a = original + second + third;
    const b = second + third + changed;
    const { moves, chunks } = inspect(changed);
    expect(moves).toHaveLength(1);
    expect(a.slice(moves[0]!.fromA, moves[0]!.toA)).toBe(original.trimEnd());
    expect(b.slice(moves[0]!.fromB, moves[0]!.toB)).toBe(changed.trimEnd());
    expect(moves[0]!.changes.length).toBeGreaterThan(0);
    let restored = doc(b);
    for (const chunk of [...chunks].reverse()) {
      const edit = transferChunk(chunk, "a", doc(a), restored);
      restored = restored.replace(edit.from, edit.to, doc(edit.insert));
    }
    expect(restored.toString()).toBe(a);
  });

  it("does not classify an ordinary edit shifted by nearby insertions as a move", () => {
    const a = original + second + third;
    const b = "// new header\n" + original.replace("+ 1", "+ 2") + second + third;
    expect(compare(a, b).moves).toHaveLength(0);
  });

  it("rejects major rewrites, repeated alternatives and weak matches between unrelated functions", () => {
    expect(inspect("function compute() {\n  throw new Error('not implemented');\n}\n").moves).toHaveLength(0);
    const renamedTiny = first.replace("function first", "function unrelated");
    expect(compare(first + second + third, second + third + renamedTiny).moves).toHaveLength(0);
    const changed = original.replace("+ 1", "+ 2");
    expect(
      compare(original + original + second + third, second + third + changed + changed).moves.every(
        (m) => m.changes.length === 0,
      ),
    ).toBe(true);
  });

  it("keeps UTF-16 edit offsets correct for Unicode and a missing final newline", () => {
    const aBlock = original.replace("calculate(input)", "calculate('你好 😀')");
    const bBlock = aBlock.replace("+ 1", "+ 2").trimEnd();
    const { moves } = compare(aBlock + second + third, second + third + bBlock);
    expect(moves).toHaveLength(1);
    expect(moves[0]!.changes.map((c) => [aBlock.slice(c.start1, c.end1), bBlock.slice(c.start2, c.end2)])).toEqual([
      ["1", "2"],
    ]);
  });

  it("leaves large approximate comparisons usable as ordinary line hunks", () => {
    const large = "function large() {\n" + Array.from({ length: 300 }, (_, i) => `  call${i}();\n`).join("") + "}\n";
    const a = large + second + third;
    const b = second + third + large.replace("call150()", "changed150()");
    const result = compare(a, b);
    expect(result.moves.every((m) => m.changes.length === 0)).toBe(true);
    expect(result.chunks.length).toBeGreaterThan(0);
  });
});

describe("moved code in the diff viewer", () => {
  it("labels edited moves and highlights only their internal word edits", async () => {
    texts.after = second + third + first.replace("'first'", "'changed'");
    render(<DiffEditor input={input} />);
    const link = await screen.findByRole("button", { name: "Go to moved code at line 7" });
    expect(link).toHaveTextContent("(edited)");
    expect(document.querySelector(".cm-diffMoveEdit-deleted")?.textContent).toBe("first");
    expect(document.querySelector(".cm-diffMoveEdit-inserted")?.textContent).toBe("changed");
    fireEvent.click(link);
    const b = EditorView.findFromDOM(document.querySelector<HTMLElement>(".cm-editor.cm-merge-b")!)!;
    expect(b.state.doc.lineAt(b.state.selection.main.head).number).toBe(7);
  });

  it("omits inner edits in Highlight lines mode", async () => {
    texts.after = second + third + first.replace("'first'", "'changed'");
    localStorage.setItem("openidea.vcs.diffOptions", JSON.stringify({ highlight: "lines" }));
    render(<DiffEditor input={input} />);
    expect(await screen.findByRole("button", { name: "Go to moved code at line 7" })).toHaveTextContent("(edited)");
    expect(document.querySelector(".cm-diffMoveEdit")).toBeNull();
  });
  it("shows native move links, follows them in both directions and updates after editing", async () => {
    render(<DiffEditor input={input} />);
    const to = await screen.findByRole("button", { name: "Go to moved code at line 7" });
    await screen.findByText(/1 moved block/);
    const a = EditorView.findFromDOM(document.querySelector<HTMLElement>(".cm-editor.cm-merge-a")!)!;
    const b = EditorView.findFromDOM(document.querySelector<HTMLElement>(".cm-editor.cm-merge-b")!)!;
    expect(document.querySelectorAll(".cm-diffMoved").length).toBeGreaterThan(0);
    fireEvent.click(to);
    expect(b.state.doc.lineAt(b.state.selection.main.head).number).toBe(7);
    fireEvent.click(screen.getByRole("button", { name: "Go to original code at line 1" }));
    expect(a.state.selection.main.head).toBe(0);
    await act(async () => b.dispatch({ changes: { from: 0, to: b.state.doc.length, insert: texts.before } }));
    await waitFor(() => expect(screen.queryByText(/1 moved block/)).toBeNull());
    expect(document.querySelector(".cm-diffMoved")).toBeNull();
    expect(screen.queryByRole("button", { name: /Go to moved code/ })).toBeNull();
  });

  it("respects Do not highlight", async () => {
    texts.after = second + third + first.replace("'first'", "'changed'");
    localStorage.setItem("openidea.vcs.diffOptions", JSON.stringify({ highlight: "none" }));
    render(<DiffEditor input={input} />);
    await screen.findByText(/1 moved block/);
    expect(document.querySelector(".cm-diffMoved")).toBeNull();
    expect(document.querySelector(".cm-diffMoveEdit")).toBeNull();
    expect(screen.queryByRole("button", { name: /Go to moved code/ })).toBeNull();
  });

  it("explains ignored whitespace rather than displaying No differences", async () => {
    texts.before = "let a = 1;\n";
    texts.after = "  let a = 1;\n";
    localStorage.setItem("openidea.vcs.diffOptions", JSON.stringify({ ignore: "whitespace" }));
    render(<DiffEditor input={input} />);
    expect(await screen.findByText("Whitespace-only changes")).toBeInTheDocument();
    expect(screen.queryByText("No differences")).toBeNull();
  });
});
