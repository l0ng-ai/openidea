import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  emitLocalIdeEvent,
  type McpCallRecord,
  type McpClientConfig,
  type McpDetectedClient,
  type McpStatus,
  type McpToolInfo,
  type Settings,
} from "@/platform/ipc";
import type { EditorService, NotificationService } from "@/workbench/contributions";

const ok = <T,>(data: T) => ({ status: "ok" as const, data });

const mcpCallHistory = vi.fn(async (): Promise<McpCallRecord[]> => []);
const mcpDetectClients = vi.fn(async (_p: string | null) => ok<McpDetectedClient[]>([]));
const mcpClients = vi.fn(async () => ok<McpClientConfig[]>([]));
const mcpConfigureClient = vi.fn(async (_k: string) => ok({} as McpClientConfig));
const mcpConfigureProjectClient = vi.fn(async (_k: string, p: string) => ok(`${p}/.mcp.json`));
const mcpExportToolsMarkdown = vi.fn(async () => "# MCP tools");
const settingsSet = vi.fn();

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      mcpStatus: async () => ({ running: false, url: null, port: null, error: null, clients: [] }),
      mcpCallHistory: () => mcpCallHistory(),
      mcpDetectClients: (p: string | null) => mcpDetectClients(p),
      mcpClients: () => mcpClients(),
      mcpConfigureClient: (k: string) => mcpConfigureClient(k),
      mcpConfigureProjectClient: (k: string, p: string) => mcpConfigureProjectClient(k, p),
      mcpExportToolsMarkdown: () => mcpExportToolsMarkdown(),
      settingsSet: (...a: unknown[]) => settingsSet(...a),
    },
  };
});
const executeAction = vi.fn();
vi.mock("@/platform/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/actions")>()),
  executeAction: (...a: unknown[]) => executeAction(...a),
}));

const { DEFAULT_MCP, validateMcp } = await import("@/platform/mcp");
const { useProject } = await import("@/platform/project");
const contributions = await import("@/workbench/contributions");
const { MessagesHost } = await import("@/workbench/messages");
const toolStates = await import("./toolStates");
const calls = await import("./calls");
const { McpToolWindow, filterCalls, useMcpToolWindow } = await import("./ToolCalls");
const { McpServerPopup, clientsNeedingConfig } = await import("./McpStatus");
const { exportToolsMarkdown } = await import("./exportTools");
const { checkClients } = await import("./detection");
const { activate } = await import(".");

const notify = vi.fn();
const openFile = vi.fn(async () => {});
const show = vi.fn();

function settings(mcp: Partial<typeof DEFAULT_MCP>): Settings {
  return { mcp: { ...DEFAULT_MCP, ...mcp } } as unknown as Settings;
}

beforeEach(() => {
  contributions.provideNotificationService({ notify } as NotificationService);
  contributions.provideEditorService({ openFile } as unknown as EditorService);
  contributions.provideToolWindowService({ show, hide: vi.fn(), toggle: vi.fn(), isVisible: () => false });
  useProject.setState({ settings: settings({ enabled: true }) as never, project: null });
  calls.useMcpCalls.setState({ calls: [], loaded: false, error: null });
  settingsSet.mockImplementation(async (_s: string, key: string, json: string) =>
    ok(settings({ ...validateMcp(useProject.getState().settings?.mcp), [key.slice(4)]: JSON.parse(json) })),
  );
});
afterEach(() => vi.clearAllMocks());

const record = (patch: Partial<McpCallRecord>): McpCallRecord => ({
  id: 1,
  client: "claude-code",
  tool: "read_file",
  arguments: '{"path":"src/main.ts"}',
  startedAtMs: Date.UTC(2026, 9, 31, 12, 0, 5),
  durationMs: 42,
  outcome: "success",
  error: null,
  viaRouter: false,
  project: "/work/app",
  changedFiles: [],
  ...patch,
});

describe("MCP settings", () => {
  it("keeps the new keys with ide-core's defaults", () => {
    expect(validateMcp(undefined)).toEqual(DEFAULT_MCP);
    expect(DEFAULT_MCP).toMatchObject({
      toolsFilter: "",
      toolStates: {},
      invocationMode: "direct",
      experimentalTools: false,
      clientConfirmations: false,
    });
    expect(
      validateMcp({
        toolsFilter: "-*",
        toolStates: { "a.b": { enabled: false }, "": { enabled: false }, c: "x" },
        invocationMode: "viaRouter",
        experimentalTools: true,
        clientConfirmations: true,
      }),
    ).toMatchObject({
      toolsFilter: "-*",
      toolStates: { "a.b": { enabled: false, routerOnly: true }, c: { enabled: true, routerOnly: true } },
      invocationMode: "viaRouter",
      experimentalTools: true,
      clientConfirmations: true,
    });
    expect(validateMcp({ invocationMode: "bogus" }).invocationMode).toBe("direct");
  });
});

