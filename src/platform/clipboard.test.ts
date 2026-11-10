import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "./ipc";
import { pasteClipboardFiles, readClipboardText, writeClipboardText } from "./clipboard";

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
