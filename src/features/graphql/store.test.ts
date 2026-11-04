import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { _addEditor, _removeEditor, type TextEditorHandle } from "@/editor/api";

let onOpen: (path: string) => void = () => {};
const openFile = vi.fn(async (path: string) => onOpen(path));
vi.mock("@/workbench/contributions", async (orig) => {
  const actual = await orig<typeof import("@/workbench/contributions")>();
  return { ...actual, editorService: () => ({ openFile }) };
});

const { replaceFileText } = await import("./store");

function editorOf(path: string, text: string): TextEditorHandle {
  const view = new EditorView({ state: EditorState.create({ doc: text }) });
  return { view, ctx: { path } as TextEditorHandle["ctx"] };
}

describe("replaceFileText", () => {
  it("replaces the text once the tab just opened has created its editor", async () => {
    const editor = editorOf("/p/schema.graphql", "type Query { a: Int }");
    // The tab mounts its editor after openFile resolves, as for a file that was not open.
    onOpen = () => void setTimeout(() => _addEditor(editor), 10);
    try {
      expect(await replaceFileText("/p/schema.graphql", "type Query { b: Int }")).toBe(true);
      expect(editor.view.state.doc.toString()).toBe("type Query { b: Int }");
    } finally {
      _removeEditor(editor);
      editor.view.destroy();
    }
  });

  it("reports when no editor shows the file", async () => {
    onOpen = () => {};
    expect(await replaceFileText("/p/missing.graphql", "x", 50)).toBe(false);
  });
});
