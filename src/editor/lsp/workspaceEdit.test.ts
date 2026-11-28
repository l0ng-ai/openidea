import { afterEach, describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { _resetI18nForTests, setLocale } from "@/platform/i18n";
import { describeSummary, editPreviewLines, needsPreview, summarizeWorkspaceEdit } from "./workspaceEdit";

const edit = (line: number) => ({ range: { start: { line, col: 0 }, end: { line, col: 3 } }, new_text: "new" });

describe("summarizeWorkspaceEdit", () => {
  afterEach(() => _resetI18nForTests());

  it("counts files and occurrences", () => {
    const s = summarizeWorkspaceEdit({
      files: [
        { kind: "edit", path: "/p/b.rs", edits: [edit(1), edit(2)] },
        { kind: "edit", path: "/p/a.rs", edits: [edit(4)] },
        { kind: "edit", path: "/p/b.rs", edits: [edit(9)] },
        { kind: "edit", path: "/p/empty.rs", edits: [] },
      ],
    });
    expect(s.files).toBe(2);
    expect(s.occurrences).toBe(4);
    expect(s.hasFileOperations).toBe(false);
    expect(s.entries.map((e) => [e.path, e.edits])).toEqual([
      ["/p/a.rs", 1],
      ["/p/b.rs", 3],
    ]);
    expect(describeSummary(s)).toBe("4 occurrences in 2 files");
    expect(needsPreview(s)).toBe(true);
  });

  it("previews file operations even in a single file", () => {
    const s = summarizeWorkspaceEdit({
      files: [
        { kind: "edit", path: "/p/a.ts", edits: [edit(0)] },
        { kind: "rename", from: "/p/a.ts", to: "/p/b.ts" },
      ],
    });
    expect(s.files).toBe(1);
    expect(s.entries[0]).toMatchObject({ operation: "rename", to: "/p/b.ts", edits: 1 });
    expect(needsPreview(s)).toBe(true);
    expect(describeSummary(s)).toBe("1 occurrence in 1 file");
  });

  it("translates the count line", async () => {
    await setLocale("zh");
    const s = summarizeWorkspaceEdit({
      files: [
        { kind: "edit", path: "/p/a.py", edits: [edit(0), edit(1)] },
        { kind: "edit", path: "/p/b.py", edits: [edit(0), edit(1)] },
        { kind: "edit", path: "/p/c.py", edits: [] },
        { kind: "edit", path: "/p/d.py", edits: [edit(2)] },
      ],
    });
    expect(describeSummary(s)).toBe("3 个文件中的 5 处匹配项");
  });

  it("applies single-file renames directly", () => {
    const s = summarizeWorkspaceEdit({ files: [{ kind: "edit", path: "/p/a.ts", edits: [edit(0), edit(3)] }] });
    expect(needsPreview(s)).toBe(false);
  });

  it("handles empty edits", () => {
    const s = summarizeWorkspaceEdit({ files: [] });
    expect(s).toMatchObject({ files: 0, occurrences: 0 });
  });
});

describe("editPreviewLines", () => {
  const doc = Text.of([
    "function f() {",
    "  return price * 2;",
    "}",
    "",
    "const a = 1;",
    "const b = 2;",
    "const c = 3;",
  ]);
  const at = (line: number, col: number) => ({ line, col });

  it("shows changed lines with one line of context, hunks separated", () => {
    const lines = editPreviewLines(doc, [
      { range: { start: at(1, 2), end: at(1, 2) }, new_text: "const x = price * 2;\n  " },
      { range: { start: at(1, 9), end: at(1, 18) }, new_text: "x" },
      { range: { start: at(6, 10), end: at(6, 11) }, new_text: "4" },
    ]);
    expect(lines).toEqual([
      { kind: "context", text: "function f() {" },
      { kind: "removed", text: "  return price * 2;" },
      { kind: "added", text: "  const x = price * 2;" },
      { kind: "added", text: "  return x;" },
      { kind: "context", text: "}" },
      { kind: "gap", text: "" },
      { kind: "context", text: "const b = 2;" },
      { kind: "removed", text: "const c = 3;" },
      { kind: "added", text: "const c = 4;" },
    ]);
  });

  it("is empty when nothing changes", () => {
    expect(editPreviewLines(doc, [{ range: { start: at(0, 0), end: at(0, 8) }, new_text: "function" }])).toEqual([]);
  });
});
