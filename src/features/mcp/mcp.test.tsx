import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { emitLocalIdeEvent, type McpAnswer, type McpStatus } from "@/platform/ipc";
import type { EditorService } from "@/workbench/contributions";

const mcpRespond = vi.fn(async (_id: number, _answer: McpAnswer) => {});
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, commands: { ...real.commands, mcpRespond: (id: number, a: McpAnswer) => mcpRespond(id, a) } };
});
const executeAction = vi.fn();
vi.mock("@/platform/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/actions")>()),
  executeAction: (...a: unknown[]) => executeAction(...a),
}));

const { answerConfirm, denyAll, dropConfirm, enqueueConfirm, handleMcpRequest, openEditors, useMcpConfirms } =
  await import("./requests");
const { McpConfirmHost } = await import("./ConfirmDialog");
const { McpStatusWidget, statusTooltip } = await import("./McpStatus");
const { useMcpStatus } = await import("@/platform/mcp");
const { activate } = await import(".");
const { tx } = await import("@/platform/i18n");

const confirm = (id: number, subject = "npm test") => ({
  id,
  client: "claude-code",
  tool: "execute_terminal_command",
  subject,
  detail: "in /work/app",
});

function editor(patch: Partial<EditorService> = {}): EditorService {
  return {
    openFile: vi.fn(async () => {}),
    openInput: vi.fn(async () => {}),
    activePath: () => "/work/app/src/main.ts",
    activeCursor: () => null,
    saveAll: async () => {},
    openPaths: () => ["/work/app/src/main.ts", "jdt://contents/rt.jar/java.lang/String.class", "/work/app/README.md"],
    ...patch,
  };
}

beforeEach(() => useMcpConfirms.setState({ queue: [] }));
afterEach(() => vi.clearAllMocks());

describe("MCP confirmation queue", () => {
  it("queues confirmations in arrival order, once each", () => {
    enqueueConfirm(confirm(1));
    enqueueConfirm(confirm(2));
    enqueueConfirm(confirm(1));
    expect(useMcpConfirms.getState().queue.map((c) => c.id)).toEqual([1, 2]);
  });

  it("drops a request that is over (answered, timed out)", () => {
    enqueueConfirm(confirm(1));
    enqueueConfirm(confirm(2));
    dropConfirm(1);
    dropConfirm(9);
    expect(useMcpConfirms.getState().queue.map((c) => c.id)).toEqual([2]);
  });

  it("answers the backend and moves on to the next request", () => {
    const respond = vi.fn(async () => {});
    enqueueConfirm(confirm(1));
    enqueueConfirm(confirm(2));
    answerConfirm(confirm(1), true, respond);
    expect(respond).toHaveBeenCalledWith(1, { type: "confirm", allow: true });
    expect(useMcpConfirms.getState().queue.map((c) => c.id)).toEqual([2]);
  });

  it("asks again first, with the reason, when the answer cannot be sent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const respond = vi.fn(async () => Promise.reject(new Error("IPC closed")));
    enqueueConfirm(confirm(1));
    enqueueConfirm(confirm(2));
    answerConfirm(confirm(1), true, respond);
    expect(useMcpConfirms.getState().queue.map((c) => c.id)).toEqual([2]);
    await vi.waitFor(() => expect(useMcpConfirms.getState().queue.map((c) => c.id)).toEqual([1, 2]));
    expect(useMcpConfirms.getState().queue[0]!.error).toBe("IPC closed");
    expect(warn).toHaveBeenCalledWith("cannot answer MCP request 1", expect.any(Error));

    // Closed by the backend while the answer was on its way: not asked again.
    let reject: (e: Error) => void = () => {};
    const pending = vi.fn(() => new Promise<void>((_, r) => (reject = r)));
    answerConfirm(confirm(2), false, pending);
    dropConfirm(2);
    reject(new Error("IPC closed"));
    await Promise.resolve();
    await Promise.resolve();
    expect(useMcpConfirms.getState().queue.map((c) => c.id)).toEqual([1]);
    warn.mockRestore();
  });

  it("denies every waiting request when the window goes away", () => {
    const respond = vi.fn(async () => {});
    enqueueConfirm(confirm(1));
    enqueueConfirm(confirm(2));
    denyAll(respond);
    expect(respond.mock.calls).toEqual([
      [1, { type: "confirm", allow: false }],
      [2, { type: "confirm", allow: false }],
    ]);
    expect(useMcpConfirms.getState().queue).toEqual([]);
  });

  it("denies the waiting requests when deactivated or when the page unloads", () => {
    let dispose = activate();
    act(() => {
      enqueueConfirm(confirm(1));
      enqueueConfirm(confirm(2));
    });
    dispose();
    expect(mcpRespond.mock.calls).toEqual([
      [1, { type: "confirm", allow: false }],
      [2, { type: "confirm", allow: false }],
    ]);
    expect(useMcpConfirms.getState().queue).toEqual([]);

    mcpRespond.mockClear();
    dispose = activate();
    try {
      enqueueConfirm(confirm(3));
      window.dispatchEvent(new Event("beforeunload"));
      expect(mcpRespond).toHaveBeenCalledWith(3, { type: "confirm", allow: false });
      expect(useMcpConfirms.getState().queue).toEqual([]);
    } finally {
      dispose();
    }
    expect(mcpRespond).toHaveBeenCalledTimes(1);
  });
});

