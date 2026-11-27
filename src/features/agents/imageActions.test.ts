import { afterEach, expect, it, vi } from "vitest";
import { copyImageAction, imagePng } from "./imageActions";

const mocks = vi.hoisted(() => ({ write: vi.fn().mockResolvedValue(undefined), notify: vi.fn() }));
vi.mock("@/platform/clipboard", () => ({ writeClipboardPng: mocks.write }));
vi.mock("@/workbench/contributions", () => ({ notifications: () => ({ notify: mocks.notify }) }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
const image = { mimeType: "image/png", data: "iVBORw0KGgo=", name: "preview.png" };

it("keeps original PNG bytes rather than copying the data URL or thumbnail", async () => {
  const blob = await imagePng(image);
  expect(blob.type).toBe("image/png");
  const bytes = await new Promise<ArrayBuffer>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(blob);
  });
  expect([...new Uint8Array(bytes)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
});

it("converts non-PNG images at their natural size and rejects conversion failures", async () => {
  class LoadedImage {
    naturalWidth = 320;
    naturalHeight = 120;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal("Image", LoadedImage);
  const draw = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: draw,
  } as unknown as CanvasRenderingContext2D);
  const png = new Blob(["converted"], { type: "image/png" });
  const encode = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
    this: HTMLCanvasElement,
    callback,
  ) {
    expect([this.width, this.height]).toEqual([320, 120]);
    callback(png);
  });
  const jpeg = { ...image, mimeType: "image/jpeg", data: "/9j/" };
  expect(await imagePng(jpeg)).toBe(png);
  expect(draw).toHaveBeenCalledWith(expect.any(LoadedImage), 0, 0);
  encode.mockImplementationOnce((callback) => callback(null));
  await expect(imagePng(jpeg)).rejects.toThrow("Cannot convert image to PNG");
});

it("reports copy failures without success feedback and allows retry", async () => {
  const onCopied = vi.fn();
  const run = () => copyImageAction.run({ ctx: {}, arg: { image, onCopied } });
  mocks.write.mockRejectedValueOnce(new Error("clipboard busy"));
  await run();
  expect(onCopied).not.toHaveBeenCalled();
  expect(mocks.notify).toHaveBeenCalledWith(
    expect.objectContaining({ level: "error", title: "Couldn't copy the image" }),
  );
  await run();
  expect(onCopied).toHaveBeenCalledOnce();
});
