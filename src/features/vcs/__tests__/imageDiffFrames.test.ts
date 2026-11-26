import { afterEach, describe, expect, it, vi } from "vitest";
import { loadImageFrames, svgAtViewport, svgIntrinsicSize } from "../imageDiffFrames";
import { readImageSide } from "../imageDiffInput";
import { imageBounds } from "../imagePixels";

vi.mock("../imageDiffInput", () => ({ readImageSide: vi.fn() }));
afterEach(() => vi.resetAllMocks());

function svg(attrs: string) {
  const doc = new DOMParser().parseFromString(
    '<svg xmlns="http://www.w3.org/2000/svg" ' + attrs + '><rect width="1" height="2"/></svg>',
    "image/svg+xml",
  );
  return doc.documentElement as unknown as SVGSVGElement;
}

describe("SVG diff viewport", () => {
  it("resolves absolute units and preserves the viewBox ratio if one side is implicit", () => {
    expect(svgIntrinsicSize(svg('width="1in" viewBox="10 8 12 6"'))).toEqual({ width: 96, height: 48 });
    expect(svgIntrinsicSize(svg('viewBox="10 8 12 6"'))).toEqual({ width: 12, height: 6 });
    expect(svgIntrinsicSize(svg('width="100%" height="100%"'))).toEqual({ width: 300, height: 150 });
  });

  it("sets both layout viewports before rendering and leaves each drawing's own coordinates intact", () => {
    const a = svg('width="12" height="8" viewBox="0 0 6 4" preserveAspectRatio="none"');
    const b = svg('style="width: 16px; height: 3px" viewBox="0 0 6 4" preserveAspectRatio="none"');
    const viewport = imageBounds([svgIntrinsicSize(a), svgIntrinsicSize(b)]);
    for (const revision of [a, b]) {
      const url = svgAtViewport(revision, viewport);
      const rendered = new DOMParser().parseFromString(
        decodeURIComponent(url.split(",")[1]!),
        "image/svg+xml",
      ).documentElement;
      expect(rendered.getAttribute("width")).toBe("16");
      expect(rendered.getAttribute("height")).toBe("8");
      expect(rendered.getAttribute("viewBox")).toBe("0 0 6 4");
      expect(rendered.getAttribute("preserveAspectRatio")).toBe("none");
      expect(rendered.firstElementChild?.getAttribute("width")).toBe("1");
    }
  });

  it("distinguishes missing and invalid images, and discards reads from a superseded comparison", async () => {
    vi.mocked(readImageSide).mockResolvedValueOnce(null).mockResolvedValueOnce("data:image/svg+xml,%3Cbroken");
    const sides = [{ type: "worktree" }, { type: "rev", rev: "HEAD" }] as const;
    const loaded = await loadImageFrames("x.svg", [...sides], () => false);
    expect(loaded.map((s) => s.kind)).toEqual(["absent", "error"]);
    vi.mocked(readImageSide).mockResolvedValue("data:image/svg+xml,%3Cbroken");
    expect(await loadImageFrames("x.svg", [...sides], () => true)).toEqual([]);
  });
});
