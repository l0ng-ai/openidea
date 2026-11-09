import { useProject } from "@/platform/project";
import { workflowSettings } from "@/platform/workflowSettings";
import { getSession, newTab, splitTab, syncTerminalProject, unbindTerminals, useTerminals } from "./store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIT_SETTLE_MS } from "./fit";
import { findTerminalLinks, type TerminalLink } from "./links";
import { openFileLink, resolveStartCwd, TerminalSession } from "./session";
import { usePlatform } from "@/platform/platformInfo";

const ipc = vi.hoisted(() => ({
  call: vi.fn(async (v: unknown) => v),
  commands: {
    fsReadDir: vi.fn(),
    fsEntryKind: vi.fn(),
    findFiles: vi.fn(),
    termSpawn: vi.fn(),
    termKill: vi.fn(),
    termResize: vi.fn(),
    termIsBusy: vi.fn(),
    termWrite: vi.fn(),
  },
}));
const workbench = vi.hoisted(() => ({
  openFile: vi.fn(async () => undefined),
  notify: vi.fn(),
}));

vi.mock("@/platform/ipc", () => ({ call: ipc.call, commands: ipc.commands, isTauri: () => true }));
vi.mock("@/workbench/contributions", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  editorService: () => ({ openFile: workbench.openFile }),
  notifications: () => ({ notify: workbench.notify }),
  OWNS_FILE_DROP: { "data-owner": true },
}));
// `Channel` needs the Tauri runtime; a start() test only hands it to the mocked spawn call.
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Channel: class {
    onmessage: ((chunk: string) => void) | null = null;
  },
}));

const fileLink = (text: string): Extract<TerminalLink, { kind: "file" }> => {
  const [l] = findTerminalLinks(text);
  if (!l || l.kind !== "file") throw new Error(`not a file link: ${text}`);
  return l;
};

describe("Windows PTY metadata", () => {
  const initialPlatform = usePlatform.getState();
  afterEach(() => usePlatform.setState(initialPlatform));

  it.each([
    ["windows", 19045, { backend: "conpty", buildNumber: 19045 }],
    ["windows", 22631, { backend: "conpty", buildNumber: 22631 }],
    ["windows", null, { backend: "conpty", buildNumber: undefined }],
    ["macos", null, {}],
    ["linux", null, {}],
  ] as const)("configures %s build %s", (os, windowsBuildNumber, expected) => {
    usePlatform.setState({ os, windowsBuildNumber });
    const session = new TerminalSession({ key: "pty-options", cwd: "/repo", onChange() {}, onFocus() {} });
    try {
      expect(session.term.options.windowsPty).toEqual(expected);
    } finally {
      session.dispose();
    }
  });

  it("updates a restored terminal when platform info arrives and unsubscribes on disposal", () => {
    usePlatform.setState({ os: "windows", windowsBuildNumber: null });
    const session = new TerminalSession({ key: "restored", cwd: "/repo", onChange() {}, onFocus() {} });
    usePlatform.setState({ windowsBuildNumber: 22631 });
    expect(session.term.options.windowsPty).toEqual({ backend: "conpty", buildNumber: 22631 });
    session.dispose();
    usePlatform.setState({ windowsBuildNumber: 19045 });
    expect(session.term.options.windowsPty).toEqual({ backend: "conpty", buildNumber: 22631 });
  });
});