describe("Exposed Tools model", () => {
  const tool = (name: string, group: string, groupName: string, patch: Partial<McpToolInfo> = {}): McpToolInfo => ({
    name,
    description: "",
    kind: "read",
    enabled: true,
    group,
    groupName,
    fullyQualifiedName: `${group}.${name}`,
    experimental: false,
    routerOnly: true,
    ...patch,
  });
  const read = tool("read_file", "general.ReadToolset", "File Reading");
  const search = tool("search_text", "general.SearchToolset", "Search");

  it("groups by display name and leaves out the router", () => {
    const groups = toolStates.groupTools([search, tool("execute_tool", "general.UniversalToolset", "Router"), read]);
    expect(groups.map((g) => g.name)).toEqual(["File Reading", "Search"]);
  });

  it("reads the qualified name, then the plain one, then disabledTools", () => {
    const s = { toolStates: {}, disabledTools: ["read_file"] };
    expect(toolStates.toolState(read, s)).toEqual({ enabled: false, routerOnly: true });
    expect(
      toolStates.toolState(read, { ...s, toolStates: { read_file: { enabled: true, routerOnly: false } } }),
    ).toEqual({ enabled: true, routerOnly: false });
    expect(
      toolStates.toolState(read, {
        toolStates: {
          read_file: { enabled: false, routerOnly: false },
          [read.fullyQualifiedName]: { enabled: true, routerOnly: true },
        },
        disabledTools: [],
      }),
    ).toEqual({ enabled: true, routerOnly: true });
  });

  it("stores only states that differ from the default, by qualified name", () => {
    const off = toolStates.withToolStates(
      { toolStates: { read_file: { enabled: true, routerOnly: false } }, disabledTools: [] },
      [read],
      (st) => ({ ...st, enabled: false }),
    );
    expect(off).toEqual({
      toolStates: { "general.ReadToolset.read_file": { enabled: false, routerOnly: false } },
      disabledTools: ["read_file"],
    });
    const back = toolStates.withToolStates(off, [read], () => ({ enabled: true, routerOnly: true }));
    expect(back).toEqual({ toolStates: {}, disabledTools: [] });
  });

  it("matches masks like ide-mcp's MaskList, JetBrains names too", () => {
    expect(toolStates.filterAllows("", read)).toBe(true);
    expect(toolStates.filterAllows("-*", read)).toBe(false);
    expect(toolStates.filterAllows("-*,+general.Read*", read)).toBe(true);
    expect(toolStates.filterAllows("-*,+com.intellij.mcpserver.toolsets.general.*,-*.read_file", read)).toBe(false);
    expect(toolStates.filterAllows("-*,+com.intellij.mcpserver.toolsets.general.*,-*.read_file", search)).toBe(true);
    expect(toolStates.filterAllows("-general.?eadToolset.*", read)).toBe(false);
  });

  it("lists experimental tools when offered or switched on", () => {
    const diag = tool("get_ide_diagnostics", "general.DiagnosticsToolset", "IDE Diagnostics", { experimental: true });
    const none = { toolStates: {}, disabledTools: [] };
    expect(toolStates.isListed(diag, none, false)).toBe(false);
    expect(toolStates.isListed(diag, none, true)).toBe(true);
    expect(
      toolStates.isListed(
        diag,
        { ...none, toolStates: { get_ide_diagnostics: { enabled: true, routerOnly: true } } },
        false,
      ),
    ).toBe(true);
    expect(toolStates.commonValue([read, search], () => true)).toBe(true);
    expect(toolStates.commonValue([read, search], (t) => t === read)).toBeNull();
  });
});