describe("MCP editor requests", () => {
  it("queues a confirmation without answering it yet", async () => {
    const respond = vi.fn(async () => {});
    await handleMcpRequest(
      4,
      { type: "confirm", client: "codex", tool: "run_configuration", subject: "App", detail: null },
      respond,
    );
    expect(respond).not.toHaveBeenCalled();
    expect(useMcpConfirms.getState().queue).toEqual([
      { id: 4, client: "codex", tool: "run_configuration", subject: "App", detail: null },
    ]);
  });

  it("opens a file at the 1-based position the client gives", async () => {
    const respond = vi.fn(async () => {});
    const ed = editor();
    await handleMcpRequest(5, { type: "openFile", path: "/work/app/a.ts", line: 10, column: 3 }, respond, () => ed);
    expect(ed.openFile).toHaveBeenCalledWith("/work/app/a.ts", { selection: { line: 9, col: 2 }, focus: true });
    expect(respond).toHaveBeenCalledWith(5, { type: "done" });

    await handleMcpRequest(6, { type: "openFile", path: "/work/app/b.ts", line: 4, column: null }, respond, () => ed);
    expect(ed.openFile).toHaveBeenLastCalledWith("/work/app/b.ts", { selection: { line: 3, col: 0 }, focus: true });

    await handleMcpRequest(
      7,
      { type: "openFile", path: "/work/app/c.ts", line: null, column: null },
      respond,
      () => ed,
    );
    expect(ed.openFile).toHaveBeenLastCalledWith("/work/app/c.ts", { selection: undefined, focus: true });
  });

  it("answers failed when the file cannot be opened or there is no editor", async () => {
    const respond = vi.fn(async () => {});
    const ed = editor({ openFile: async () => Promise.reject(new Error("No such file")) });
    await handleMcpRequest(8, { type: "openFile", path: "/nope", line: 1, column: 1 }, respond, () => ed);
    expect(respond).toHaveBeenCalledWith(8, { type: "failed", message: "No such file" });

    await handleMcpRequest(9, { type: "openEditors" }, respond, () => {
      throw new Error("editor service not provided yet");
    });
    expect(respond).toHaveBeenCalledWith(9, { type: "failed", message: "editor service not provided yet" });
  });

  it("lists the active and open editors' files on disk", async () => {
    const respond = vi.fn(async () => {});
    await handleMcpRequest(10, { type: "openEditors" }, respond, () => editor());
    expect(respond).toHaveBeenCalledWith(10, {
      type: "openEditors",
      editors: { active: "/work/app/src/main.ts", open: ["/work/app/src/main.ts", "/work/app/README.md"] },
    });
    expect(openEditors(editor({ activePath: () => "jdt://contents/x", openPaths: undefined }))).toEqual({
      type: "openEditors",
      editors: { active: null, open: [] },
    });
  });
});

