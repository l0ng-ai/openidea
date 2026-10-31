import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { McpToolInfo, Settings } from "@/platform/ipc";

const ok = <T,>(data: T) => ({ status: "ok" as const, data });

const tool = (name: string, group: string, groupName: string, patch: Partial<McpToolInfo> = {}): McpToolInfo => ({
  name,
  description: `${name} does things`,
  kind: "read",
  enabled: true,
  group,
  groupName,
  fullyQualifiedName: `${group}.${name}`,
  experimental: false,
  routerOnly: true,
  ...patch,
});

const TOOLS: McpToolInfo[] = [
  tool("search_text", "general.SearchToolset", "Search"),
  tool("search_symbol", "general.SearchToolset", "Search"),
  tool("execute_terminal_command", "terminal.TerminalToolset", "Terminal", { kind: "execute" }),
  tool("get_ide_diagnostics", "general.DiagnosticsToolset", "IDE Diagnostics", { experimental: true }),
  tool("execute_tool", "general.UniversalToolset", "Universal Tool Router"),
];

const mcpTools = vi.fn(async () => TOOLS);
const settingsSet = vi.fn();
const settingsGet = vi.fn();
const mcpExportToolsMarkdown = vi.fn(async () => "# Tools");

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      mcpStatus: async () => ({ running: false, url: null, port: null, error: null, clients: [] }),
      mcpTools: () => mcpTools(),
      mcpExportToolsMarkdown: () => mcpExportToolsMarkdown(),
      settingsSet: (...a: unknown[]) => settingsSet(...a),
      settingsGet: () => settingsGet(),
    },
  };
});

const { useProject } = await import("@/platform/project");
const { MessagesHost } = await import("@/workbench/messages");
const { PageContext } = await import("../components/context");
const { DEFAULT_SETTINGS, setAt } = await import("../model/schema");
const { applySettings, openSettings, useSettingsDialog } = await import("../model/staging");
const { OptionsPage } = await import("../pages/OptionsPage");
const { MCP_TOOLS_PAGES } = await import("../pages/mcpTools");
const { MCP_TOOLS_PAGE } = await import("@/features/mcp/model");

const staged = (key: string) => useSettingsDialog.getState().staged[`global|${key}`]?.value;
let saved: Settings;

function start(mcp: Record<string, unknown> = {}) {
  saved = structuredClone(DEFAULT_SETTINGS) as Settings;
  saved = setAt(saved, "mcp", { ...(saved as { mcp: object }).mcp, ...mcp });
  useProject.setState({ settings: structuredClone(saved) as never, project: null });
  openSettings(MCP_TOOLS_PAGE);
}

beforeEach(() => {
  settingsSet.mockReset().mockImplementation(async (_scope: string, key: string, json: string) => {
    saved = setAt(saved, key, JSON.parse(json));
    return ok(saved);
  });
  settingsGet.mockReset().mockImplementation(async () => saved);
  start();
});

afterEach(() => {
  act(() => useSettingsDialog.setState({ open: false, staged: {} }));
  vi.clearAllMocks();
});

function renderPage() {
  return render(
    <PageContext.Provider value={{ pageId: MCP_TOOLS_PAGE, scope: "global" }}>
      <OptionsPage spec={MCP_TOOLS_PAGES[0]!} />
      <MessagesHost />
    </PageContext.Provider>,
  );
}

