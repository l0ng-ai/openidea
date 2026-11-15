/**
 * Terminal editor tabs (#2202): input data validation, Move to Editor and the
 * Start flow of a restored tab through the terminal runtime.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cliData, cliInput, moveTerminalToEditor, startTab } from "./cli";

const tabs = vi.hoisted(() => ({
  state: {
    tabs: [] as { id: string; session: string }[],
    activeTab: null as string | null,
    sessions: {} as Record<string, unknown>,
  },
}));
const runtime = vi.hoisted(() => ({
  loaded: false,
  startCli: vi.fn(),
  adoptCli: vi.fn(),
  detachTab: vi.fn(),
  tabTitle: vi.fn((_tab: unknown, _sessions: unknown) => "Local (2)"),
  useTerminals: { getState: () => tabs.state },
}));
const editor = vi.hoisted(() => ({
  openInput: vi.fn(async (_input?: unknown, _options?: unknown) => undefined),
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
