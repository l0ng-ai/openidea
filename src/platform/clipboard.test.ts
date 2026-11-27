import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "./ipc";
import { usePlatform } from "./platformInfo";
import {
  pasteClipboardFiles,
  readClipboardPlainText,
  readClipboardPng,
  readClipboardText,
  writeClipboardPng,
  writeClipboardText,
} from "./clipboard";

beforeEach(() => vi.stubGlobal("__TAURI_INTERNALS__", {}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function transfer(text: string, files = true): DataTransfer {
  return { getData: () => text, files: [], types: files ? ["Files"] : ["text/plain"] } as unknown as DataTransfer;
}

const cases = [
  { name: "text present", text: "plain text", paths: ["/stale"], expected: "plain text", calls: 0 },
  {
    name: "files plus list",
    text: "",
    paths: ["/a b", "/中文", "C:\\folder"],
    expected: "/a b\n/中文\nC:\\folder",
    calls: 1,
  },
  { name: "files without list", text: "", paths: [], expected: "", calls: 1 },
  { name: "backend error", text: "", paths: null, expected: "", calls: 1 },
];

describe("clipboard text", () => {
  it.each(cases)("$name", async ({ text, paths, expected, calls }) => {
    const list = vi.spyOn(commands, "clipboardFileList");
    if (paths) list.mockResolvedValue({ status: "ok", data: paths });
    else list.mockRejectedValue(new Error("busy"));
    expect(await readClipboardText(transfer(text))).toBe(expected);
    expect(list).toHaveBeenCalledTimes(calls);
    list.mockClear();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: async () => text } });
    expect(await readClipboardText()).toBe(expected);
    expect(list).toHaveBeenCalledTimes(calls);
  });

  // WebKit on macOS asks the user to confirm navigator.clipboard reads outside a paste event.
  it("treats no native text on macOS as empty, but falls back when the backend refuses", async () => {
    usePlatform.setState({ os: "macos" });
    const readText = vi.fn(async () => "web");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText } });
    const native = vi.spyOn(commands, "clipboardText").mockResolvedValue({ status: "ok", data: null });
    expect(await readClipboardPlainText()).toBe("");
    expect(readText).not.toHaveBeenCalled();
    native.mockRejectedValue(new Error("restricted"));
    expect(await readClipboardPlainText()).toBe("web");
  });

  it("falls back to the WebView where the backend has no text reader", async () => {
    usePlatform.setState({ os: "windows" });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: async () => "web" } });
    vi.spyOn(commands, "clipboardText").mockResolvedValue({ status: "ok", data: null });
    try {
      expect(await readClipboardPlainText()).toBe("web");
    } finally {
      usePlatform.setState({ os: "macos" });
    }
  });

  it("does not consult files for an empty text-only event or a browser", async () => {
    const list = vi.spyOn(commands, "clipboardFileList");
    expect(await readClipboardText(transfer("", false))).toBe("");
    vi.unstubAllGlobals();
    expect(await readClipboardText(transfer(""))).toBe("");
    expect(list).not.toHaveBeenCalled();
  });

  it("does not intercept text, already handled images, or an absent transfer", () => {
    const paste = vi.fn();
    for (const data of [transfer("text"), null]) {
      const event = new Event("paste", { cancelable: true }) as ClipboardEvent;
      Object.defineProperty(event, "clipboardData", { value: data });
      expect(pasteClipboardFiles(event, paste)).toBe(false);
    }
    const event = new Event("paste", { cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", { value: transfer("") });
    event.preventDefault();
    expect(pasteClipboardFiles(event, paste)).toBe(false);
    expect(paste).not.toHaveBeenCalled();
  });
});

describe("clipboard writes", () => {
  it.each(["com.acme.A#run", "/p/src/A.java:5", "中文\n😀", ""])(
    "writes %j natively without browser activation",
    async (text) => {
      const native = vi.spyOn(commands, "clipboardWriteText").mockResolvedValue({ status: "ok", data: null });
      const browser = vi
        .fn()
        .mockRejectedValue(
          new DOMException(
            "The request is not allowed by the user agent or the platform in the current context",
            "NotAllowedError",
          ),
        );
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: browser } });
      await Promise.resolve();
      await writeClipboardText(text);
      expect(native).toHaveBeenCalledExactlyOnceWith(text);
      expect(browser).not.toHaveBeenCalled();
    },
  );

  it("reports native errors instead of claiming success", async () => {
    vi.spyOn(commands, "clipboardWriteText").mockResolvedValue({
      status: "error",
      error: { kind: "internal", message: "busy", data: null },
    });
    await expect(writeClipboardText("text")).rejects.toThrow("busy");
  });

  it("uses the browser clipboard outside Tauri", async () => {
    vi.unstubAllGlobals();
    const native = vi.spyOn(commands, "clipboardWriteText");
    const browser = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: browser } });
    await writeClipboardText("web preview");
    expect(browser).toHaveBeenCalledExactlyOnceWith("web preview");
    expect(native).not.toHaveBeenCalled();
  });
});

describe("clipboard image", () => {
  it("writes PNG bytes through the native command and reports native errors", async () => {
    const native = vi.spyOn(commands, "clipboardWriteImage").mockResolvedValue({ status: "ok", data: null });
    const blob = { arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer } as Blob;
    await writeClipboardPng(Promise.resolve(blob));
    expect(native).toHaveBeenCalledExactlyOnceWith("iVBORw==");
    native.mockResolvedValueOnce({ status: "error", error: { kind: "internal", message: "busy", data: null } });
    await expect(writeClipboardPng(Promise.resolve(blob))).rejects.toThrow("busy");
  });

  it("starts a browser image write synchronously with a PNG promise, preserving user activation", async () => {
    vi.unstubAllGlobals();
    const native = vi.spyOn(commands, "clipboardWriteImage");
    let finish!: (blob: Blob) => void;
    const blob = new Blob(["png"], { type: "image/png" });
    const pending = new Promise<Blob>((resolve) => {
      finish = resolve;
    });
    const item = vi.fn(function (this: { data: unknown }, data: unknown) {
      this.data = data;
    });
    vi.stubGlobal("ClipboardItem", item);
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write } });
    const result = writeClipboardPng(pending);
    expect(item).toHaveBeenCalledWith({ "image/png": pending });
    expect(write).toHaveBeenCalledOnce();
    finish(blob);
    await result;
    expect(native).not.toHaveBeenCalled();
    write.mockRejectedValueOnce(new Error("denied"));
    await expect(writeClipboardPng(Promise.resolve(blob))).rejects.toThrow("denied");
  });

  it("is the PNG's base64, without the data URL prefix", async () => {
    const image = vi.spyOn(commands, "clipboardImage");
    image.mockResolvedValue({ status: "ok", data: "data:image/png;base64,iVBORw0KGgo=" });
    expect(await readClipboardPng()).toBe("iVBORw0KGgo=");
    image.mockResolvedValue({ status: "ok", data: null });
    expect(await readClipboardPng()).toBeNull();
    image.mockRejectedValue(new Error("busy"));
    await expect(readClipboardPng()).rejects.toThrow("busy");
  });

  it("is none outside the desktop app", async () => {
    vi.unstubAllGlobals();
    const image = vi.spyOn(commands, "clipboardImage");
    expect(await readClipboardPng()).toBeNull();
    expect(image).not.toHaveBeenCalled();
  });
});
