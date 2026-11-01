import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { commands } from "@/platform/ipc";
import { installTerminalPaste, pasteTerminalClipboard } from "./paste";

beforeEach(() => vi.stubGlobal("__TAURI_INTERNALS__", {}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

for (const route of ["event", "menu"]) {
  it.each([
    { name: "text present", text: "plain", paths: ["/stale"], expected: "plain", calls: 0 },
    { name: "files plus list", text: "", paths: ["/a b", "/中文"], expected: "/a b\n/中文", calls: 1 },
    { name: "files without list", text: "", paths: [], expected: "", calls: 1 },
    { name: "backend error", text: "", paths: null, expected: "", calls: 1 },
  ])(`${route}: $name`, async ({ text, paths, expected, calls }) => {
    const list = vi.spyOn(commands, "clipboardFileList");
    if (paths) list.mockResolvedValue({ status: "ok", data: paths });
    else list.mockRejectedValue(new Error("busy"));
    const host = document.createElement("div");
    const textarea = document.createElement("textarea");
    host.append(textarea);
    const paste = vi.fn();
    const remove = installTerminalPaste(host, paste);
    // Model xterm's bubble listener: file recovery must preempt its empty paste.
    textarea.addEventListener("paste", (event) =>
      paste((event as ClipboardEvent).clipboardData!.getData("text/plain")),
    );
    if (route === "event") {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { getData: () => text, files: [], types: ["Files"] } });
      textarea.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(!text);
    } else {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: async () => text } });
      await pasteTerminalClipboard(paste);
    }
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(calls));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(paste.mock.calls).toEqual(expected ? [[expected]] : []);
    remove();
  });
}

it("ignores clipboard resolution after the terminal is disposed", async () => {
  let finish!: (value: { status: "ok"; data: string[] }) => void;
  vi.spyOn(commands, "clipboardFileList").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const host = document.createElement("div");
  const paste = vi.fn();
  const remove = installTerminalPaste(host, paste);
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: () => "", files: [], types: ["Files"] } });
  host.dispatchEvent(event);
  remove();
  finish({ status: "ok", data: ["/late"] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(paste).not.toHaveBeenCalled();
});

it("passes recovered multiline paths through xterm bracketed paste", async () => {
  vi.spyOn(commands, "clipboardFileList").mockResolvedValue({ status: "ok", data: ["/a b", "/中文"] });
  const term = new Terminal({ allowProposedApi: true });
  const data: string[] = [];
  term.onData((text) => data.push(text));
  try {
    await new Promise<void>((resolve) => term.write("\x1b[?2004h", resolve));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: async () => "" } });
    await pasteTerminalClipboard((text) => term.paste(text));
    expect(data).toEqual(["\x1b[200~/a b\r/中文\x1b[201~"]);
  } finally {
    term.dispose();
  }
});