describe("MCP tool calls", () => {
  it("formats durations and resolves changed files against the project", () => {
    expect(calls.formatDuration(850)).toBe("850 ms");
    expect(calls.formatDuration(2400)).toBe("2.4 s");
    expect(calls.formatDuration(65_000)).toBe("1 m 5 s");
    expect(calls.changedFilePath("src/a.ts", "/work/app")).toBe("/work/app/src/a.ts");
    expect(calls.changedFilePath("/tmp/x", "/work/app")).toBe("/tmp/x");
    expect(calls.changedFilePath("src\\a.ts", "C:\\work")).toBe("C:\\work\\src\\a.ts");
    expect(calls.prettyArguments('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(calls.prettyArguments("{ path: …")).toBe("{ path: …");
    const list = [record({ id: 1 }), record({ id: 2, tool: "search_text", outcome: "error" })];
    expect(filterCalls(list, "SEARCH", "all").map((c) => c.id)).toEqual([2]);
    expect(filterCalls(list, "", "success").map((c) => c.id)).toEqual([1]);
  });

  it("lists the calls, refreshes on mcpStatusChanged and opens a changed file", async () => {
    mcpCallHistory.mockResolvedValueOnce([
      record({
        id: 2,
        tool: "replace_text_in_file",
        viaRouter: true,
        changedFiles: ["src/main.ts"],
        outcome: "error",
        error: "No match",
      }),
      record({ id: 1 }),
    ]);
    useMcpToolWindow.setState({ tab: "calls" });
    render(<McpToolWindow />);
    const table = await screen.findByRole("table", { name: "Tool Calls" });
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(3));
    expect(within(table).getByText("via router")).toBeInTheDocument();
    fireEvent.click(within(table).getByText("replace_text_in_file"));
    const detail = screen.getByRole("region", { name: "Call details" });
    expect(within(detail).getByLabelText("Arguments")).toHaveTextContent('"path": "src/main.ts"');
    expect(within(detail).getByText("No match")).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole("button", { name: "src/main.ts" }));
    expect(openFile).toHaveBeenCalledWith("/work/app/src/main.ts", { focus: true });

    mcpCallHistory.mockResolvedValueOnce([record({ id: 3, tool: "search_symbol" })]);
    act(() =>
      emitLocalIdeEvent({
        type: "mcpStatusChanged",
        status: { running: true, url: null, port: null, error: null, clients: [] },
      }),
    );
    await waitFor(() => expect(within(table).getByText("search_symbol")).toBeInTheDocument());
  });

  it("shows the configuration tab", () => {
    useMcpToolWindow.setState({ tab: "configuration" });
    render(<McpToolWindow />);
    expect(screen.getByRole("status", { name: "Server status" })).toHaveTextContent("Server status: Stopped");
    fireEvent.click(screen.getByRole("button", { name: "Open MCP server settings" }));
    expect(executeAction).toHaveBeenCalledWith("file.settings", "tools.mcpServer");
    useMcpToolWindow.setState({ tab: "calls" });
  });

  it("registers the tool window only while the server is enabled", () => {
    useProject.setState({ settings: settings({ enabled: false }) as never });
    const dispose = activate();
    try {
      const has = () => contributions.useContributions.getState().toolWindows.has("mcpServer");
      expect(has()).toBe(false);
      act(() => useProject.setState({ settings: settings({ enabled: true }) as never }));
      expect(has()).toBe(true);
      act(() => useProject.setState({ settings: settings({ enabled: false }) as never }));
      expect(has()).toBe(false);
    } finally {
      dispose();
    }
  });
});

