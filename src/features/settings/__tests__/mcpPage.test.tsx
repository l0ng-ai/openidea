import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { emitLocalIdeEvent, type McpClientConfig, type McpStatus, type McpToolInfo } from "@/platform/ipc";

const ok = <T,>(data: T) => ({ status: "ok" as const, data });
const fail = (message: string) => ({ status: "error" as const, error: { kind: "io" as const, message } });

const STOPPED: McpStatus = { running: false, url: null, port: null, error: null, clients: [] };
const RUNNING: McpStatus = {
  running: true,
  url: "http://127.0.0.1:64352/mcp",
  port: 64352,
  error: null,
  clients: [],
};

const client = (patch: Partial<McpClientConfig>): McpClientConfig => ({
  client: "claudeCode",
  file: null,
  snippet:
    "claude mcp add --transport http openidea http://127.0.0.1:64352/mcp --header 'Authorization: Bearer s3cret'",
  format: "shell",
  configured: false,
  canWrite: true,
  ...patch,
});

const TOOLS: McpToolInfo[] = [
  { name: "read_file", description: "Reads a file of the project", kind: "read", enabled: true },
  { name: "execute_terminal_command", description: "Runs a shell command", kind: "execute", enabled: true },
];

const mcpStatus = vi.fn(async (): Promise<McpStatus> => STOPPED);
const mcpClients = vi.fn();
const mcpConfigureClient = vi.fn();
const mcpRegenerateToken = vi.fn(async () => ok(null));
const mcpTools = vi.fn(async () => TOOLS);

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      mcpStatus: () => mcpStatus(),
      mcpClients: () => mcpClients(),
      mcpConfigureClient: (k: string) => mcpConfigureClient(k),
      mcpRegenerateToken: () => mcpRegenerateToken(),
      mcpTools: () => mcpTools(),
    },
  };
});

const { useProject } = await import("@/platform/project");
const { useMcpStatus } = await import("@/platform/mcp");
const { MessagesHost } = await import("@/workbench/messages");
const { PageContext } = await import("../components/context");
const { DEFAULT_SETTINGS } = await import("../model/schema");
const { openSettings, useSettingsDialog } = await import("../model/staging");
const { OptionsPage } = await import("../pages/OptionsPage");
const { MCP_PAGE, MCP_PAGES, withToolEnabled } = await import("../pages/mcp");

const staged = (key: string) => useSettingsDialog.getState().staged[`global|${key}`]?.value;
const writeText = vi.fn(async (_text: string) => {});

beforeEach(() => {
  useProject.setState({ settings: structuredClone(DEFAULT_SETTINGS) as never, project: null });
  useMcpStatus.setState({ status: null });
  mcpClients.mockReset().mockImplementation(async () =>
    ok([
      client({ client: "claudeCode" }),
      client({
        client: "cursor",
        file: "/home/me/.cursor/mcp.json",
        snippet: '{ "mcpServers": { "openidea": { "headers": { "Authorization": "Bearer s3cret" } } } }',
        format: "json",
        configured: true,
      }),
      client({ client: "vsCode", file: "/home/me/Code/User/mcp.json", canWrite: false, format: "json" }),
    ]),
  );
  mcpConfigureClient.mockReset();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  openSettings(MCP_PAGE);
});

afterEach(() => {
  act(() => useSettingsDialog.setState({ open: false, staged: {} }));
  vi.clearAllMocks();
});

function renderPage() {
  return render(
    <PageContext.Provider value={{ pageId: MCP_PAGE, scope: "global" }}>
      <OptionsPage spec={MCP_PAGES[0]!} />
      <MessagesHost />
    </PageContext.Provider>,
  );
}

