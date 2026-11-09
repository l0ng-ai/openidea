import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { expect, it, vi } from "vitest";
import { useEditorRegistry } from "@/editor/api";
import { setFileDiagnostics } from "@/editor/lsp/diagnostics";
import { activate } from "../conflictMarkers";

vi.mock("@/editor/lsp/diagnostics", () => ({ setFileDiagnostics: vi.fn() }));

it("coalesces a burst of edits in a large document into one inspection", () => {
  vi.useFakeTimers();
  const dispose = activate();
  const extensions = useEditorRegistry.getState().contributions.get("merge-conflict-markers")!.extensions({
    doc: 1,
    path: "/large.md",
    language: "markdown",
    uiMode: null,
    readOnly: false,
  });
  const view = new EditorView({
    state: EditorState.create({ doc: "plain text\n".repeat(100_000), extensions }),
  });
  try {
    vi.mocked(setFileDiagnostics).mockClear();
    for (const insert of ["<<<<<<< ours\n", "a\n=======\n", "b\n>>>>>>> theirs\n"]) {
      view.dispatch({ changes: { from: view.state.doc.length, insert } });
      vi.advanceTimersByTime(100);
    }
    expect(setFileDiagnostics).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(setFileDiagnostics).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setFileDiagnostics).mock.calls[0]![2]).toHaveLength(3);
  } finally {
    view.destroy();
    dispose();
    vi.useRealTimers();
  }
});
