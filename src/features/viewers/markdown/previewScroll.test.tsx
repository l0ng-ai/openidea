import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { _addEditor, _removeEditor, editorContributions, type EditorDocContext } from "@/editor/api";
import { fontZoom } from "@/editor/core/cm/prefs";
import type { EditorSlot } from "@/editor/core/model/slot";
import { useContextKeys } from "@/platform/context";

let activeSlot: Partial<EditorSlot> | null = null;
vi.mock("@/editor/core/controller", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  editorController: () => ({
    get activeSlot() {
      return activeSlot;
    },
  }),
}));

const { registerMarkdownLiveSource, useLiveMarkdown } = await import("./live");
const { MarkdownEditor } = await import("./MarkdownEditor");
const { useMarkdownModes } = await import("./modes");

const mdCtx: EditorDocContext = { doc: 1, path: "/p/README.md", language: "markdown", uiMode: null, readOnly: false };

describe("preview-only scroll position", () => {
  const disposers: Array<() => void> = [];
  const views: EditorView[] = [];

  const open = (ctx: EditorDocContext, doc = "# Title") => {
    const live = editorContributions().find((c) => c.id === "viewers.markdownLive")!;
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: [fontZoom, live.extensions(ctx)] }),
    });
    const handle = { view, ctx };
    _addEditor(handle);
    disposers.push(() => _removeEditor(handle));
    views.push(view);
    return view;
  };
  const activate = (view: EditorView) => (activeSlot = { view, disposed: false });

  beforeEach(() => {
    disposers.push(registerMarkdownLiveSource());
    useContextKeys.setState({ projectOpen: true, textEditorActive: true, editorFocus: true, popupOpen: true });
  });
  afterEach(() => {
    cleanup();
    for (const view of views.splice(0)) view.destroy();
    for (const dispose of disposers.splice(0).reverse()) dispose();
    activeSlot = null;
    useLiveMarkdown.setState({}, true);
    useContextKeys.setState({}, true);
  });

  it("restores the preview's own scroll after a remount", async () => {
    open(mdCtx);
    activate(views[0]!);
    act(() => useMarkdownModes.setState((s) => ({ byPath: { ...s.byPath, [mdCtx.path]: "preview" } })));
    const first = render(
      <MarkdownEditor path={mdCtx.path} tabId="t">
        <div />
      </MarkdownEditor>,
    );
    const preview = screen.getByRole("document", { name: "Markdown preview" });
    await act(async () => {
      preview.scrollTop = 300;
      preview.dispatchEvent(new Event("scroll"));
    });
    expect(useLiveMarkdown.getState()[mdCtx.path]?.previewTop).toBe(300);

    // Tab switches and mode toggles unmount the preview; a fresh mount keeps the position.
    first.unmount();
    const second = render(
      <MarkdownEditor path={mdCtx.path} tabId="t">
        <div />
      </MarkdownEditor>,
    );
    expect(screen.getByRole("document", { name: "Markdown preview" }).scrollTop).toBe(300);
    second.unmount();
  });

  it("follows a structure reveal while the editor is hidden", async () => {
    const view = open(mdCtx, "# H\n\ntext one\n\ntext two");
    activate(view);
    act(() => useMarkdownModes.setState((s) => ({ byPath: { ...s.byPath, [mdCtx.path]: "preview" } })));
    render(
      <MarkdownEditor path={mdCtx.path} tabId="t">
        <div />
      </MarkdownEditor>,
    );
    const preview = screen.getByRole("document", { name: "Markdown preview" });
    // jsdom lays nothing out: pin the geometry the sync interpolates between.
    Object.defineProperty(preview, "scrollHeight", { value: 1000 });
    const blocks = [...preview.querySelectorAll<HTMLElement>(":scope > [data-line]")];
    for (const [i, el] of blocks.entries()) Object.defineProperty(el, "offsetTop", { value: i * 100 });
    // A structure click lands as a selection in the hidden editor, which
    // cannot scroll: the reveal publishes its line for the preview to apply.
    await act(async () => {
      view.dispatch({ selection: { anchor: view.state.doc.line(4).from } });
    });
    const live = useLiveMarkdown.getState()[mdCtx.path];
    expect(live?.revealSeq).toBe(1);
    expect(live?.topLine).toBe(3);
    // Line 3 sits halfway between the block at line 2 (top 100) and the one at line 4 (top 200).
    expect(preview.scrollTop).toBe(150);
  });

  it("leaves reveals to the editor when it is rendered", async () => {
    const view = open(mdCtx);
    vi.spyOn(view.scrollDOM, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    act(() => useMarkdownModes.setState((s) => ({ byPath: { ...s.byPath, [mdCtx.path]: "split" } })));
    render(
      <MarkdownEditor path={mdCtx.path} tabId="t">
        <div />
      </MarkdownEditor>,
    );
    await act(async () => {
      view.dispatch({ selection: { anchor: view.state.doc.line(1).from } });
    });
    // The rendered editor scrolls and its scroll events drive the sync above.
    expect(useLiveMarkdown.getState()[mdCtx.path]?.revealSeq).toBeUndefined();
  });
});
