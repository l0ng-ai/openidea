import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "@/platform/ipc";
import { usePlatform } from "@/platform/platformInfo";
import { isRemoteWindow } from "@/platform/remote";
import { handleFileDrop } from "@/workbench/fileDrop";
import { droppedPathsText, installTerminalDrop } from "./drop";

vi.mock("@/platform/remote", () => ({ isRemoteWindow: vi.fn(() => false) }));

const initialOs = usePlatform.getState().os;
const originalElementFromPoint = document.elementFromPoint;

beforeEach(() => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  usePlatform.setState({ os: "macos" });
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
});
