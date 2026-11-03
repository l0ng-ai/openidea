import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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

const { registerEditorActions } = await import("@/editor/core/actions");
const { registerMarkdownLiveSource, setPreviewScroll, useLiveMarkdown } = await import("./live");
const { MarkdownEditor } = await import("./MarkdownEditor");
const { useMarkdownModes } = await import("./modes");

const mdDoc = "# Section 1\n\nLine 1\n\nLine 2\n\n# Section 2\n\nLine 3\n\nLine 4\n\n# Section 3\n\nLine 5\n\nLine 6\n";
const mdCtx: EditorDocContext = { doc: 1, path: "/p/README.md", language: "markdown", uiMode: null, readOnly: false };

describe("Markdown preview scroll position restore (Issue #974)", () => {
  const disposers: Array<() => void> = [];
  const views: EditorView[] = [];

  const open = (ctx: EditorDocContext, text = mdDoc) => {
    const live = editorContributions().find((c) => c.id === "viewers.markdownLive")!;
    const extensions = [fontZoom, live.extensions(ctx)];
    const view = new EditorView({ state: EditorState.create({ doc: text, extensions }) });
    const handle = { view, ctx };
    _addEditor(handle);
    disposers.push(() => _removeEditor(handle));
    views.push(view);
    return view;
  };
  const activate = (view: EditorView) => (activeSlot = { view, disposed: false });

  beforeEach(() => {
    disposers.push(registerEditorActions(), registerMarkdownLiveSource());
    useContextKeys.setState({ projectOpen: true, textEditorActive: true, editorFocus: true });
  });

  afterEach(() => {
    cleanup();
    for (const view of views.splice(0)) view.destroy();
    for (const dispose of disposers.splice(0).reverse()) dispose();
    activeSlot = null;
    useLiveMarkdown.setState({}, true);
    useContextKeys.setState({}, true);
    useMarkdownModes.setState({ byPath: {}, fallback: "split" }, true);
  });

  it("stores preview scroll position on scroll and restores it when switching tabs", async () => {
    const md = open(mdCtx);
    activate(md);
    act(() => useMarkdownModes.setState((s) => ({ byPath: { ...s.byPath, [mdCtx.path]: "preview" } })));

    // 1. Initial render in preview mode
    const { unmount } = render(
      <MarkdownEditor path={mdCtx.path} tabId="tab1">
        <div />
      </MarkdownEditor>,
    );

    const preview = screen.getByRole("document", { name: "Markdown preview" });
    expect(preview.scrollTop).toBe(0);

    // 2. User scrolls down in the preview
    Object.defineProperty(preview, "scrollTop", { value: 350, writable: true, configurable: true });
    fireEvent.scroll(preview);

    // Wait for requestAnimationFrame to flush setPreviewScroll
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    expect(useLiveMarkdown.getState()[mdCtx.path]?.previewScrollTop).toBe(350);

    // 3. User switches to another tab (unmounting MarkdownEditor)
    unmount();

    // 4. User switches back to Markdown tab (remounting MarkdownEditor)
    render(
      <MarkdownEditor path={mdCtx.path} tabId="tab1">
        <div />
      </MarkdownEditor>,
    );

    const restoredPreview = screen.getByRole("document", { name: "Markdown preview" });
    // Verify scroll position was restored instead of jumping to 0!
    expect(restoredPreview.scrollTop).toBe(350);
  });

  it("saves preview scroll position on unmount even if scroll event had pending frame", () => {
    const md = open(mdCtx);
    activate(md);
    act(() => useMarkdownModes.setState((s) => ({ byPath: { ...s.byPath, [mdCtx.path]: "preview" } })));

    const { unmount } = render(
      <MarkdownEditor path={mdCtx.path} tabId="tab1">
        <div />
      </MarkdownEditor>,
    );

    const preview = screen.getByRole("document", { name: "Markdown preview" });
    Object.defineProperty(preview, "scrollTop", { value: 480, writable: true, configurable: true });

    // Unmount before next animation frame
    unmount();

    expect(useLiveMarkdown.getState()[mdCtx.path]?.previewScrollTop).toBe(480);
  });

  it("maintains independent preview scroll positions for different files", async () => {
    const pathA = "/p/docA.md";
    const pathB = "/p/docB.md";

    act(() => {
      setPreviewScroll(pathA, 200);
      setPreviewScroll(pathB, 500);
      useMarkdownModes.setState({ byPath: { [pathA]: "preview", [pathB]: "preview" }, fallback: "preview" });
    });

    const ctxA: EditorDocContext = { doc: 10, path: pathA, language: "markdown", uiMode: null, readOnly: false };
    const ctxB: EditorDocContext = { doc: 11, path: pathB, language: "markdown", uiMode: null, readOnly: false };
    open(ctxA, "# Doc A\n\nText A");
    open(ctxB, "# Doc B\n\nText B");

    const { unmount: unmountA } = render(
      <MarkdownEditor path={pathA} tabId="tabA">
        <div />
      </MarkdownEditor>,
    );
    const previewA = screen.getByRole("document", { name: "Markdown preview" });
    expect(previewA.scrollTop).toBe(200);
    unmountA();

    const { unmount: unmountB } = render(
      <MarkdownEditor path={pathB} tabId="tabB">
        <div />
      </MarkdownEditor>,
    );
    const previewB = screen.getByRole("document", { name: "Markdown preview" });
    expect(previewB.scrollTop).toBe(500);
    unmountB();
  });

  it("restores preview scroll in split mode when topLine is 0", async () => {
    act(() => {
      setPreviewScroll(mdCtx.path, 175);
      useMarkdownModes.setState((s) => ({ byPath: { ...s.byPath, [mdCtx.path]: "split" } }));
    });

    const md = open(mdCtx);
    activate(md);

    render(
      <MarkdownEditor path={mdCtx.path} tabId="tab1">
        <div />
      </MarkdownEditor>,
    );

    const preview = screen.getByRole("document", { name: "Markdown preview" });
    expect(preview.scrollTop).toBe(175);
  });
});
