import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  McpExternalSource,
  McpImportSelection,
  McpProbeResult,
  McpScope,
  McpServer,
  McpServerInput,
} from "@/bindings";
import { McpServersPage, type McpBackend } from "./McpServersPage";

const server = (partial: Partial<McpServer> & Pick<McpServer, "id" | "name" | "scope">): McpServer => ({
  enabled: true,
  transport: "http",
  command: null,
  args: [],
  url: "https://example.com/mcp",
  env: [],
  headers: [],
  agents: [],
  unapproved: false,
  ...partial,
});

const INITIAL_SERVERS: McpServer[] = [
  server({ id: "user::slack-official", name: "slack-official", scope: "user" }),
  server({ id: "user::linear", name: "linear", scope: "user", agents: ["claude"] }),
  server({
    id: "workspace::azure",
    name: "azure",
    scope: "workspace",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@azure/mcp@latest", "server", "start"],
    url: null,
  }),
];

const INITIAL_SOURCES: McpExternalSource[] = [
  {
    id: "copilot-cli",
    label: "GitHub Copilot CLI",
    path: "/Users/dev/.copilot/mcp-config.json",
    suggestedScope: "user",
    nativeProvider: "copilot",
    servers: [
      {
        name: "github-mcp-server",
        transport: "http",
        enabled: true,
        command: null,
        args: [],
        url: "https://api.githubcopilot.com/mcp/",
        envKeys: [],
        headerKeys: ["Authorization"],
      },
    ],
  },
];

class FakeMcpBackend implements McpBackend {
  servers: McpServer[] = [...INITIAL_SERVERS];
  sources: McpExternalSource[] = [...INITIAL_SOURCES];
  toggled: Array<{ id: string; enabled: boolean }> = [];
  saved: McpServerInput[] = [];
  savedJson: Array<{ scope: McpScope; rawJson: string; agents: string[] }> = [];
  importedSelected: Array<{ scope: McpScope; selections: McpImportSelection[]; overwrite: boolean }> = [];
  removed: string[] = [];
  imported = 0;

  list = vi.fn(async () => this.servers);

  discoverSources = vi.fn(async () => this.sources);

  setEnabled = vi.fn(async (id: string, enabled: boolean) => {
    this.toggled.push({ id, enabled });
    this.servers = this.servers.map((s) => (s.id === id ? { ...s, enabled, unapproved: false } : s));
    return this.servers;
  });

  save = vi.fn(async (input: McpServerInput) => {
    this.saved.push(input);
    const id = `${input.scope}::${input.name}`;
    const next = server({
      id,
      name: input.name,
      scope: input.scope,
      transport: input.transport,
      command: input.command ?? null,
      args: input.args ?? [],
      url: input.url ?? null,
      env: input.env ?? [],
      headers: input.headers ?? [],
      agents: input.agents ?? [],
    });
    this.servers = [...this.servers.filter((s) => s.id !== (input.id ?? id)), next];
    return this.servers;
  });

  saveJson = vi.fn(async (scope: McpScope, rawJson: string, _fallback: string | null, agents: string[]) => {
    this.savedJson.push({ scope, rawJson, agents });
    const parsed = JSON.parse(rawJson) as { mcpServers?: Record<string, { command?: string; args?: string[] }> };
    for (const [name, cfg] of Object.entries(parsed.mcpServers ?? {})) {
      this.servers = [
        ...this.servers.filter((s) => s.id !== `${scope}::${name}`),
        server({
          id: `${scope}::${name}`,
          name,
          scope,
          transport: "stdio",
          command: cfg.command ?? "npx",
          args: cfg.args ?? [],
          url: null,
          agents,
        }),
      ];
    }
    return this.servers;
  });