describe("openFileLink", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens the resolved path when the directory lists it", async () => {
    ipc.commands.fsReadDir.mockResolvedValue([{ name: "main.php", kind: "file" }]);
    await openFileLink(fileLink("a/main.php:2"), "C:\\Users\\me\\proj");
    expect(ipc.commands.fsReadDir).toHaveBeenCalledWith("C:/Users/me/proj/a");
    expect(workbench.openFile).toHaveBeenCalledWith("C:/Users/me/proj/a/main.php", {
      selection: { line: 1, col: 0 },
      focus: true,
    });
    expect(ipc.commands.findFiles).not.toHaveBeenCalled();
  });

  it("ranks the link's directory over the bare name in the project-wide fallback (#705)", async () => {
    ipc.commands.fsReadDir.mockResolvedValue([]);
    ipc.commands.findFiles.mockImplementation(async (q: string) =>
      q === "a/main.php"
        ? [
            { path: "/p/b/main.php", relPath: "b/main.php" },
            { path: "/p/a/main.php", relPath: "a/main.php" },
          ]
        : [{ path: "/p/c/main.php", relPath: "c/main.php" }],
    );
    await openFileLink(fileLink("a/main.php:2"), "/p");
    expect(ipc.commands.findFiles).toHaveBeenCalledWith("a/main.php", 5);
    expect(workbench.openFile).toHaveBeenCalledWith("/p/a/main.php", {
      selection: { line: 1, col: 0 },
      focus: true,
    });
  });

  it("falls back to the bare name for a basename-only link", async () => {
    ipc.commands.fsReadDir.mockResolvedValue([]);
    ipc.commands.findFiles.mockResolvedValue([{ path: "/p/x/main.php", relPath: "x/main.php" }]);
    await openFileLink(fileLink("main.php:1"), "/p");
    expect(ipc.commands.findFiles).toHaveBeenCalledTimes(1);
    expect(workbench.openFile).toHaveBeenCalledWith("/p/x/main.php", { selection: { line: 0, col: 0 }, focus: true });
  });

  it("warns when nothing matches", async () => {
    ipc.commands.fsReadDir.mockResolvedValue([]);
    ipc.commands.findFiles.mockResolvedValue([]);
    await openFileLink(fileLink("gone.php:1"), "/p");
    expect(workbench.openFile).not.toHaveBeenCalled();
    expect(workbench.notify).toHaveBeenCalledWith({ level: "warning", title: "File not found", body: "gone.php" });
  });
});

describe("resolveStartCwd", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps a saved directory that still exists", async () => {
    ipc.commands.fsEntryKind.mockResolvedValue("dir");
    await expect(resolveStartCwd("/repo/logs", "/repo")).resolves.toBe("/repo/logs");
    expect(ipc.commands.fsEntryKind).toHaveBeenCalledWith("/repo/logs");
  });

  it("falls back to the project root when the saved directory is gone", async () => {
    ipc.commands.fsEntryKind.mockRejectedValue(new Error("not found"));
    await expect(resolveStartCwd("/repo/logs", "/repo")).resolves.toBe("/repo");
  });

  it("falls back when the saved path is a file rather than a directory", async () => {
    ipc.commands.fsEntryKind.mockResolvedValue("file");
    await expect(resolveStartCwd("/repo/logs", "/repo")).resolves.toBe("/repo");
  });

  it("does not touch the file system without a fallback or when the paths match", async () => {
    await expect(resolveStartCwd("/repo", "/repo")).resolves.toBe("/repo");
    await expect(resolveStartCwd("/anywhere", undefined)).resolves.toBe("/anywhere");
    expect(ipc.commands.fsEntryKind).not.toHaveBeenCalled();
  });
});

describe("terminal start directory fallback", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows rejected terminal input instead of silently discarding it", async () => {
    ipc.commands.termSpawn.mockResolvedValue({ id: 9, title: "zsh" });
    ipc.commands.termWrite.mockRejectedValueOnce(new Error("input queue full"));
    const session = new TerminalSession({
      key: "s-input-error",
      cwd: "/repo",
      onChange: () => undefined,
      onFocus: () => undefined,
    });
    await session.start();
    session.input("paste");
    await vi.waitFor(() =>
      expect(workbench.notify).toHaveBeenCalledWith({
        level: "error",
        title: "Cannot write to terminal",
        body: "input queue full",
      }),
    );
    session.dispose();
  });

  it("spawns a restored session in the project root when its saved directory is gone", async () => {
    ipc.commands.fsEntryKind.mockRejectedValue(new Error("gone"));
    ipc.commands.termSpawn.mockResolvedValue({ id: 7, title: "zsh" });
    const session = new TerminalSession({
      key: "s-fallback",
      cwd: "/repo/gone",
      fallbackRoot: "/repo",
      onChange: () => undefined,
      onFocus: () => undefined,
    });
    await session.start();
    expect(ipc.commands.termSpawn).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo" }), expect.anything());
    expect(session.state.cwd).toBe("/repo");
    expect(session.state.status).toBe("running");
    session.dispose();
    expect(ipc.commands.termKill).toHaveBeenCalledWith(7);
  });

  it("keeps spawning in a saved directory that still exists", async () => {
    ipc.commands.fsEntryKind.mockResolvedValue("dir");
    ipc.commands.termSpawn.mockResolvedValue({ id: 8, title: "zsh" });
    const session = new TerminalSession({
      key: "s-kept",
      cwd: "/repo/logs",
      fallbackRoot: "/repo",
      onChange: () => undefined,
      onFocus: () => undefined,
    });
    await session.start();
    expect(ipc.commands.termSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/repo/logs" }),
      expect.anything(),
    );
    expect(session.state.cwd).toBe("/repo/logs");
    session.dispose();
  });
});

