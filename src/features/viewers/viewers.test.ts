import { describe, expect, it } from "vitest";
import { binaryInput, formatSize, imageInput, isImagePath, isMarkdownPath, isSvgPath, wantsHexView } from "./fileKinds";
import {
  BYTES_PER_ROW,
  MAX_SCROLL_PX,
  PAGE_SIZE,
  asciiChar,
  decodeBase64,
  formatOffset,
  hexViewport,
  offsetDigits,
  pagesForRows,
  rowBytes,
  rowCount,
  scrollTopForRow,
} from "./hex";
import { fitZoom, initialZoom, stepZoom, zoomAt, zoomLabel } from "./imageZoom";

describe("file kinds", () => {
  it("routes by extension", () => {
    expect(isImagePath("/p/a.PNG")).toBe(true);
    expect(isImagePath("/p/icon.svg")).toBe(true);
    expect(isImagePath("/p/png")).toBe(false);
    expect(isImagePath("/p/.png")).toBe(false);
    expect(isSvgPath("/p/x.svg")).toBe(true);
    expect(isMarkdownPath("/p/README.md")).toBe(true);
    expect(isMarkdownPath("/p/notes.txt")).toBe(false);
  });

  it("builds viewer inputs keyed apart from text tabs", () => {
    expect(imageInput("/a/b.png")).toEqual({ kind: "image", key: "image:/a/b.png", path: "/a/b.png" });
    const input = binaryInput("/a/b.bin", { size: 10, binary: true, tooLarge: false });
    expect(input.key).toBe("binary:/a/b.bin");
    expect(input.data).toEqual({ size: 10, binary: true });
  });

  it("uses the hex view for binary or huge files", () => {
    expect(wantsHexView({ size: 1, binary: true, tooLarge: false })).toBe(true);
    expect(wantsHexView({ size: 1, binary: false, tooLarge: true })).toBe(true);
    expect(wantsHexView({ size: 1, binary: false, tooLarge: false })).toBe(false);
  });

  it("formats sizes", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(300 * 1024 * 1024)).toBe("300 MB");
  });
});

describe("hex model", () => {
  it("decodes base64 and formats bytes", () => {
    expect([...decodeBase64("AAH/")]).toEqual([0, 1, 255]);
    expect(formatOffset(255, 8)).toBe("000000FF");
    expect(offsetDigits(16)).toBe(8);
    expect(offsetDigits(2 ** 36)).toBe(9);
    expect(asciiChar(0x41)).toBe("A");
    expect(asciiChar(0)).toBe(".");
    expect(asciiChar(0x7f)).toBe(".");
  });

  it("slices rows out of loaded pages", () => {
    const total = PAGE_SIZE + 20;
    const pages = new Map([[0, new Uint8Array(PAGE_SIZE).map((_, i) => i % 256)]]);
    expect(rowCount(total)).toBe(PAGE_SIZE / BYTES_PER_ROW + 2);
    expect([...rowBytes(pages, 1, total)!]).toEqual([16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]);
    expect(rowBytes(pages, PAGE_SIZE / BYTES_PER_ROW, total)).toBeNull();
    pages.set(1, new Uint8Array(20).fill(7));
    expect(rowBytes(pages, PAGE_SIZE / BYTES_PER_ROW + 1, total)!.length).toBe(4);
    expect(pagesForRows(0, PAGE_SIZE / BYTES_PER_ROW)).toEqual([0, 1]);
  });

  it("maps a capped scroll range onto all rows", () => {
    const rows = 50_000_000;
    const top = hexViewport(0, 400, rows, 20);
    expect(top).toEqual({ spacer: MAX_SCROLL_PX, first: 0, shift: 0 });
    const end = hexViewport(MAX_SCROLL_PX - 400, 400, rows, 20);
    expect(end.first).toBe(rows - 20);
    const st = scrollTopForRow(rows / 2, 400, rows, 20);
    expect(Math.abs(hexViewport(st, 400, rows, 20).first - rows / 2)).toBeLessThanOrEqual(1);
    // Small files scroll 1:1.
    expect(hexViewport(45, 400, 100, 20)).toEqual({ spacer: 2000, first: 2, shift: 5 });
  });
});

describe("image zoom", () => {
  it("steps through 100%", () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(0.9, 1)).toBe(1);
    expect(stepZoom(1.1, -1)).toBe(1);
    expect(stepZoom(64, 1)).toBe(64);
  });

  it("fits and starts at actual size when possible", () => {
    expect(fitZoom(200, 100, 100, 100)).toBe(0.5);
    expect(initialZoom(50, 50, 100, 100)).toBe(1);
    expect(initialZoom(400, 100, 100, 100)).toBe(0.25);
    expect(zoomLabel(0.333)).toBe("33%");
  });

  it("keeps the point under the cursor fixed when zooming", () => {
    const v = { z: 1, x: 10, y: 20 };
    const next = zoomAt(v, 2, 110, 70);
    // Image point under (110, 70) before: ((110-10)/1, (70-20)/1) = (100, 50).
    expect(next).toEqual({ z: 2, x: -90, y: -30 });
    expect(next.x + 100 * next.z).toBe(110);
    expect(next.y + 50 * next.z).toBe(70);
  });
});
