/**
 * Terminal editor tabs (#2202): input data validation, Move to Editor and the
 * Start flow of a restored tab through the terminal runtime.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLI_KIND, cliData, cliInput, moveTerminalToEditor, splitCliTab, startTab } from "./cli";

const tabs = vi.hoisted(() => ({
  state: {
    tabs: [] as { id: string; name?: string; session: string }[],
    activeTab: null as string | null,
    sessions: {} as Record<string, unknown>,
  },
}));
const runtime = vi.hoisted(() => ({
  loaded: false,
  startCli: vi.fn(),
  adoptCli: vi.fn(),
  cliSession: vi.fn(),
  detachTab: vi.fn(),
  nextTabName: vi.fn((existing: readonly string[], base = "Local") => (existing.includes(base) ? `${base} (2)` : base)),
  startDirectory: vi.fn((root: string) => root),
  tabTitle: vi.fn((_tab: unknown, _sessions: unknown) => "Local (2)"),
  useTerminals: { getState: () => tabs.state },
}));
const editor = vi.hoisted(() => ({
  openInput: vi.fn(async (_input?: unknown, _options?: unknown) => undefined),
  openTabs: vi.fn(() => [] as { input: { kind: string; key: string; data?: unknown }; title: string }[]),
}));
const toolWindows = vi.hoisted(() => ({ hide: vi.fn() }));

vi.mock("./loader", () => ({
  loadTerminalRuntime: async () => runtime,
  terminalRuntime: () => (runtime.loaded ? runtime : null),
}));
vi.mock("@/workbench/contributions", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  editorService: () => editor,
  toolWindowService: () => toolWindows,
}));

import { useProject } from "@/platform/project";

beforeEach(() => {
  runtime.loaded = true;
  useProject.setState({ project: { root: "/repo" } as never });
});
afterEach(() => {
  useProject.setState({ project: null, settings: null });
  tabs.state = { tabs: [], activeTab: null, sessions: {} };
  vi.clearAllMocks();
});

describe("terminal editor tab data", () => {
  it("validates untrusted session data", () => {
    const input = cliInput("Claude Code", "claude --continue", "/repo/app");
    expect(cliData(input)).toEqual({ name: "Claude Code", command: "claude --continue", cwd: "/repo/app" });
    expect(cliData({ ...input, data: undefined })).toBeNull();
    expect(cliData({ ...input, data: { name: "  ", command: "x" } })).toBeNull();
    expect(cliData({ ...input, data: { name: " A ", command: 3, cwd: 4 } })).toEqual({ name: "A", command: "" });
    expect(cliData({ ...input, kind: "file", path: "/repo/a.ts" })).toBeNull();
  });

  it("mints a fresh key per tab, so restored tabs are their own", () => {
    const a = cliInput("A", "");
    const b = cliInput("A", "");
    expect(a.key).not.toBe(b.key);
    expect(a.kind).toBe("cli");
  });
});

describe("Move to Editor", () => {
  const session = { state: { cwd: "/repo/app" } };

  it("hands the running session to a new editor tab named like the terminal tab", async () => {
    tabs.state.tabs = [
      { id: "t1", session: "s1" },
      { id: "t2", session: "s2" },
    ];
    runtime.detachTab.mockImplementation((id: string) => {
      tabs.state.tabs = tabs.state.tabs.filter((t) => t.id !== id);
      return session;
    });
    await moveTerminalToEditor("t2");
    expect(runtime.detachTab).toHaveBeenCalledExactlyOnceWith("t2");
    const input = editor.openInput.mock.calls[0]?.[0] as { kind: string; key: string; data: unknown };
    expect(input.kind).toBe("cli");
    expect(input.data).toEqual({ name: "Local (2)", command: "", cwd: "/repo/app" });
    expect(runtime.adoptCli).toHaveBeenCalledExactlyOnceWith(input.key, session);
    // The session belongs to the tab before it mounts, so it attaches instead of showing Start.
    expect(runtime.adoptCli.mock.invocationCallOrder[0]).toBeLessThan(editor.openInput.mock.invocationCallOrder[0]!);
    expect(runtime.startCli).not.toHaveBeenCalled();
    expect(toolWindows.hide).not.toHaveBeenCalled();
  });

  it("moves the active tab by default and hides the emptied tool window", async () => {
    tabs.state.tabs = [{ id: "t1", session: "s1" }];
    tabs.state.activeTab = "t1";
    runtime.detachTab.mockImplementation(() => {
      tabs.state.tabs = [];
      return session;
    });
    await moveTerminalToEditor();
    expect(runtime.detachTab).toHaveBeenCalledWith("t1");
    expect(toolWindows.hide).toHaveBeenCalledWith("terminal");
  });

  it("does nothing for an unknown tab", async () => {
    await moveTerminalToEditor("missing");
    expect(runtime.detachTab).not.toHaveBeenCalled();
    expect(editor.openInput).not.toHaveBeenCalled();
  });

  it("forwards pane, split edge, insertion index and pin state for editor drops", async () => {
    tabs.state.tabs = [{ id: "t1", session: "s1" }];
    runtime.detachTab.mockImplementationOnce(() => session);
    await moveTerminalToEditor("t1", { paneId: "pane-2", zone: "bottom" });
    expect(editor.openInput).toHaveBeenLastCalledWith(expect.objectContaining({ kind: CLI_KIND }), {
      focus: true,
      pane: "pane-2",
      edge: "bottom",
    });

    runtime.detachTab.mockImplementationOnce(() => session);
    await moveTerminalToEditor("t1", { paneId: "pane-1", zone: "center", index: 1, pinned: true });
    expect(editor.openInput).toHaveBeenLastCalledWith(expect.objectContaining({ kind: CLI_KIND }), {
      focus: true,
      pane: "pane-1",
      index: 1,
      pinned: true,
    });
  });

  it("splits an editor terminal tab into a fresh session in its working directory", async () => {
    tabs.state.tabs = [{ id: "t1", name: "Local", session: "s1" }];
    const existing = cliInput("Local (2)", "", "/repo");
    editor.openTabs.mockReturnValueOnce([{ input: existing, title: "Local (2)" }]);
    runtime.cliSession.mockReturnValueOnce({ state: { cwd: "/repo/sub" } });
    runtime.nextTabName.mockReturnValueOnce("Local (3)");

    const fresh = await splitCliTab(existing);
    expect(fresh).toMatchObject({
      kind: CLI_KIND,
      data: { name: "Local (3)", command: "", cwd: "/repo/sub" },
    });
    expect(fresh?.key).not.toBe(existing.key);
    expect(runtime.startCli).toHaveBeenCalledExactlyOnceWith(fresh!.key, "/repo/sub", "", "/repo");
  });
});

describe("restored tabs", () => {
  it("start a login shell where the session was, the project root as fallback", async () => {
    const input = cliInput("Local", "", "/repo/app");
    await startTab(input);
    expect(runtime.startCli).toHaveBeenCalledExactlyOnceWith(input.key, "/repo/app", "", "/repo");
    expect(editor.openInput).not.toHaveBeenCalled();
  });

  it("run a command saved with them only when started", async () => {
    const input = cliInput("Codex", "codex --yolo");
    await startTab(input);
    expect(runtime.startCli).toHaveBeenCalledExactlyOnceWith(input.key, "/repo", "codex --yolo", "/repo");
  });

  it("do nothing without a project", async () => {
    useProject.setState({ project: null });
    await startTab(cliInput("A", ""));
    expect(runtime.startCli).not.toHaveBeenCalled();
  });
});
