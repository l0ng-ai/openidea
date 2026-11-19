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

  const open = (ctx: EditorDocContext) => {
    const live = editorContributions().find((c) => c.id === "viewers.markdownLive")!;
    const view = new EditorView({
      state: EditorState.create({ doc: "# Title", extensions: [fontZoom, live.extensions(ctx)] }),
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
    act(() => useMarkdownModes.setState((s) => ({ byTab: { ...s.byTab, t: "preview" } })));
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

  it("re-applies a restore that clamped to not-yet-drawn content", async () => {
    open(mdCtx);
    activate(views[0]!);
    act(() => useLiveMarkdown.setState((s) => ({ [mdCtx.path]: { ...s[mdCtx.path]!, previewTop: 300 } })));
    act(() => useMarkdownModes.setState((s) => ({ byTab: { ...s.byTab, t: "preview" } })));
    render(
      <MarkdownEditor path={mdCtx.path} tabId="t">
        <div />
      </MarkdownEditor>,
    );
    const preview = screen.getByRole("document", { name: "Markdown preview" });

    // While images load, the document is short and the browser clamps the offset.
    const scrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
    let top = 0;
    let maxTop = 100;
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = Math.min(v, maxTop);
      },
    });
    try {
      // Re-running the restore (mode toggle) hits the clamp…
      act(() => useMarkdownModes.setState((s) => ({ byTab: { ...s.byTab, t: "split" } })));
      act(() => useMarkdownModes.setState((s) => ({ byTab: { ...s.byTab, t: "preview" } })));
      expect(preview.scrollTop).toBe(100);
      // The browser reports the clamped write as a scroll; the saved offset stays.
      act(() => preview.dispatchEvent(new Event("scroll")));
      expect(useLiveMarkdown.getState()[mdCtx.path]?.previewTop).toBe(300);

      // …and the settle after the heights arrive applies the saved offset again.
      await act(async () => {
        maxTop = 1000;
        useLiveMarkdown.setState((s) => ({ [mdCtx.path]: { ...s[mdCtx.path]!, fontZoom: 2 } }));
      });
      expect(preview.scrollTop).toBe(300);
    } finally {
      if (scrollTop) Object.defineProperty(HTMLElement.prototype, "scrollTop", scrollTop);
      else delete (HTMLElement.prototype as unknown as { scrollTop?: unknown }).scrollTop;
    }
  });

  it("hands the position back to the reader once they scroll", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    open(mdCtx);
    activate(views[0]!);
    act(() => useLiveMarkdown.setState((s) => ({ [mdCtx.path]: { ...s[mdCtx.path]!, previewTop: 300 } })));
    act(() => useMarkdownModes.setState((s) => ({ byTab: { ...s.byTab, t: "preview" } })));
    render(
      <MarkdownEditor path={mdCtx.path} tabId="t">
        <div />
      </MarkdownEditor>,
    );
    const preview = screen.getByRole("document", { name: "Markdown preview" });

    await act(async () => {
      preview.scrollTop = 60;
      preview.dispatchEvent(new Event("scroll"));
    });
    await act(async () => {
      useLiveMarkdown.setState((s) => ({ [mdCtx.path]: { ...s[mdCtx.path]!, fontZoom: 2 } }));
    });
    expect(preview.scrollTop).toBe(60);
    expect(useLiveMarkdown.getState()[mdCtx.path]?.previewTop).toBe(60);
  });
});
