import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { McpServer, McpServerInput } from "@/bindings";
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

class FakeMcpBackend implements McpBackend {
  servers: McpServer[] = [...INITIAL_SERVERS];
  toggled: Array<{ id: string; enabled: boolean }> = [];
  saved: McpServerInput[] = [];
  removed: string[] = [];
  imported = 0;

  list = vi.fn(async () => this.servers);

  setEnabled = vi.fn(async (id: string, enabled: boolean) => {
    this.toggled.push({ id, enabled });
    this.servers = this.servers.map((s) => (s.id === id ? { ...s, enabled } : s));
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
    // Like the backend, a server already in the workspace is not imported again.
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

  it("toggles server enabled state via its checkbox", async () => {
    const backend = new FakeMcpBackend();
    render(<McpServersPage backend={backend} />);

    await waitFor(() => expect(screen.getByText("slack-official")).toBeInTheDocument());
    const box = screen.getByRole("checkbox", { name: "Enable slack-official" });
    expect(box).toBeChecked();

    fireEvent.click(box);
    await waitFor(() => expect(backend.toggled).toEqual([{ id: "user::slack-official", enabled: false }]));
    expect(screen.getByRole("checkbox", { name: "Enable slack-official" })).not.toBeChecked();
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