describe("MCP Server popup", () => {
  const running: McpStatus = {
    running: true,
    url: "http://127.0.0.1:64352/mcp",
    port: 64352,
    error: null,
    clients: [{ name: "claude-code", version: "2.1.0", calls: 3 }],
  };
  const detected = (patch: Partial<McpDetectedClient>): McpDetectedClient => ({
    client: "cursor",
    project: null,
    file: "/home/me/.cursor/mcp.json",
    configured: false,
    portCorrect: true,
    current: false,
    transports: [],
    ...patch,
  });

  it("picks the detected clients that need configuring", () => {
    expect(
      clientsNeedingConfig([
        detected({ client: "cursor" }),
        detected({ client: "codex", configured: true, current: true }),
        detected({ client: "vsCode", configured: true, portCorrect: false }),
        detected({ client: "junie", project: "/p" }),
      ]).map((d) => d.client),
    ).toEqual(["cursor", "vsCode"]);
  });

  it("shows status, connections and calls, configures a client and runs the quick actions", async () => {
    mcpDetectClients.mockResolvedValueOnce(
      ok([detected({ client: "cursor" }), detected({ client: "vsCode", configured: true, portCorrect: false })]),
    );
    mcpCallHistory.mockResolvedValueOnce([record({ id: 1 }), record({ id: 2 })]);
    const onClose = vi.fn();
    render(<McpServerPopup status={running} enabled onClose={onClose} />);
    expect(screen.getByRole("status", { name: "Server status" })).toHaveTextContent("Running at http://127.0.0.1");
    expect(screen.getByText("1 active connection")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("2 recent tool calls")).toBeInTheDocument());
    const list = await screen.findByRole("list", { name: "Detected clients" });
    expect(within(list).getByText("Port mismatch detected – please reconfigure")).toBeInTheDocument();
    fireEvent.click(within(list).getByRole("button", { name: "Auto-Configure Cursor" }));
    expect(mcpConfigureClient).toHaveBeenCalledWith("cursor");
    await waitFor(() => expect(within(list).getByText("Configured")).toBeInTheDocument());

    fireEvent.click(screen.getByText("2 recent tool calls"));
    expect(show).toHaveBeenCalledWith("mcpServer", true);
    fireEvent.click(screen.getByRole("button", { name: "All MCP Tools" }));
    expect(executeAction).toHaveBeenCalledWith("file.settings", "tools.mcpServer.exposedTools");
    expect(onClose).toHaveBeenCalled();
  });

  it("toggles brave mode and turns the server off at once, on after consent", async () => {
    render(
      <>
        <McpServerPopup status={running} enabled onClose={() => {}} />
        <MessagesHost />
      </>,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Brave mode" }));
    await waitFor(() => expect(settingsSet).toHaveBeenCalledWith("global", "mcp.braveMode", "true"));
    fireEvent.click(screen.getByRole("switch", { name: "Enable MCP Server" }));
    await waitFor(() => expect(settingsSet).toHaveBeenCalledWith("global", "mcp.enabled", "false"));
    expect(validateMcp(useProject.getState().settings?.mcp).enabled).toBe(false);
  });

  it("asks before enabling the server", async () => {
    useProject.setState({ settings: settings({ enabled: false }) as never });
    render(
      <>
        <McpServerPopup status={null} enabled={false} onClose={() => {}} />
        <MessagesHost />
      </>,
    );
    expect(screen.getByText(/allows external AI clients/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Enable MCP Server" }));
    const dialog = await screen.findByRole("dialog", { name: "Enable MCP Server?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Enable" }));
    await waitFor(() => expect(settingsSet).toHaveBeenCalledWith("global", "mcp.enabled", "true"));
  });

  it("copies a client's configuration", async () => {
    const writeText = vi.fn(async (_t: string) => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    mcpClients.mockResolvedValueOnce(
      ok([
        { client: "codex", file: null, snippet: "codex mcp add", format: "shell", configured: false, canWrite: true },
      ]),
    );
    render(<McpServerPopup status={running} enabled onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Copy Config/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Codex" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("codex mcp add"));
  });
});

describe("Export to Markdown", () => {
  it("saves the tools to the picked file", async () => {
    render(<MessagesHost />);
    const write = vi.fn(async () => {});
    const done = exportToolsMarkdown({ pick: async () => "/tmp/mcp_tools.md", write });
    const dialog = await screen.findByRole("dialog", { name: "Export MCP Tools" });
    expect(dialog).toHaveTextContent("Save MCP tools information as Markdown");
    fireEvent.click(within(dialog).getByRole("button", { name: "Export to Markdown" }));
    await done;
    expect(write).toHaveBeenCalledWith("/tmp/mcp_tools.md", "# MCP tools");
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "MCP tools exported", group: "mcp" }));
  });

  it("copies the tools to the clipboard", async () => {
    render(<MessagesHost />);
    const copy = vi.fn(async () => {});
    const done = exportToolsMarkdown({ copy });
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Copy to Clipboard" }));
    await done;
    expect(copy).toHaveBeenCalledWith("# MCP tools");
  });
});

describe("MCP client detection notifications", () => {
  const detected = (patch: Partial<McpDetectedClient>): McpDetectedClient => ({
    client: "cursor",
    project: null,
    file: "/f",
    configured: false,
    portCorrect: true,
    current: false,
    transports: [],
    ...patch,
  });

  it("stays quiet while the server is off", async () => {
    useProject.setState({ settings: settings({ enabled: false }) as never });
    await checkClients("/work/app");
    expect(mcpDetectClients).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("offers to fix a stale port and to configure installed clients", async () => {
    mcpDetectClients.mockResolvedValueOnce(
      ok([
        detected({ client: "claudeCode", project: "/work/app", configured: true, portCorrect: false }),
        detected({ client: "cursor" }),
      ]),
    );
    await checkClients("/work/app");
    expect(mcpDetectClients).toHaveBeenCalledWith("/work/app");
    expect(notify).toHaveBeenCalledTimes(2);
    const [stale, unconfigured] = notify.mock.calls.map((c) => c[0]);
    expect(stale).toMatchObject({ level: "warning", group: "mcp", key: "mcp.clients.portMismatch" });
    expect(stale.body).toContain("Claude Code");
    expect(unconfigured.body).toBe("The following MCP clients are not yet configured: Cursor.");
    expect(unconfigured.actions.map((a: { label: string }) => a.label)).toEqual([
      "Auto-Configure",
      "Open MCP Settings",
    ]);

    stale.actions[0].run();
    await waitFor(() => expect(mcpConfigureProjectClient).toHaveBeenCalledWith("claudeCode", "/work/app"));
    unconfigured.actions[0].run();
    await waitFor(() => expect(mcpConfigureClient).toHaveBeenCalledWith("cursor"));
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Clients have been autoconfigured" })),
    );
    unconfigured.actions[1].run();
    expect(executeAction).toHaveBeenCalledWith("file.settings", "tools.mcpServer");
  });
});
