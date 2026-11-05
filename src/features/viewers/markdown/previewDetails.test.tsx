import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { _addEditor, _removeEditor, editorContributions, type EditorDocContext } from "@/editor/api";
import { fontZoom } from "@/editor/core/cm/prefs";
import { useContextKeys } from "@/platform/context";
import { registerMarkdownLiveSource, useLiveMarkdown } from "./live";
import { MarkdownEditor } from "./MarkdownEditor";
import { useMarkdownModes } from "./modes";

const ctx: EditorDocContext = { doc: 1, path: "/p/NOTES.md", language: "markdown", uiMode: null, readOnly: false };
const doc =
  "<details>\n<summary>One</summary>\n\nFirst\n\n</details>\n\n<details open>\n<summary>Two</summary>\n\nSecond\n\n</details>\n";

describe("preview <details>", () => {
  const disposers: Array<() => void> = [];
  let view: EditorView;

  beforeEach(() => {
    disposers.push(registerMarkdownLiveSource());
    useContextKeys.setState({ projectOpen: true, textEditorActive: true });
    const live = editorContributions().find((c) => c.id === "viewers.markdownLive")!;
    view = new EditorView({ state: EditorState.create({ doc, extensions: [fontZoom, live.extensions(ctx)] }) });
    const handle = { view, ctx };
    _addEditor(handle);
    disposers.push(() => _removeEditor(handle));
    act(() => useMarkdownModes.setState((s) => ({ byPath: { ...s.byPath, [ctx.path]: "split" } })));
  });
  afterEach(() => {
    cleanup();
    view.destroy();
    for (const dispose of disposers.splice(0).reverse()) dispose();
    useLiveMarkdown.setState({}, true);
    useContextKeys.setState({}, true);
  });

  it("keeps what the reader opened and closed across edits", async () => {
    render(
      <MarkdownEditor path={ctx.path} tabId="t">
        <div />
      </MarkdownEditor>,
    );
    const preview = screen.getByRole("document", { name: "Markdown preview" });
    const details = () => [...preview.querySelectorAll("details")];
    await waitFor(() => expect(details().map((d) => d.open)).toEqual([false, true]));
    expect(details()[0]!.querySelector(":scope > p")?.textContent).toBe("First");

    const [one, two] = details();
    fireEvent.click(one!.querySelector("summary")!);
    one!.open = true; // jsdom has no summary activation behaviour
    fireEvent.click(two!.querySelector("summary")!);
    two!.open = false;

    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "\nMore\n" } }));
    await waitFor(() => expect(preview.textContent).toContain("More"));
    expect(details().map((d) => d.open)).toEqual([true, false]);
  });
});