  importSelected = vi.fn(async (scope: McpScope, selections: McpImportSelection[], overwrite: boolean) => {
    this.importedSelected.push({ scope, selections, overwrite });
    for (const sel of selections) {
      const src = this.sources.find((s) => s.id === sel.sourceId);
      const found = src?.servers.find((s) => s.name === sel.name);
      if (!found) continue;
      this.servers = [
        ...this.servers.filter((s) => s.id !== `${scope}::${found.name}`),
        server({
          id: `${scope}::${found.name}`,
          name: found.name,
          scope,
          transport: found.transport,
          command: found.command,
          args: found.args,
          url: found.url,
        }),
      ];
    }
    return this.servers;
  });

  testServer = vi.fn(async (_id: string): Promise<McpProbeResult> => ({
    ok: true,
    serverName: "mock-mcp",
    serverVersion: "1.2.0",
    protocolVersion: "2024-11-05",
    durationMs: 42,
    error: null,
    tools: [
      { name: "search_issues", description: "Search issues across repositories" },
      { name: "create_pr", description: "Open a pull request" },
    ],
  }));

  remove = vi.fn(async (id: string) => {
    this.removed.push(id);
    this.servers = this.servers.filter((s) => s.id !== id);
    return this.servers;
  });

  importWorkspace = vi.fn(async () => {
    this.imported += 1;
    const importedServer = server({
      id: "workspace::imported-fs",
      name: "imported-fs",
      scope: "workspace",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
      url: null,
    });
    if (!this.servers.some((s) => s.id === importedServer.id)) this.servers = [...this.servers, importedServer];
    return this.servers;
  });
}

