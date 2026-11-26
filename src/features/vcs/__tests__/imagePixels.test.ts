import { describe, expect, it } from "vitest";
import { canComparePixels, imageBounds, paintPixelDifference, type PixelImage } from "../imagePixels";

function pixels(width: number, height: number, rgba?: number[]): PixelImage {
  const data = new Uint8ClampedArray(width * height * 4);
  if (rgba) data.set(rgba);
  return { width, height, data };
}

describe("image pixel differences", () => {
  it("compares decoded RGBA, including a one-step opacity change", () => {
    const before = pixels(2, 1, [10, 40, 80, 255, 13, 13, 13, 250]);
    const after = pixels(2, 1, [...before.data]);
    const mask = pixels(2, 1);
    expect(paintPixelDifference(before, after, mask)).toBe(0);
    expect(mask.data[0]).toBe(mask.data[1]);
    expect(mask.data[1]).toBe(mask.data[2]);
    expect(mask.data[3]).toBe(255);
    expect(mask.data[7]).toBe(250);
    after.data[7] = 249;
    expect(paintPixelDifference(before, after, mask)).toBe(1);
    expect(mask.data[7]).toBe(255);
    after.data[0] = 11;
    expect(paintPixelDifference(before, after, mask)).toBe(2);
  });

  it("keeps a crop at its original coordinates and counts transparent edge pixels", () => {
    const before = pixels(3, 2);
    const after = pixels(2, 2);
    const mask = pixels(3, 2);
    expect(paintPixelDifference(before, after, mask)).toBe(2);
    expect([...mask.data].filter((_, i) => i % 4 === 3)).toEqual([0, 0, 255, 0, 0, 255]);
  });

  it("excludes the corner outside both images and handles an absent side", () => {
    const wide = pixels(3, 1);
    const tall = pixels(1, 2);
    const mask = pixels(3, 2);
    expect(paintPixelDifference(wide, tall, mask)).toBe(3);
    expect([...mask.data].filter((_, i) => i % 4 === 3)).toEqual([0, 255, 255, 255, 0, 0]);
    expect(paintPixelDifference(null, wide, pixels(3, 1))).toBe(3);
    expect(paintPixelDifference(tall, null, pixels(1, 2))).toBe(2);
  });

  it("uses one enclosing viewport regardless of revision order and bounds allocations", () => {
    const a = { width: 8000, height: 20 };
    const b = { width: 13, height: 7000 };
    expect(imageBounds([a, b])).toEqual({ width: 8000, height: 7000 });
    expect(imageBounds([a, b])).toEqual(imageBounds([b, a]));
    expect(canComparePixels(a)).toBe(true);
    expect(canComparePixels(imageBounds([a, b]))).toBe(false);
    expect(canComparePixels({ width: 16385, height: 1 })).toBe(false);
    expect(canComparePixels(imageBounds([]))).toBe(false);
  });
});
