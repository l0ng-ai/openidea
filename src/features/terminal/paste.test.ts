import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { commands } from "@/platform/ipc";
import { installTerminalPaste, pasteTerminalClipboard, type RemotePasteTarget } from "./paste";

const notify = vi.hoisted(() => vi.fn());
vi.mock("@/workbench/contributions", () => ({ notifications: () => ({ notify }) }));

beforeEach(() => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  vi.spyOn(commands, "clipboardFileList").mockResolvedValue({ status: "ok", data: [] });
  notify.mockClear();
});
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

function image(buffer: () => Promise<ArrayBuffer> = async () => new Uint8Array([1, 2]).buffer, size = 2): Blob {
  return { type: "image/png", size, arrayBuffer: buffer } as Blob;
}

function imageEvent(blob: Blob, text = "") {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: () => text, files: [blob], types: ["Files"] },
  });
  return event;
}

function remoteTarget(current = () => true): RemotePasteTarget {
  return { id: 42 as RemotePasteTarget["id"], supported: true, current };
}

it.each(["event", "menu"])("rejects oversized %s images before reading or uploading", async (route) => {
  const read = vi.fn(async () => new ArrayBuffer(0));
  const blob = image(read, 20 * 1024 * 1024 + 1);
  const store = vi.spyOn(commands, "termStoreImage");
  const paste = vi.fn();
  const host = document.createElement("div");
  const remove = installTerminalPaste(host, paste, () => remoteTarget());
  if (route === "event") {
    const event = imageEvent(blob);
    host.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  } else {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: async () => "", read: async () => [{ types: ["image/png"], getType: async () => blob }] },
    });
    await pasteTerminalClipboard(paste, () => remoteTarget());
  }
  await vi.waitFor(() =>
    expect(notify).toHaveBeenCalledWith({
      level: "error",
      title: "Cannot paste image",
      body: "Error: Image is too large to paste (limit 20 MB).",
    }),
  );
  expect(read).not.toHaveBeenCalled();
  expect(store).not.toHaveBeenCalled();
  expect(paste).not.toHaveBeenCalled();
  remove();
});

it("allows images at the size limit", async () => {
  const store = vi.spyOn(commands, "termStoreImage").mockResolvedValue({ status: "ok", data: "/remote/image.png" });
  const host = document.createElement("div");
  const paste = vi.fn();
  const remove = installTerminalPaste(host, paste, () => remoteTarget());
  host.dispatchEvent(imageEvent(image(undefined, 20 * 1024 * 1024)));
  await vi.waitFor(() => expect(paste).toHaveBeenCalledWith("'/remote/image.png'"));
  expect(store).toHaveBeenCalledWith(42, [1, 2], "image/png");
  expect(notify).not.toHaveBeenCalled();
  remove();
});

it("claims remote image events before xterm and pastes a quoted path only after upload", async () => {
  let finish!: (result: { status: "ok"; data: string }) => void;
  const store = vi.spyOn(commands, "termStoreImage").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const host = document.createElement("div");
  const paste = vi.fn();
  const remove = installTerminalPaste(host, paste, () => remoteTarget());
  host.addEventListener("paste", () => paste("xterm"));
  const event = imageEvent(image());
  host.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(store).toHaveBeenCalledWith(42, [1, 2], "image/png"));
  expect(paste).not.toHaveBeenCalled();
  finish({ status: "ok", data: "/tmp/a'b c.png" });
  await vi.waitFor(() => expect(paste).toHaveBeenCalledWith("'/tmp/a'\\''b c.png'"));
  remove();
});

it("reads an image from the explicit paste menu after text and file recovery", async () => {
  vi.spyOn(commands, "clipboardFileList").mockResolvedValue({ status: "ok", data: ["/local/stale.png"] });
  const store = vi.spyOn(commands, "termStoreImage").mockResolvedValue({ status: "ok", data: "/remote/image.png" });
  const getType = vi.fn(async () => image());
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { readText: async () => "", read: async () => [{ types: ["image/png"], getType }] },
  });
  const paste = vi.fn();
  await pasteTerminalClipboard(paste, () => remoteTarget());
  expect(getType).toHaveBeenCalledWith("image/png");
  expect(store).toHaveBeenCalledWith(42, [1, 2], "image/png");
  expect(paste).toHaveBeenCalledWith("'/remote/image.png'");
});

it("recovers remote menu file paths when image clipboard reading is unavailable", async () => {
  vi.spyOn(commands, "clipboardFileList").mockResolvedValue({ status: "ok", data: ["/local/file.txt"] });
  const store = vi.spyOn(commands, "termStoreImage");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: async () => "" } });
  const paste = vi.fn();
  await pasteTerminalClipboard(paste, () => remoteTarget());
  expect(paste).toHaveBeenCalledWith("/local/file.txt");
  expect(store).not.toHaveBeenCalled();
});

it("uploads a menu image even if reading clipboard text is rejected", async () => {
  const store = vi.spyOn(commands, "termStoreImage").mockResolvedValue({ status: "ok", data: "/remote/image.png" });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      readText: async () => {
        throw new Error("no text");
      },
      read: async () => [{ types: ["image/png"], getType: async () => image() }],
    },
  });
  const paste = vi.fn();
  await pasteTerminalClipboard(paste, () => remoteTarget());
  expect(store).toHaveBeenCalledWith(42, [1, 2], "image/png");
  expect(paste).toHaveBeenCalledWith("'/remote/image.png'");
  expect(notify).not.toHaveBeenCalled();
});

