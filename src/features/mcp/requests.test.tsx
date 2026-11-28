import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  respond: vi.fn(async () => ({ status: "ok", data: null })),
  respondValue: vi.fn(async () => ({ status: "ok", data: null })),
  open: vi.fn(),
  execute: vi.fn(async (_id: string, _arg?: unknown): Promise<unknown> => undefined),
}));
vi.mock("@/platform/actions", async (original) => ({
  ...(await original<object>()),
  executeActionOrThrow: mocks.execute,
}));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<object>()),
  commands: { mcpRespond: mocks.respond, mcpRespondWith: mocks.respondValue },
}));
vi.mock("@/workbench/contributions", () => ({ editorService: () => ({ openFile: mocks.open }) }));
import { McpConfirmHost } from "./ConfirmDialog";
import { answerConfirm, denyAll, dropConfirm, handleMcpRequest, useMcpConfirms } from "./requests";
import { setMcpDebugSession } from "./session";

const confirm = {
  type: "confirm",
  client: "test client",
  tool: "execute_run_configuration",
  subject: "Tests",
  project: "/project",
  detail: "npm test",
} as const;
beforeEach(() => {
  vi.clearAllMocks();
  useMcpConfirms.setState({ queue: [] });
});
afterEach(() => {
  cleanup();
  denyAll();
});

describe("MCP confirmations", () => {
  it("queues requests, allows one, and denies the next on Escape", async () => {
    await handleMcpRequest(1, confirm);
    await handleMcpRequest(2, { ...confirm, subject: "Build" });
    render(<McpConfirmHost />);
    expect(screen.getByText("npm test")).toBeTruthy();
    expect(screen.getByText("test client wants to run Tests")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(mocks.respond).toHaveBeenCalledWith(1, true, null));
    expect(screen.getByText("test client wants to run Build")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(mocks.respond).toHaveBeenCalledWith(2, false, null));
    expect(useMcpConfirms.getState().queue).toEqual([]);
  });
  it("denies by default on Enter and denies everything on unload", async () => {
    await handleMcpRequest(3, confirm);
    render(<McpConfirmHost />);
    fireEvent.keyDown(document, { key: "Enter" });
    await waitFor(() => expect(mocks.respond).toHaveBeenCalledWith(3, false, null));
    await act(async () => {
      await handleMcpRequest(4, confirm);
      await handleMcpRequest(5, confirm);
      denyAll();
    });
    expect(mocks.respond).toHaveBeenCalledWith(4, false, null);
    expect(mocks.respond).toHaveBeenCalledWith(5, false, null);
  });
  it("drops expired requests, including failed answers that arrive later", async () => {
    await handleMcpRequest(6, confirm);
    const request = useMcpConfirms.getState().queue[0]!;
    let reject!: (e: Error) => void;
    const sending = new Promise<void>((_, no) => {
      reject = no;
    });
    answerConfirm(request, true, () => sending);
    dropConfirm(6);
    reject(new Error("expired"));
    await Promise.resolve();
    expect(useMcpConfirms.getState().queue).toEqual([]);
  });
  it("opens a file with zero-based UTF-16 coordinates and reports errors", async () => {
    await handleMcpRequest(7, { type: "openFile", path: "/project/a.ts", line: 2, column: 4 });
    expect(mocks.open).toHaveBeenCalledWith("/project/a.ts", { selection: { line: 1, col: 3 }, focus: true });
    expect(mocks.respond).toHaveBeenCalledWith(7, true, null);
    mocks.open.mockRejectedValueOnce(new Error("cannot open"));
    await handleMcpRequest(8, { type: "openFile", path: "/project/b.ts", line: null, column: null });
    expect(mocks.respond).toHaveBeenCalledWith(8, false, "Error: cannot open");
  });
  it("starts an agent command in the Run tool window and says whether it started", async () => {
    const request = { type: "agentRun", name: "_agent_test", command: "npm test", cwd: "/project", env: {} } as const;
    await handleMcpRequest(9, request);
    expect(mocks.execute).toHaveBeenCalledWith("run.agentStart", {
      name: "_agent_test",
      command: "npm test",
      cwd: "/project",
      env: {},
    });
    expect(mocks.respond).toHaveBeenCalledWith(9, true, null);
    mocks.execute.mockRejectedValueOnce(new Error("The command did not start"));
    await handleMcpRequest(10, request);
    expect(mocks.respond).toHaveBeenCalledWith(10, false, "The command did not start");
  });
  it("starts an agent's run configuration in the Run tool window and says whether it started", async () => {
    const config = { id: "server", name: "Server", kind: "shell", command: "npm run dev" };
    await handleMcpRequest(11, { type: "runConfiguration", config });
    expect(mocks.execute).toHaveBeenCalledWith("run.mcpStart", config);
    expect(mocks.respond).toHaveBeenCalledWith(11, true, null);
    mocks.execute.mockRejectedValueOnce(new Error("The run did not start"));
    await handleMcpRequest(12, { type: "runConfiguration", config });
    expect(mocks.respond).toHaveBeenCalledWith(12, false, "The run did not start");
  });
  it("starts an agent's configuration in Debug mode and answers with the session id", async () => {
    const config = { id: "server", name: "Server", kind: "shell", command: "npm run dev" };
    setMcpDebugSession(42);
    await handleMcpRequest(13, { type: "debugConfiguration", config });
    expect(mocks.execute).toHaveBeenCalledWith("debug.mcpStart", config);
    expect(mocks.respondValue).toHaveBeenCalledWith(13, true, null, "42");
    mocks.execute.mockRejectedValueOnce(new Error("The debug session did not start"));
    await handleMcpRequest(14, { type: "debugConfiguration", config });
    expect(mocks.respondValue).toHaveBeenCalledWith(14, false, "The debug session did not start", null);
  });
  it("applies breakpoint edits in the window and reports errors", async () => {
    const breakpoint = { line: 3, enabled: true, condition: null, hitCondition: null, logMessage: null };
    const set = { type: "setBreakpoint", path: "/project/src/main.py", breakpoint } as const;
    await handleMcpRequest(15, set);
    expect(mocks.execute).toHaveBeenCalledWith("debug.mcpSetBreakpoint", set);
    expect(mocks.respond).toHaveBeenCalledWith(15, true, null);
    const remove = { type: "removeBreakpoints", path: "/project/src/main.py", line: 3 } as const;
    await handleMcpRequest(16, remove);
    expect(mocks.execute).toHaveBeenCalledWith("debug.mcpRemoveBreakpoints", remove);
    mocks.execute.mockRejectedValueOnce(new Error("No project window"));
    await handleMcpRequest(17, set);
    expect(mocks.respond).toHaveBeenCalledWith(17, false, "No project window");
    await handleMcpRequest(18, { type: "flushBreakpoints" });
    expect(mocks.execute).toHaveBeenCalledWith("debug.mcpFlushBreakpoints", undefined);
  });
});