describe("Settings › Tools › MCP Server", () => {
  it("stages the server options and follows the live status", async () => {
    mcpStatus.mockResolvedValueOnce(RUNNING);
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Server status" })).toHaveTextContent(
        "Running at http://127.0.0.1:64352/mcp",
      ),
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Enable MCP Server" }));
    expect(staged("mcp.enabled")).toBe(true);
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Run shell commands and run configurations without confirmation (brave mode)",
      }),
    );
    expect(staged("mcp.braveMode")).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Give the IDE's agents these tools" }));
    expect(staged("mcp.agents")).toBe(false);

    act(() =>
      emitLocalIdeEvent({
        type: "mcpStatusChanged",
        status: { ...STOPPED, error: "Port 64352 is already in use" },
      }),
    );
    expect(screen.getByRole("status", { name: "Server status" })).toHaveTextContent(
      "Not running: Port 64352 is already in use",
    );

    act(() =>
      emitLocalIdeEvent({
        type: "mcpStatusChanged",
        status: { ...RUNNING, clients: [{ name: "claude-code", version: "2.1.0", calls: 7 }] },
      }),
    );
    const connected = screen.getByRole("table", { name: "Connected clients" });
    expect(within(connected).getByRole("row", { name: "claude-code 2.1.0 7" })).toBeInTheDocument();
  });

  it("applies the port on blur or Enter, and only a valid one", () => {
    renderPage();
    const port = screen.getByLabelText("Port");
    expect(port).toHaveValue("64352");

    fireEvent.change(port, { target: { value: "80" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a port between 1024 and 65535");
    fireEvent.blur(port);
    expect(staged("mcp.port")).toBeUndefined();

    fireEvent.change(port, { target: { value: "6400" } });
    expect(staged("mcp.port")).toBeUndefined();
    fireEvent.keyDown(port, { key: "Enter" });
    expect(staged("mcp.port")).toBe(6400);

    fireEvent.change(port, { target: { value: "6500" } });
    fireEvent.blur(port);
    expect(staged("mcp.port")).toBe(6500);
    expect(port).toHaveValue("6500");
  });

  it("lists the clients: copy, show and auto-configure their configuration", async () => {
    renderPage();
    const list = await screen.findByRole("list", { name: "MCP clients" });
    const claude = within(list).getByRole("listitem", { name: "Claude Code" });
    const cursor = within(list).getByRole("listitem", { name: "Cursor" });
    const vscode = within(list).getByRole("listitem", { name: "VS Code" });

    expect(within(cursor).getByText("Configured")).toBeInTheDocument();
    expect(within(cursor).getByText("/home/me/.cursor/mcp.json")).toBeInTheDocument();
    expect(within(claude).getByText("Not configured")).toBeInTheDocument();
    expect(within(claude).getByText("Run this command in a terminal:")).toBeInTheDocument();
    expect(within(vscode).getByRole("button", { name: "Auto-Configure" })).toBeDisabled();

    // The token stays out of view until asked for.
    expect(screen.queryByText(/s3cret/)).toBeNull();
    fireEvent.click(within(cursor).getByRole("button", { name: "Show configuration" }));
    expect(within(cursor).getByLabelText("Configuration")).toHaveTextContent("Bearer s3cret");

    fireEvent.click(within(claude).getByRole("button", { name: "Copy configuration" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining("claude mcp add")));
    expect(within(claude).getByRole("button", { name: "Copied" })).toBeInTheDocument();

    mcpConfigureClient.mockResolvedValueOnce(ok(client({ client: "claudeCode", configured: true })));
    fireEvent.click(within(claude).getByRole("button", { name: "Auto-Configure" }));
    expect(mcpConfigureClient).toHaveBeenCalledWith("claudeCode");
    await waitFor(() => expect(within(claude).getByText("Configured")).toBeInTheDocument());

    mcpConfigureClient.mockResolvedValueOnce(fail("Permission denied"));
    fireEvent.click(within(cursor).getByRole("button", { name: "Auto-Configure" }));
    await waitFor(() => expect(within(cursor).getByRole("alert")).toHaveTextContent("Permission denied"));
  });

  it("regenerates the token after confirming, then reloads the clients", async () => {
    renderPage();
    await screen.findByRole("list", { name: "MCP clients" });
    expect(mcpClients).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Regenerate token…" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("can no longer connect");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mcpRegenerateToken).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Regenerate token…" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Regenerate" }));
    await waitFor(() => expect(mcpRegenerateToken).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mcpClients).toHaveBeenCalledTimes(2));
  });

  it("turns tools on and off through disabledTools", async () => {
    renderPage();
    const tools = await screen.findByRole("list", { name: "MCP tools" });
    expect(within(tools).getByText("Execute")).toBeInTheDocument();
    expect(within(tools).getByText("Runs a shell command")).toHaveAttribute("data-tooltip", "Runs a shell command");

    fireEvent.click(within(tools).getByRole("checkbox", { name: "execute_terminal_command" }));
    expect(staged("mcp.disabledTools")).toEqual(["execute_terminal_command"]);
    expect(within(tools).getByRole("checkbox", { name: "execute_terminal_command" })).not.toBeChecked();
    fireEvent.click(within(tools).getByRole("checkbox", { name: "execute_terminal_command" }));
    expect(staged("mcp.disabledTools")).toBeUndefined();
  });

  it("keeps disabledTools sorted and free of duplicates", () => {
    expect(withToolEnabled(["b"], "a", false)).toEqual(["a", "b"]);
    expect(withToolEnabled(["a", "b"], "a", false)).toEqual(["a", "b"]);
    expect(withToolEnabled(["a", "b"], "a", true)).toEqual(["b"]);
  });
});
