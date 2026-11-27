import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { executeAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { setMarkdownMode, useMarkdownModes } from "../markdown/modes";
import { activate as activateViewers } from "../index";
import { ImageViewer, svgDataUrl } from "../ImageViewer";
import { imageInput } from "../fileKinds";
import { useLiveSvg } from "./live";
import { SvgEditor, svgModes } from "./SvgEditor";

vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    call: vi.fn(() => Promise.reject(new Error("no backend"))),
  };
});

const PATH = "/p/icon.svg";
// Hidden until it has loaded (jsdom never loads it), so found by tag rather than role.
const image = () => document.querySelector("img")!;

describe("SVG editor", () => {
  beforeEach(() => {
    localStorage.clear();
    svgModes.useModes.setState({ byTab: {}, fallback: "split" });
    useMarkdownModes.setState({ byTab: {}, fallback: "split" });
    useLiveSvg.setState({ [PATH]: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2"/>' });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("shows the source and the image side by side, switching layouts without reopening the editor", () => {
    let mounts = 0;
    function Source() {
      useEffect(() => {
        mounts++;
      }, []);
      return <div data-testid="source" />;
    }
    render(
      <SvgEditor path={PATH} tabId="t">
        <Source />
      </SvgEditor>,
    );
    expect(screen.getByRole("separator", { name: "Resize SVG preview" })).toBeInTheDocument();
    expect(image().src).toBe(svgDataUrl(useLiveSvg.getState()[PATH]!));
    // Beside the source the image viewer can't reload from disk or open the file a second time.
    expect(screen.queryByRole("button", { name: "Open as Text" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reload from Disk" })).toBeNull();

    act(() => svgModes.set("t", "editor"));
    expect(document.querySelector("img")).toBeNull();
    act(() => svgModes.set("t", "preview"));
    expect(image()).toBeInTheDocument();
    expect(screen.getByTestId("source")).toBeInTheDocument();
    expect(mounts).toBe(1);
  });

  it("redraws the image as the source is typed, and recovers from invalid SVG", () => {
    const { rerender } = render(<ImageViewer input={imageInput(PATH)} source="<svg" />);
    fireEvent.error(image());
    expect(screen.getByText("The SVG source is not valid.")).toBeInTheDocument();
    const fixed = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    rerender(<ImageViewer input={imageInput(PATH)} source={fixed} />);
    expect(image().src).toBe(svgDataUrl(fixed));
    expect(screen.queryByText("The SVG source is not valid.")).toBeNull();
  });

  it("measures a retyped SVG's size from a fresh image, not the sized <img>", () => {
    // WebKit reports the previous natural size on the shown <img>; a detached Image reports the new one.
    const probes: { onload: (() => void) | null; src: string; naturalWidth: number; naturalHeight: number }[] = [];
    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | null = null;
        naturalWidth = 360;
        naturalHeight = 300;
        set src(value: string) {
          this._src = value;
          probes.push(this);
        }
        get src() {
          return this._src;
        }
        _src = "";
      },
    );
    try {
      const source = '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="300"/>';
      render(<ImageViewer input={imageInput(PATH)} source={source} />);
      Object.defineProperty(image(), "naturalWidth", { value: 400 });
      Object.defineProperty(image(), "naturalHeight", { value: 300 });
      fireEvent.load(image());
      expect(probes.map((p) => p.src)).toEqual([svgDataUrl(source)]);
      act(() => probes[0]?.onload?.());
      expect(screen.getByText("360 × 300")).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the SVG layout apart from Markdown's, and the layout actions set the tab's own", async () => {
    const off = activateViewers();
    setContext("textEditorActive", true);
    try {
      render(
        <SvgEditor path={PATH} tabId="svg-tab">
          <div />
        </SvgEditor>,
      );
      setMarkdownMode("md-tab", "preview");
      expect(svgModes.useModes.getState().fallback).toBe("split");

      await act(() => executeAction("markdown.editorOnly", "svg-tab"));
      expect(svgModes.useModes.getState().byTab["svg-tab"]).toBe("editor");
      expect(useMarkdownModes.getState().byTab["md-tab"]).toBe("preview");
      expect(useMarkdownModes.getState().byTab["svg-tab"]).toBeUndefined();
      // The last layout chosen for an SVG is the one the next SVG opens in.
      expect(localStorage.getItem("openidea.svg.defaultMode")).toBe("editor");
    } finally {
      setContext("textEditorActive", false);
      off();
    }
  });
});