describe("Settings › Tools › MCP Server › Exposed Tools", () => {
  it("is a sub-page of MCP Server", () => {
    expect(MCP_TOOLS_PAGE.startsWith("tools.mcpServer.")).toBe(true);
  });

  it("groups the tools by toolset, without the router and the experimental tools", async () => {
    renderPage();
    const list = await screen.findByRole("list", { name: "MCP tools" });
    const groups = within(list)
      .getAllByRole("listitem")
      .filter((g) => g.parentElement === list);
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["Search", "Terminal"]);
    expect(screen.queryByText("execute_tool")).toBeNull();
    expect(screen.queryByText("get_ide_diagnostics")).toBeNull();
    expect(screen.getByText("3 enabled, 3 router-only")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Offer experimental tools" }));
    expect(staged("mcp.experimentalTools")).toBe(true);
    expect(await screen.findByText("get_ide_diagnostics")).toBeInTheDocument();
    expect(screen.getByText("Experimental")).toBeInTheDocument();
  });

  it("switches a tool off into toolStates and disabledTools, and back to the default", async () => {
    renderPage();
    const list = await screen.findByRole("list", { name: "MCP tools" });
    fireEvent.click(within(list).getByRole("checkbox", { name: "execute_terminal_command" }));
    expect(staged("mcp.toolStates")).toEqual({
      "terminal.TerminalToolset.execute_terminal_command": { enabled: false, routerOnly: true },
    });
    expect(staged("mcp.disabledTools")).toEqual(["execute_terminal_command"]);
    expect(screen.getByText("2 enabled, 2 router-only")).toBeInTheDocument();

    fireEvent.click(within(list).getByRole("checkbox", { name: "execute_terminal_command" }));
    expect(staged("mcp.toolStates")).toBeUndefined();
    expect(staged("mcp.disabledTools")).toBeUndefined();
  });

  it("reads the older disabledTools and drops it when the tool is switched on", async () => {
    start({ disabledTools: ["search_text"] });
    renderPage();
    const list = await screen.findByRole("list", { name: "MCP tools" });
    const search = within(list).getByRole("listitem", { name: "Search" });
    expect(within(search).getByRole("checkbox", { name: "search_text" })).not.toBeChecked();
    const group = within(search).getByRole("checkbox", { name: "Search: Enabled" });
    expect(group).toHaveAttribute("aria-checked", "mixed");

    fireEvent.click(group);
    expect(staged("mcp.disabledTools")).toEqual([]);
    expect(within(search).getByRole("checkbox", { name: "search_text" })).toBeChecked();
    fireEvent.click(group);
    expect(staged("mcp.toolStates")).toEqual({
      "general.SearchToolset.search_symbol": { enabled: false, routerOnly: true },
      "general.SearchToolset.search_text": { enabled: false, routerOnly: true },
    });
  });

  it("offers router-only in router mode, per tool and per toolset", async () => {
    renderPage();
    const list = await screen.findByRole("list", { name: "MCP tools" });
    expect(within(list).queryByRole("checkbox", { name: "Router-only: search_text" })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Enable router-only mode" }));
    expect(staged("mcp.invocationMode")).toBe("viaRouter");

    const search = within(list).getByRole("listitem", { name: "Search" });
    fireEvent.click(within(search).getByRole("checkbox", { name: "search_text: Router-only" }));
    expect(staged("mcp.toolStates")).toEqual({
      "general.SearchToolset.search_text": { enabled: true, routerOnly: false },
    });
    expect(within(search).getByRole("checkbox", { name: "Search: Router-only" })).toHaveAttribute(
      "aria-checked",
      "mixed",
    );
    fireEvent.click(within(search).getByRole("checkbox", { name: "Search: Router-only" }));
    expect(staged("mcp.toolStates")).toBeUndefined();
  });

  it("filters by the search, folds toolsets, and stages the advanced filter", async () => {
    renderPage();
    const list = await screen.findByRole("list", { name: "MCP tools" });
    fireEvent.click(within(list).getByRole("button", { name: "Search" }));
    expect(screen.queryByText("search_text")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Search tools" }), { target: { value: "symbol" } });
    expect(screen.getByText("search_symbol")).toBeInTheDocument();
    expect(screen.queryByText("execute_terminal_command")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Search tools" }), { target: { value: "nothing" } });
    expect(screen.getByText("No tools match the current search")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Search tools" }), { target: { value: "" } });

    fireEvent.click(screen.getByRole("button", { name: "Advanced filter" }));
    fireEvent.change(screen.getByLabelText("Advanced filter:"), { target: { value: "-*.execute_terminal_command" } });
    expect(staged("mcp.toolsFilter")).toBe("-*.execute_terminal_command");
    expect(screen.getByText("Hidden by the advanced filter")).toBeInTheDocument();
  });

  it("writes the edits on Apply", async () => {
    renderPage();
    const list = await screen.findByRole("list", { name: "MCP tools" });
    fireEvent.click(within(list).getByRole("checkbox", { name: "execute_terminal_command" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Enable router-only mode" }));
    await act(async () => expect(await applySettings()).toBe(true));
    expect(settingsSet.mock.calls).toEqual([
      ["global", "mcp.disabledTools", '["execute_terminal_command"]'],
      ["global", "mcp.invocationMode", '"viaRouter"'],
      [
        "global",
        "mcp.toolStates",
        '{"terminal.TerminalToolset.execute_terminal_command":{"enabled":false,"routerOnly":true}}',
      ],
    ]);
    await waitFor(() => expect(useSettingsDialog.getState().staged).toEqual({}));
  });
});
