import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorContributions, type EditorDocContext } from "@/editor/api";
import type { OutlineItem } from "@/platform/ipc";

vi.mock("@/features/search/structure/store", async (orig) => ({
  ...(await orig<typeof import("@/features/search/structure/store")>()),
  useLiveOutline: () => undefined,
}));

const { registerMarkdownLiveSource, useLiveMarkdown } = await import("./live");
const { MarkdownEditor } = await import("./MarkdownEditor");
const { useMarkdownModes } = await import("./modes");
const { StructureView } = await import("@/features/search/structure/StructureView");
const { useOutline, useStructureOptions } = await import("@/features/search/structure/store");

const path = "/p/README.md";
const ctx: EditorDocContext = { doc: 1, path, language: "markdown", uiMode: null, readOnly: false };
const source = Array.from({ length: 40 }, (_, i) => (i % 10 === 0 ? `# H${i / 10}` : i % 10 === 5 ? "text" : "")).join(
  "\n",
);
/** Each source line is 10px tall in the fake layout. */
const LINE = 10;

const section = (name: string, line: number): OutlineItem => ({
  name,
  detail: null,
  kind: "heading" as OutlineItem["kind"],
  range: { start: { line, col: 0 }, end: { line: line + 9, col: 0 } },
  selection_range: { start: { line, col: 2 }, end: { line, col: 4 } },
  children: [],
});

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
  const goTo = (line: number) =>
    act(() => view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(line + 1).from) }));

  it("scrolls to where the hidden editor's caret is sent, again on the same place", () => {
    const el = preview();
    expect(useLiveMarkdown.getState()[path]?.previewLine).toBe(0);

    goTo(20);
    expect(el.scrollTop).toBe(200);
    expect(useLiveMarkdown.getState()[path]?.previewLine).toBe(20);

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
    expect(useLiveMarkdown.getState()[path]?.previewLine).toBe(30);

    el.scrollTop = 157;
    fireEvent.scroll(el);
    expect(useLiveMarkdown.getState()[path]?.previewLine).toBe(15);
  });

  it("leaves the split preview to the editor's scroll sync", () => {
    act(() => useMarkdownModes.setState((s) => ({ byPath: { ...s.byPath, [path]: "split" } })));
    const el = preview();
    goTo(20);
    expect(el.scrollTop).toBe(0);
    el.scrollTop = 157;
    fireEvent.scroll(el);
    expect(useLiveMarkdown.getState()[path]?.previewLine).toBeNull();
  });

  it("drives Structure's Autoscroll from Source", () => {
    useOutline.setState({
      path,
      doc: 1,
      loading: false,
      error: null,
      items: [section("H0", 0), section("H1", 10), section("H2", 20), section("H3", 30)],
    });
    useStructureOptions.setState({ autoscrollFromSource: true });
    const el = preview();
    render(<StructureView />);
    const selected = () => screen.getAllByRole("treeitem").find((r) => r.getAttribute("aria-selected") === "true");

    expect(selected()?.textContent).toContain("H0");
    act(() => {
      el.scrollTop = 255;
      fireEvent.scroll(el);
    });
    expect(selected()?.textContent).toContain("H2");
  });
});
