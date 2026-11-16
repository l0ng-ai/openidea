import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { McpExternalSource, McpServer } from "@/bindings";
import { McpPicker } from "./McpPicker";
import type { McpBackend } from "./mcpModel";

const SERVERS: McpServer[] = [
  {
    id: "user::shared",
    name: "shared",
    scope: "user",
    transport: "stdio",
    enabled: true,
    command: "npx",
    args: ["user-shared"],
    env: [],
    url: null,
    headers: [],
    agents: [],
    unapproved: false,
  },
  {
    id: "workspace::shared",
    name: "shared",
    scope: "workspace",
    transport: "stdio",
    enabled: true,
    command: "npx",
    args: ["workspace-shared"],
    env: [],
    url: null,
    headers: [],
    agents: [],
    unapproved: false,
  },
  {
    id: "user::claude-only",
    name: "claude-only",
    scope: "user",
    transport: "http",
    enabled: true,
    command: null,
    args: [],
    env: [],
    url: "https://mcp.example.com",
    headers: [],
    agents: ["claude"],
    unapproved: false,
  },
];

const SOURCES: McpExternalSource[] = [
  {
    id: "copilot-cli",
    label: "GitHub Copilot CLI",
    path: "/Users/dev/.copilot/mcp-config.json",
    suggestedScope: "user",
    nativeProvider: "copilot",
    servers: [
      {
        name: "workiq",
        transport: "stdio",
        enabled: true,
        command: "npx",
        args: ["-y", "@microsoft/workiq", "mcp"],
        url: null,
        envKeys: [],
        headerKeys: [],
      },
    ],
  },
];

function Harness({
  provider = "copilot",
  openRequest = 0,
  backend,
}: {
  provider?: string;
  openRequest?: number;
  backend?: McpBackend;
}) {
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  return (
    <McpPicker
      provider={provider}
      overrides={overrides}
      onChange={setOverrides}
      openRequest={openRequest}
      backend={backend}
      testData={{
        servers: SERVERS,
        sources: SOURCES,
        ideMcpEnabled: true,
      }}
    />
  );
}

describe("McpPicker", () => {
  it("resolves IDE, Project override over Global, agent-scoped defaults, and native CLI configs", async () => {
    render(<Harness provider="copilot" />);

    // Active by default for copilot: openidea (IDE) + shared (Project) + workiq (Copilot CLI) = 3 of 4 (claude-only is off).
    const trigger = screen.getByRole("button", { name: "MCP servers" });
    expect(trigger).toHaveTextContent("MCP3/4");

    fireEvent.click(trigger);
    expect(await screen.findByText("Session MCP Servers")).toBeInTheDocument();
    expect(screen.getByText("Overrides Global")).toBeInTheDocument();
    expect(screen.getByText("workiq")).toBeInTheDocument();
    expect(screen.getByText("Active via GitHub Copilot CLI")).toBeInTheDocument();

    // Toggle `shared` off and `claude-only` on for this session only, then Reset.
    const sharedSwitch = screen.getByRole("switch", { name: "Enable shared for this session" });
    const claudeSwitch = screen.getByRole("switch", { name: "Enable claude-only for this session" });
    expect(sharedSwitch).toHaveAttribute("aria-checked", "true");
    expect(claudeSwitch).toHaveAttribute("aria-checked", "false");

    fireEvent.click(sharedSwitch);
    fireEvent.click(claudeSwitch);
    expect(sharedSwitch).toHaveAttribute("aria-checked", "false");
    expect(claudeSwitch).toHaveAttribute("aria-checked", "true");
    expect(screen.getAllByText("Session")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(sharedSwitch).toHaveAttribute("aria-checked", "true");
    expect(claudeSwitch).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
  });

  it("opens automatically when openRequest increments (e.g. /mcp slash command)", async () => {
    const importSelected = vi.fn(async () => SERVERS);
    const backend: McpBackend = {
      list: async () => SERVERS,
      save: async () => SERVERS,
      setEnabled: async () => SERVERS,
      remove: async () => SERVERS,
      importWorkspace: async () => SERVERS,
      importSelected,
    };

    const { rerender } = render(<Harness provider="copilot" openRequest={0} backend={backend} />);
    expect(screen.queryByText("Session MCP Servers")).toBeNull();

    rerender(<Harness provider="copilot" openRequest={1} backend={backend} />);
    expect(await screen.findByText("Session MCP Servers")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() =>
      expect(importSelected).toHaveBeenCalledWith("user", [{ sourceId: "copilot-cli", name: "workiq" }], false),
    );
  });
});