describe("MCP confirmation dialog", () => {
  it("asks for the oldest request; Allow and Deny answer it, Escape denies", () => {
    render(<McpConfirmHost />);
    act(() => {
      enqueueConfirm(confirm(1, "rm -rf build && npm run build -- --watch=false"));
      enqueueConfirm(confirm(2, "cargo test"));
    });
    let dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("claude-code wants to run");
    expect(dialog).toHaveTextContent("execute_terminal_command");
    expect(within(dialog).getByLabelText("What will run")).toHaveTextContent("rm -rf build && npm run build");
    expect(dialog).toHaveTextContent("in /work/app");
    expect(dialog).toHaveTextContent("1 more waiting");

    fireEvent.click(within(dialog).getByRole("button", { name: "Allow" }));
    expect(mcpRespond).toHaveBeenCalledWith(1, { type: "confirm", allow: true });
    dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText("What will run")).toHaveTextContent("cargo test");
    expect(dialog).not.toHaveTextContent("more waiting");

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(mcpRespond).toHaveBeenCalledWith(2, { type: "confirm", allow: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("makes Deny the default, focused button and links to the brave mode setting", () => {
    render(<McpConfirmHost />);
    act(() => enqueueConfirm(confirm(3)));
    const dialog = screen.getByRole("dialog");
    const deny = within(dialog).getByRole("button", { name: "Deny" });
    expect(deny).toHaveAttribute("data-dialog-default");
    expect(deny).toHaveFocus();
    fireEvent.click(within(dialog).getByRole("button", { name: "Settings › Tools › MCP Server" }));
    expect(executeAction).toHaveBeenCalledWith("file.settings", "tools.mcpServer");
    fireEvent.click(within(dialog).getByRole("button", { name: "Deny" }));
    expect(mcpRespond).toHaveBeenCalledWith(3, { type: "confirm", allow: false });
  });

  it("follows the backend events once activated", async () => {
    const dispose = activate();
    try {
      render(<McpConfirmHost />);
      act(() =>
        emitLocalIdeEvent({
          type: "mcpRequest",
          id: 11,
          request: { type: "confirm", client: "cursor", tool: "run_configuration", subject: "Server", detail: null },
        }),
      );
      expect(screen.getByRole("dialog")).toHaveTextContent("cursor wants to run");
      // Answered in time by nobody: the backend gives up and closes it.
      act(() => emitLocalIdeEvent({ type: "mcpRequestDone", id: 11 }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(mcpRespond).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });
});

describe("MCP status bar widget", () => {
  const running: McpStatus = {
    running: true,
    url: "http://127.0.0.1:64352/mcp",
    port: 64352,
    error: null,
    clients: [{ name: "claude-code", version: "2.1.0", calls: 3 }],
  };

  it("describes the server and its clients", () => {
    expect(statusTooltip(running, tx)).toBe(
      "MCP Server running at http://127.0.0.1:64352/mcp · claude-code 2.1.0: 3 tool calls",
    );
    expect(statusTooltip({ ...running, clients: [] }, tx)).toBe(
      "MCP Server running at http://127.0.0.1:64352/mcp · No clients connected",
    );
    expect(statusTooltip({ ...running, running: false, url: null, error: "Port in use" }, tx)).toBe(
      "MCP Server not running: Port in use",
    );
    expect(statusTooltip(null, tx)).toBe("MCP Server not running");
  });

  it("shows only while the server runs or failed to start, and opens its settings", () => {
    act(() => useMcpStatus.setState({ status: null }));
    const view = render(<McpStatusWidget />);
    expect(screen.queryByRole("button", { name: "MCP Server" })).toBeNull();
    // Disabled in the global settings (whatever this project's layer says).
    act(() => useMcpStatus.setState({ status: { ...running, running: false, url: null, port: null, clients: [] } }));
    expect(screen.queryByRole("button", { name: "MCP Server" })).toBeNull();

    act(() => useMcpStatus.setState({ status: running }));
    const widget = screen.getByRole("button", { name: "MCP Server" });
    expect(widget).toHaveAttribute("data-tooltip", expect.stringContaining("running at"));
    act(() =>
      emitLocalIdeEvent({
        type: "mcpStatusChanged",
        status: { ...running, running: false, url: null, error: "Port in use", clients: [] },
      }),
    );
    expect(widget).toHaveAttribute("data-tooltip", "MCP Server not running: Port in use");
    fireEvent.click(widget);
    expect(executeAction).toHaveBeenCalledWith("file.settings", "tools.mcpServer");
    view.unmount();
    act(() => useMcpStatus.setState({ status: null }));
  });
});
