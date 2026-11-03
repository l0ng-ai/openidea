import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { McpServer, McpServerInput } from "@/bindings";
import { McpServersPage, type McpBackend } from "./McpServersPage";

const server = (partial: Partial<McpServer> & Pick<McpServer, "id" | "name" | "scope">): McpServer => ({
  sourceLabel: "~/.copilot/mcp-config.json",
  configPath: "/Users/test/.copilot/mcp-config.json",
  pluginName: null,
  enabled: true,
  transport: "http",
  command: null,
  args: [],
  url: "https://example.com/mcp",
  env: [],
  headers: [],
  ...partial,
});

const INITIAL_SERVERS: McpServer[] = [
  server({ id: "user:slack-official", name: "slack-official", scope: "user" }),
  server({ id: "user:linear", name: "linear", scope: "user" }),
  server({
    id: "plugin:azure:azure",
    name: "azure",
    scope: "plugin",
    sourceLabel: "Plugin: azure",
    configPath: "/Users/test/.copilot/installed-plugins/copilot-plugins/azure/.mcp.json",
    pluginName: "azure",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@azure/mcp@latest", "server", "start"],
    url: null,
  }),
  server({
    id: "builtin:github-mcp-server",
    name: "github-mcp-server",
    scope: "builtin",
    sourceLabel: "",
    configPath: null,
  }),
];

class FakeMcpBackend implements McpBackend {
  servers: McpServer[] = [...INITIAL_SERVERS];
  toggled: Array<{ id: string; enabled: boolean }> = [];
  saved: McpServerInput[] = [];
  removed: string[] = [];

  list = vi.fn(async () => this.servers);

  setEnabled = vi.fn(async (id: string, enabled: boolean) => {
    this.toggled.push({ id, enabled });
    this.servers = this.servers.map((s) => (s.id === id ? { ...s, enabled } : s));
    return this.servers;
  });

  save = vi.fn(async (input: McpServerInput) => {
    this.saved.push(input);
    const id = input.id ?? `${input.scope}:${input.name}`;
    const next = server({
      id,
      name: input.name,
      scope: input.scope,
      sourceLabel: input.scope === "workspace" ? ".mcp.json" : "~/.copilot/mcp-config.json",
      transport: input.transport,
      command: input.command ?? null,
      args: input.args ?? [],
      url: input.url ?? null,
      env: input.env ?? [],
      headers: input.headers ?? [],
    });
    this.servers = [...this.servers.filter((s) => s.id !== id), next];
    return this.servers;
  });

  remove = vi.fn(async (id: string) => {
    this.removed.push(id);
    this.servers = this.servers.filter((s) => s.id !== id);
    return this.servers;
  });
}

describe("McpServersPage", () => {
  it("renders User, Workspace, Plugins, and Built-In groups with server details", async () => {
    const backend = new FakeMcpBackend();
    render(<McpServersPage backend={backend} />);

    await waitFor(() => expect(screen.getByText("slack-official")).toBeInTheDocument());
    expect(screen.getByText("linear")).toBeInTheDocument();
    expect(screen.getByText("azure")).toBeInTheDocument();
    expect(screen.getByText("Plugin: azure")).toBeInTheDocument();
    expect(screen.getByText("github-mcp-server")).toBeInTheDocument();
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

  it("toggles server enabled state via switch", async () => {
    const backend = new FakeMcpBackend();
    render(<McpServersPage backend={backend} />);

    await waitFor(() => expect(screen.getByText("slack-official")).toBeInTheDocument());
    const sw = screen.getByRole("switch", { name: "Enable slack-official" });
    expect(sw).toHaveAttribute("aria-checked", "true");

    fireEvent.click(sw);
    await waitFor(() => expect(backend.toggled).toEqual([{ id: "user:slack-official", enabled: false }]));
    expect(screen.getByRole("switch", { name: "Enable slack-official" })).toHaveAttribute("aria-checked", "false");
  });

  it("adds a new workspace MCP server from the + button", async () => {
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

    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(backend.saved).toHaveLength(1));
    expect(backend.saved[0]).toMatchObject({
      scope: "workspace",
      name: "filesystem",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    });
    await waitFor(() => expect(screen.getByText("filesystem")).toBeInTheDocument());
  });

  it("deletes a user MCP server from the More Actions menu", async () => {
    const backend = new FakeMcpBackend();
    render(<McpServersPage backend={backend} />);

    await waitFor(() => expect(screen.getByText("linear")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "More actions for linear" }));
    fireEvent.click(await screen.findByText("Delete Server"));

    await waitFor(() => expect(backend.removed).toEqual(["user:linear"]));
    await waitFor(() => expect(screen.queryByText("linear")).toBeNull());
  });
});
