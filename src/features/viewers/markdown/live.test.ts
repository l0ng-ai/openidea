import { EditorState } from "@codemirror/state";
import { BlockType, EditorView, type BlockInfo } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editorContributions, type EditorDocContext } from "@/editor/api";
import { installMarkdownSourceScroll, registerMarkdownLiveSource, useLiveMarkdown } from "./live";

const ctx: EditorDocContext = { doc: 1, path: "/p/README.md", language: "markdown", uiMode: null, readOnly: false };

describe("Markdown source scroll", () => {
  let view: EditorView;
  let unregister: () => void;

  beforeEach(() => {
    unregister = registerMarkdownLiveSource();
    const contribution = editorContributions().find((item) => item.id === "viewers.markdownLive")!;
    view = new EditorView({
      state: EditorState.create({
        doc: "# Title\nA wrapped line\nMore text",
        extensions: contribution.extensions(ctx),
      }),
    });
    Object.defineProperties(view.scrollDOM, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 500 },
    });
    vi.spyOn(view.scrollDOM, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 400, 100));
  });

  afterEach(() => {
    view.destroy();
    unregister();
    useLiveMarkdown.setState({}, true);
    vi.restoreAllMocks();
  });

  function sourceBlock(lineNumber: number, top: number, height: number): BlockInfo {
    const { from, to, length } = view.state.doc.line(lineNumber);
    return {
      from,
      to,
      length,
      top,
      height,
      bottom: top + height,
      type: BlockType.Text,
      widget: null,
      widgetLineBreaks: 0,
    };
  }

  it("publishes progress within the visible line and tracks the source bottom", () => {
    vi.spyOn(view, "requestMeasure").mockImplementation((request) => {
      if (request) request.write?.(request.read(view), view);
    });
    vi.spyOn(view, "documentTop", "get").mockReturnValue(30);
    vi.spyOn(view, "lineBlockAtHeight").mockReturnValue(sourceBlock(2, 50, 40));
    const scroller = view.scrollDOM;
    const position = () => useLiveMarkdown.getState()[ctx.path];

    scroller.scrollTop = 75;
    scroller.dispatchEvent(new Event("scroll"));
    expect(view.lineBlockAtHeight).toHaveBeenCalledWith(70);
    expect(position()).toMatchObject({ topLine: 1.5, sourceAtEnd: false, scrollSeq: 1 });

    scroller.scrollTop = 399.5;
    scroller.dispatchEvent(new Event("scroll"));
    expect(position()).toMatchObject({ topLine: 1.5, sourceAtEnd: true, scrollSeq: 2 });

    scroller.scrollTop = 75;
    scroller.dispatchEvent(new Event("scroll"));
    expect(position()).toMatchObject({ topLine: 1.5, sourceAtEnd: false, scrollSeq: 3 });
  });

  it("weights the top visual row by the source characters in that wrap", () => {
    vi.spyOn(view, "requestMeasure").mockImplementation((request) => {
      if (request) request.write?.(request.read(view), view);
    });
    vi.spyOn(view, "inView", "get").mockReturnValue(true);
    vi.spyOn(view, "documentTop", "get").mockReturnValue(35);
    vi.spyOn(view, "lineWrapping", "get").mockReturnValue(true);
    vi.spyOn(view, "defaultLineHeight", "get").mockReturnValue(10);
    vi.spyOn(view, "lineBlockAtHeight").mockReturnValue(sourceBlock(2, 50, 30));
    const line = view.state.doc.line(2);
    vi.spyOn(view, "posAtCoords")
      .mockReturnValueOnce(line.from + 7)
      .mockReturnValueOnce(line.from + 9);
    view.scrollDOM.dispatchEvent(new Event("scroll"));
    expect(useLiveMarkdown.getState()[ctx.path]?.topLine).toBeCloseTo(1 + 8 / (line.length + 1));
  });

  it("measures a wheel jump that would expose an unrendered part of the source", () => {
    const block = sourceBlock(1, 0, 140);
    vi.spyOn(view, "documentTop", "get").mockReturnValue(100);
    vi.spyOn(view, "viewport", "get").mockReturnValue({ from: block.from, to: block.to });
    vi.spyOn(view, "viewportLineBlocks", "get").mockReturnValue([block]);
    const measure = vi.spyOn(view, "requestMeasure").mockImplementation(() => {});
    const lineAtHeight = vi.spyOn(view, "lineBlockAtHeight").mockReturnValue(block);
    const scrollBy = vi.fn();
    Object.defineProperty(view.scrollDOM, "scrollBy", { value: scrollBy });
    const dispose = installMarkdownSourceScroll(view.dom);
    const wheel = (init: WheelEventInit) =>
      view.contentDOM.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init }));

    try {
      expect(wheel({ deltaY: 10 })).toBe(true);
      expect(wheel({ deltaY: 100, ctrlKey: true })).toBe(true);
      expect(wheel({ deltaX: 100, deltaY: 10 })).toBe(true);
      expect(wheel({ deltaX: 3, deltaY: 100 })).toBe(false);
      expect(scrollBy).toHaveBeenCalledExactlyOnceWith(3, 100);
      expect(measure).toHaveBeenCalledTimes(1);
      expect(lineAtHeight).toHaveBeenCalledExactlyOnceWith(100);
    } finally {
      dispose();
    }
  });
});
