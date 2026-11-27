import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import type { EditorView } from "@codemirror/view";
import { _addEditor, _removeEditor, type TextEditorHandle } from "@/editor/api";
import { MarkdownEditor } from "./MarkdownEditor";
import { setMarkdownMode, useMarkdownModes } from "./modes";

const PATH = "/p/README.md";
const OTHER_PATH = "/p/OTHER.md";
const SPLIT_KEY = "openidea.markdown.split";

describe("Markdown split resizer", () => {
  beforeEach(() => {
    localStorage.clear();
    useMarkdownModes.setState({ byTab: {}, fallback: "split" });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("shows the separator only in split mode without remounting the editor across mode changes", () => {
    let mounts = 0;
    function Probe() {
      useEffect(() => {
        mounts++;
      }, []);
      return <div data-testid="editor-probe" />;
    }

    render(
      <MarkdownEditor path={PATH} tabId="t">
        <Probe />
      </MarkdownEditor>,
    );
    expect(screen.getByRole("separator", { name: "Resize Markdown preview" })).toBeInTheDocument();
    expect(mounts).toBe(1);

    act(() => setMarkdownMode("t", "preview"));
    expect(screen.queryByRole("separator", { name: "Resize Markdown preview" })).toBeNull();
    expect(screen.getByTestId("editor-probe")).toBeInTheDocument();
    expect(mounts).toBe(1);

    act(() => setMarkdownMode("t", "editor"));
    expect(screen.queryByRole("separator", { name: "Resize Markdown preview" })).toBeNull();
    expect(screen.getByTestId("editor-probe")).toBeInTheDocument();
    expect(mounts).toBe(1);

    act(() => setMarkdownMode("t", "split"));
    expect(screen.getByRole("separator", { name: "Resize Markdown preview" })).toBeInTheDocument();
    expect(mounts).toBe(1);
  });

  it("shares one persisted split layout across Markdown files and resets to 50/50 on double-click", () => {
    localStorage.setItem(SPLIT_KEY, JSON.stringify({ editor: 32, preview: 68 }));
    const { container, unmount } = render(
      <MarkdownEditor path={PATH} tabId="t">
        <div />
      </MarkdownEditor>,
    );
    const flexGrowOf = (root: HTMLElement, id: string) =>
      Number((root.querySelector<HTMLElement>(`[data-panel]#${id}`)?.style.flexGrow ?? "0").trim());

    expect(flexGrowOf(container, "editor")).toBe(32);
    expect(flexGrowOf(container, "preview")).toBe(68);
    unmount();

    // Another Markdown file inherits the shared split ratio.
    const second = render(
      <MarkdownEditor path={OTHER_PATH} tabId="t2">
        <div />
      </MarkdownEditor>,
    );
    expect(flexGrowOf(second.container, "editor")).toBe(32);
    expect(flexGrowOf(second.container, "preview")).toBe(68);

    // Double-clicking the handle resets to 50/50 and updates localStorage.
    fireEvent.doubleClick(screen.getByRole("separator", { name: "Resize Markdown preview" }));
    expect(flexGrowOf(second.container, "editor")).toBe(50);
    expect(flexGrowOf(second.container, "preview")).toBe(50);
    expect(JSON.parse(localStorage.getItem(SPLIT_KEY)!)).toEqual({ editor: 50, preview: 50 });
  });

  it("re-measures the backing CodeMirror view whenever the editor pane width changes", () => {
    const observers = new Map<Element, ResizeObserverCallback>();
    const OrigRO = globalThis.ResizeObserver;
    class MockRO {
      constructor(private cb: ResizeObserverCallback) {}
      observe(el: Element) {
        observers.set(el, this.cb);
      }
      unobserve(el: Element) {
        observers.delete(el);
      }
      disconnect() {}
    }
    globalThis.ResizeObserver = MockRO as unknown as typeof ResizeObserver;

    const requestMeasure = vi.fn();
    const handle: TextEditorHandle = {
      view: { requestMeasure } as unknown as EditorView,
      ctx: { doc: 1, path: PATH, language: "markdown", uiMode: null, readOnly: false },
      tabId: "t",
    };
    _addEditor(handle);

    try {
      const { container } = render(
        <MarkdownEditor path={PATH} tabId="t">
          <div data-testid="inner-host" />
        </MarkdownEditor>,
      );
      const editorEl = screen.getByTestId("inner-host").parentElement as HTMLElement;
      expect(container.contains(editorEl)).toBe(true);
      const notify = observers.get(editorEl)!;
      let width = 500;
      Object.defineProperty(editorEl, "clientWidth", { configurable: true, get: () => width });

      width = 320;
      notify([], {} as ResizeObserver);
      expect(requestMeasure).toHaveBeenCalledTimes(1);

      // Hidden in preview-only mode (0px), then shown again at full width -> measures again.
      width = 0;
      notify([], {} as ResizeObserver);
      expect(requestMeasure).toHaveBeenCalledTimes(1);

      width = 1000;
      notify([], {} as ResizeObserver);
      expect(requestMeasure).toHaveBeenCalledTimes(2);
    } finally {
      _removeEditor(handle);
      globalThis.ResizeObserver = OrigRO;
    }
  });
});