it("uploads image events instead of recovering a local image path", async () => {
  const list = vi.spyOn(commands, "clipboardFileList").mockResolvedValue({ status: "ok", data: ["/local/photo.png"] });
  const store = vi.spyOn(commands, "termStoreImage").mockResolvedValue({ status: "ok", data: "/remote/photo.png" });
  const host = document.createElement("div");
  const paste = vi.fn();
  const remove = installTerminalPaste(host, paste, () => remoteTarget());
  const event = imageEvent(image());
  host.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(paste).toHaveBeenCalledWith("'/remote/photo.png'"));
  expect(store).toHaveBeenCalledWith(42, [1, 2], "image/png");
  expect(list).not.toHaveBeenCalled();
  remove();
});

it("does not upload a menu image when the target changes while reading", async () => {
  let valid = true;
  let finish!: (value: Blob) => void;
  const getType = vi.fn(
    () =>
      new Promise<Blob>((resolve) => {
        finish = resolve;
      }),
  );
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { readText: async () => "", read: async () => [{ types: ["image/png"], getType }] },
  });
  const store = vi.spyOn(commands, "termStoreImage");
  const paste = vi.fn();
  const pending = pasteTerminalClipboard(paste, () => remoteTarget(() => valid));
  await vi.waitFor(() => expect(getType).toHaveBeenCalled());
  valid = false;
  finish(image());
  await pending;
  expect(store).not.toHaveBeenCalled();
  expect(paste).not.toHaveBeenCalled();
});

it.each(["read", "upload", "unsupported"])("reports image %s failure without pasting", async (failure) => {
  const store = vi.spyOn(commands, "termStoreImage").mockRejectedValue(new Error("upload failed"));
  const host = document.createElement("div");
  const paste = vi.fn();
  const remove = installTerminalPaste(host, paste, () => ({ ...remoteTarget(), supported: failure !== "unsupported" }));
  host.dispatchEvent(
    imageEvent(
      image(
        failure === "read"
          ? async () => {
              throw new Error("read failed");
            }
          : undefined,
      ),
    ),
  );
  await vi.waitFor(() => expect(notify).toHaveBeenCalled());
  expect(paste).not.toHaveBeenCalled();
  if (failure !== "upload") expect(store).not.toHaveBeenCalled();
  remove();
});

it.each(["read", "upload"])("ignores an image after its target is replaced during %s", async (stage) => {
  let valid = true;
  let finishRead!: (value: ArrayBuffer) => void;
  let finishUpload!: (value: { status: "ok"; data: string }) => void;
  const store = vi.spyOn(commands, "termStoreImage").mockImplementation(
    () =>
      new Promise((resolve) => {
        finishUpload = resolve;
      }),
  );
  const host = document.createElement("div");
  const paste = vi.fn();
  const remove = installTerminalPaste(host, paste, () => remoteTarget(() => valid));
  host.dispatchEvent(
    imageEvent(
      image(
        () =>
          new Promise((resolve) => {
            finishRead = resolve;
          }),
      ),
    ),
  );
  await vi.waitFor(() => expect(finishRead).toBeDefined());
  if (stage === "upload") {
    finishRead(new Uint8Array([1]).buffer);
    await vi.waitFor(() => expect(store).toHaveBeenCalled());
  }
  valid = false;
  if (stage === "read") finishRead(new Uint8Array([1]).buffer);
  else finishUpload({ status: "ok", data: "/remote/image.png" });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(paste).not.toHaveBeenCalled();
  if (stage === "read") expect(store).not.toHaveBeenCalled();
  remove();
});

it("does not paste after the event handler is disposed during upload", async () => {
  let finish!: (value: { status: "ok"; data: string }) => void;
  const store = vi.spyOn(commands, "termStoreImage").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const host = document.createElement("div");
  const paste = vi.fn();
  const remove = installTerminalPaste(host, paste, () => remoteTarget());
  host.dispatchEvent(imageEvent(image()));
  await vi.waitFor(() => expect(store).toHaveBeenCalled());
  remove();
  finish({ status: "ok", data: "/remote/image.png" });
  await Promise.resolve();
  await Promise.resolve();
  expect(paste).not.toHaveBeenCalled();
});

it("keeps local image-only file recovery unchanged", async () => {
  const list = vi.spyOn(commands, "clipboardFileList").mockResolvedValue({ status: "ok", data: ["/local/photo.png"] });
  const store = vi.spyOn(commands, "termStoreImage");
  const host = document.createElement("div");
  const paste = vi.fn();
  const remove = installTerminalPaste(host, paste);
  const event = imageEvent(image());
  host.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(paste).toHaveBeenCalledWith("/local/photo.png"));
  expect(list).toHaveBeenCalled();
  expect(store).not.toHaveBeenCalled();
  remove();
});

it("leaves local image and remote text events to existing paste handlers", () => {
  const store = vi.spyOn(commands, "termStoreImage");
  const host = document.createElement("div");
  const paste = vi.fn();
  const remove = installTerminalPaste(host, paste, () => remoteTarget());
  const event = imageEvent(image(), "plain");
  host.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(store).not.toHaveBeenCalled();
  remove();
  const local = installTerminalPaste(host, paste);
  const text = imageEvent(image(), "plain");
  host.dispatchEvent(text);
  expect(text.defaultPrevented).toBe(false);
  expect(store).not.toHaveBeenCalled();
  local();
});