describe("terminal restart", () => {
  beforeEach(() => vi.clearAllMocks());

  it("restarts a session that failed to start on Shift+Enter's Esc+Return as on Enter", async () => {
    ipc.commands.fsEntryKind.mockResolvedValue("dir");
    ipc.commands.termSpawn.mockRejectedValueOnce(new Error("no shell")).mockRejectedValueOnce(new Error("no shell"));
    const session = new TerminalSession({
      key: "s-restart",
      cwd: "/repo",
      onChange: () => undefined,
      onFocus: () => undefined,
    });
    await session.start();
    expect(session.state.status).toBe("error");
    session.send("\x1b");
    expect(session.state.status).toBe("error");
    session.send("\x1b\r");
    await vi.waitFor(() => expect(ipc.commands.termSpawn).toHaveBeenCalledTimes(2));
    session.dispose();
  });
});

describe("terminal open", () => {
  afterEach(() => vi.useRealTimers());

  it("waits to open xterm until the pane has a size", () => {
    vi.useFakeTimers();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const session = new TerminalSession({
      key: "s-open",
      cwd: "/tmp",
      onChange: () => undefined,
      onFocus: () => undefined,
    });
    let width = 0;
    let height = 0;
    Object.defineProperty(session.host, "offsetWidth", { configurable: true, get: () => width });
    Object.defineProperty(session.host, "offsetHeight", { configurable: true, get: () => height });
    // jsdom has no canvas, so xterm's real open() cannot build a renderer.
    const open = vi.spyOn(session.term, "open").mockImplementation(() => undefined);
    session.attach(container);
    session.focus();
    vi.advanceTimersToNextFrame();
    expect(open).not.toHaveBeenCalled();

    width = 400;
    height = 300;
    vi.advanceTimersByTime(FIT_SETTLE_MS);
    expect(open).toHaveBeenCalledTimes(1);
    session.dispose();
    container.remove();
  });
});

describe("terminal font zoom", () => {
  afterEach(() => {
    unbindTerminals();
    localStorage.clear();
    useProject.setState({ settings: null });
  });

  it("keeps the offset through settings, refit and moving splits; fresh splits and restores start at the base", () => {
    const settings = (fontSize: number) => {
      useProject.setState({ settings: { terminal: { useEditorFont: false, fontSize } } } as never);
      for (const tab of useTerminals.getState().tabs)
        getSession(tab.session)?.applySettings(workflowSettings().terminal);
    };
    settings(14);
    syncTerminalProject("/font-zoom");
    const a = newTab("/font-zoom");
    const first = getSession(a.session)!;
    const b = newTab("/font-zoom");
    const second = getSession(b.session)!;
    first.stepFontSize(2);
    expect(first.term.options.fontSize).toBe(16);
    expect(second.term.options.fontSize).toBe(14);
    settings(18);
    expect(first.term.options.fontSize).toBe(20);
    first.refit();
    expect(first.term.options.fontSize).toBe(20);
    splitTab(a.id, "horizontal", true);
    expect(getSession(a.session)).toBe(first);
    expect(first.term.options.fontSize).toBe(20);
    const split = splitTab(a.id, "vertical")!;
    const splitTabInfo = useTerminals.getState().tabs.find((t) => t.id === split)!;
    expect(getSession(splitTabInfo.session)!.term.options.fontSize).toBe(18);
    first.stepFontSize(0);
    expect(first.term.options.fontSize).toBe(18);
    second.stepFontSize(3);
    expect(second.term.options.fontSize).toBe(21);
    expect(first.term.options.fontSize).toBe(18);
    syncTerminalProject(null);
    syncTerminalProject("/font-zoom");
    for (const tab of useTerminals.getState().tabs) expect(getSession(tab.session)!.term.options.fontSize).toBe(18);
  });
});