describe("McpServersPage", () => {
  it("renders User and Workspace groups with server summaries", async () => {
    const backend = new FakeMcpBackend();
    render(<McpServersPage backend={backend} />);

    await waitFor(() => expect(screen.getByText("slack-official")).toBeInTheDocument());
    expect(screen.getByText("linear")).toBeInTheDocument();
    expect(screen.getByText("HTTP · https://example.com/mcp (claude)")).toBeInTheDocument();
    expect(screen.getByText("azure")).toBeInTheDocument();
    expect(screen.getByText("npx -y @azure/mcp@latest server start")).toBeInTheDocument();
    const workspace = screen.getByRole("region", { name: "Workspace" });
    expect(within(workspace).getByText(/stay off until you turn them on here/)).toBeInTheDocument();
  });

  it("filters servers across sections by search query", async () => {
    const backend = new FakeMcpBackend();
    render(<McpServersPage backend={backend} />);

    await waitFor(() => expect(screen.getByText("slack-official")).toBeInTheDocument());
    const search = screen.getByPlaceholderText("Type to search...");
    fireEvent.change(search, { target: { value: "azure" } });

    expect(screen.getByText("azure")).toBeInTheDocument();
    expect(screen.queryByText("slack-official")).not.toBeInTheDocument();
  });

  it("toggles server enabled state via its switch", async () => {
    const backend = new FakeMcpBackend();
    render(<McpServersPage backend={backend} />);

    await waitFor(() => expect(screen.getByText("slack-official")).toBeInTheDocument());
    const sw = screen.getByRole("switch", { name: "Enable slack-official" });
    expect(sw).toHaveAttribute("aria-checked", "true");

    fireEvent.click(sw);
    await waitFor(() => expect(backend.toggled).toEqual([{ id: "user::slack-official", enabled: false }]));
    expect(screen.getByRole("switch", { name: "Enable slack-official" })).toHaveAttribute("aria-checked", "false");
  });

  it("probes a server and displays discovered tools inside its expandable card", async () => {
    const backend = new FakeMcpBackend();
    render(<McpServersPage backend={backend} />);

    await waitFor(() => expect(screen.getByText("slack-official")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Test slack-official" }));

    await waitFor(() => expect(backend.testServer).toHaveBeenCalledWith("user::slack-official"));
    expect(await screen.findByText("search_issues")).toBeInTheDocument();
    expect(screen.getByText("Search issues across repositories")).toBeInTheDocument();
    expect(screen.getByText("Tools (2)")).toBeInTheDocument();
  });

  it("discovers external agent CLI configs and imports into Global settings", async () => {
    const backend = new FakeMcpBackend();
    render(<McpServersPage backend={backend} />);

    await waitFor(() => expect(screen.getByText("slack-official")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Review & Import" }));

    expect(await screen.findByText("GitHub Copilot CLI")).toBeInTheDocument();
    expect(screen.getByText("github-mcp-server")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select github-mcp-server" }));
    fireEvent.click(screen.getByRole("button", { name: "Import Selected (1)" }));

    await waitFor(() => expect(backend.importedSelected).toHaveLength(1));
    expect(backend.importedSelected[0]).toEqual({
      scope: "user",
      selections: [{ sourceId: "copilot-cli", name: "github-mcp-server" }],
      overwrite: false,
    });
  });

  it("saves servers from pasted mcpServers JSON with selected agent chips", async () => {
    const backend = new FakeMcpBackend();
    render(<McpServersPage backend={backend} />);

    await waitFor(() => expect(screen.getByText("slack-official")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Add from JSON" }));

    const dialog = await screen.findByRole("dialog");
    const jsonField = within(dialog).getByLabelText("JSON:");
    fireEvent.change(jsonField, {
      target: {
        value: JSON.stringify({
          mcpServers: {
            playwright: { command: "npx", args: ["@playwright/mcp@latest"] },
          },
        }),
      },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "GitHub Copilot" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(backend.savedJson).toHaveLength(1));
    expect(backend.savedJson[0]?.agents).toEqual(["copilot"]);
    await waitFor(() => expect(screen.getByText("playwright")).toBeInTheDocument());
  });

  it("adds a new workspace MCP server with optional agent filter", async () => {
    const backend = new FakeMcpBackend();
    render(<McpServersPage backend={backend} />);

    await waitFor(() => expect(screen.getByText("slack-official")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Add Workspace MCP Server" }));

    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByPlaceholderText("my-mcp-server"), {
      target: { value: "filesystem" },
    });
    fireEvent.change(within(dialog).getByPlaceholderText("npx"), {
      target: { value: "npx" },
    });
    fireEvent.change(within(dialog).getByPlaceholderText("-y @modelcontextprotocol/server-filesystem /path"), {
      target: { value: "-y @modelcontextprotocol/server-filesystem ." },
    });
    fireEvent.change(within(dialog).getByPlaceholderText("claude, codex"), {
      target: { value: "claude, codex" },
    });

    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(backend.saved).toHaveLength(1));
    expect(backend.saved[0]).toMatchObject({
      scope: "workspace",
      name: "filesystem",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
      agents: ["claude", "codex"],
    });
    await waitFor(() => expect(screen.getByText("filesystem")).toBeInTheDocument());
  });

  it("imports workspace MCP servers from the project and says how many were added", async () => {
    const backend = new FakeMcpBackend();
    render(<McpServersPage backend={backend} />);

    await waitFor(() => expect(screen.getByText("slack-official")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Import from Project" }));

    await waitFor(() => expect(backend.imported).toBe(1));
    await waitFor(() => expect(screen.getByText("imported-fs")).toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent("Imported 1 MCP server from the project.");

    fireEvent.click(screen.getByRole("button", { name: "Import from Project" }));
    await waitFor(() => expect(backend.imported).toBe(2));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "No new MCP servers in the project's .mcp.json or .vscode/mcp.json.",
      ),
    );
  });

  it("deletes a user MCP server from the More Actions menu", async () => {
    const backend = new FakeMcpBackend();
    render(<McpServersPage backend={backend} />);

    await waitFor(() => expect(screen.getByText("linear")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "More actions for linear" }));
    fireEvent.click(await screen.findByText("Delete Server"));

    await waitFor(() => expect(backend.removed).toEqual(["user::linear"]));
    await waitFor(() => expect(screen.queryByText("linear")).toBeNull());
  });
});
