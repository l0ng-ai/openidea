import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "./ipc";
import { pasteClipboardFiles, readClipboardText } from "./clipboard";

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
