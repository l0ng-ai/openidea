import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIT_INTERVAL_MS } from "./fit";
import { findTerminalLinks, type TerminalLink } from "./links";
import { openFileLink, TerminalSession } from "./session";

const ipc = vi.hoisted(() => ({
  call: vi.fn(async (v: unknown) => v),
  commands: { fsReadDir: vi.fn(), findFiles: vi.fn() },
}));
const workbench = vi.hoisted(() => ({
  openFile: vi.fn(async () => undefined),
  notify: vi.fn(),
}));

vi.mock("@/platform/ipc", () => ({ call: ipc.call, commands: ipc.commands, isTauri: () => true }));
vi.mock("@/workbench/contributions", () => ({
  editorService: () => ({ openFile: workbench.openFile }),
  notifications: () => ({ notify: workbench.notify }),
  OWNS_FILE_DROP: { "data-owner": true },
}));

const fileLink = (text: string): Extract<TerminalLink, { kind: "file" }> => {
  const [l] = findTerminalLinks(text);
  if (!l || l.kind !== "file") throw new Error(`not a file link: ${text}`);
  return l;
};

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
    vi.advanceTimersByTime(FIT_INTERVAL_MS);
    expect(open).toHaveBeenCalledTimes(1);
    session.dispose();
    container.remove();
  });
});
