import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorContributions, useShownLine, type EditorDocContext } from "@/editor/api";

const { registerMarkdownLiveSource, useLiveMarkdown } = await import("./live");
const { MarkdownEditor } = await import("./MarkdownEditor");
const { useMarkdownModes } = await import("./modes");

const path = "/p/README.md";
const ctx: EditorDocContext = { doc: 1, path, language: "markdown", uiMode: null, readOnly: false };
const source = Array.from({ length: 40 }, (_, i) => (i % 10 === 0 ? `# H${i / 10}` : i % 10 === 5 ? "text" : "")).join(
  "\n",
);
/** Each source line is 10px tall in the fake layout. */
const LINE = 10;

describe("Markdown Preview only", () => {
  const disposers: Array<() => void> = [];
  let view: EditorView;
  const offsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop")!;

  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, "offsetTop", {
      configurable: true,
      get(this: HTMLElement) {
        return Number(this.dataset.line ?? 0) * LINE;
      },
    });
  });
  afterAll(() => Object.defineProperty(HTMLElement.prototype, "offsetTop", offsetTop));

  beforeEach(() => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    disposers.push(registerMarkdownLiveSource());
    const live = editorContributions().find((c) => c.id === "viewers.markdownLive")!;
    view = new EditorView({ state: EditorState.create({ doc: source, extensions: [live.extensions(ctx)] }) });
    act(() => useMarkdownModes.setState((s) => ({ byPath: { ...s.byPath, [path]: "preview" } })));
  });
  afterEach(() => {
    cleanup();
    view.destroy();
    for (const dispose of disposers.splice(0).reverse()) dispose();
    useLiveMarkdown.setState({}, true);
    vi.restoreAllMocks();
  });

  const preview = () => {
    render(
      <MarkdownEditor path={path} tabId="t">
        <div />
      </MarkdownEditor>,
    );
    const el = screen.getByRole("document", { name: "Markdown preview" });
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 40 * LINE });
    return el;
  };
  const shown = () => renderHook(() => useShownLine(path)).result.current;
  const goTo = (line: number) =>
    act(() => view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(line + 1).from) }));

  it("scrolls to where the hidden editor's caret is sent, again on the same place", () => {
    const el = preview();
    expect(shown()).toBe(0);

    goTo(20);
    expect(el.scrollTop).toBe(200);
    expect(shown()).toBe(20);

    act(() => {
      el.scrollTop = 0;
    });
    goTo(20);
    expect(el.scrollTop).toBe(200);
  });

  it("reports the line on screen as the user scrolls, not after navigating", () => {
    const el = preview();
    goTo(30);
    fireEvent.scroll(el);
    expect(shown()).toBe(30);

    el.scrollTop = 157;
    fireEvent.scroll(el);
    expect(shown()).toBe(15);
  });

  it("reports the restored line when shown again after a remount", () => {
    act(() => useLiveMarkdown.setState((s) => ({ [path]: { ...s[path]!, previewTop: 205 } })));
    const el = preview();
    expect(el.scrollTop).toBe(205);
    expect(shown()).toBe(20);
  });

  it("leaves the split preview to the editor's scroll sync", () => {
    act(() => useMarkdownModes.setState((s) => ({ byPath: { ...s.byPath, [path]: "split" } })));
    const el = preview();
    goTo(20);
    expect(el.scrollTop).toBe(0);
    el.scrollTop = 157;
    fireEvent.scroll(el);
    expect(shown()).toBeNull();
  });

  it("stops standing in for the editor when the editor comes back or the preview closes", () => {
    const el = preview();
    goTo(20);
    expect(shown()).toBe(20);
    act(() => useMarkdownModes.setState((s) => ({ byPath: { ...s.byPath, [path]: "split" } })));
    expect(shown()).toBeNull();

    act(() => useMarkdownModes.setState((s) => ({ byPath: { ...s.byPath, [path]: "preview" } })));
    expect(shown()).not.toBeNull();
    cleanup();
    expect(shown()).toBeNull();
    void el;
  });
});
