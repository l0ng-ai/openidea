import type {
  AgentEntry,
  AgentProvider,
  AgentTask,
  McpExternalSource,
  McpProbeResult,
  McpServer,
} from "../src/bindings";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

const copilotProvider: AgentProvider = {
  id: "copilot",
  name: "GitHub Copilot",
  command: "copilot",
  program: "copilot",
  args: [],
  defaultProgram: "copilot",
  defaultArgs: [],
  loginHint: null,
  commandOverridden: false,
  commandEditable: true,
  commandReadOnlyReason: null,
  installed: true,
  env: {},
  commands: [],
  source: { kind: "builtin" },
  config: [
    {
      id: "model",
      category: "model",
      name: "Model",
      description: null,
      current: "claude-sonnet-4.6",
      via: "option",
      values: [{ value: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", description: null }],
    },
    {
      id: "mode",
      category: "mode",
      name: "Mode",
      description: null,
      current: "agent",
      via: "option",
      values: [
        { value: "agent", name: "Agent", description: null },
        { value: "plan", name: "Plan", description: null },
      ],
    },
  ],
  thoughtLevels: {},
};

const sampleTask: AgentTask = {
  id: "mcp-session-1",
  title: "Investigate authentication service latency",
  provider: "copilot",
  status: "ready",
  isolation: "local",
  model: "claude-sonnet-4.6",
  cwd: "/dev/acme-api",
  branch: "main",
  base: null,
  baseCommit: null,
  error: null,
  createdMs: 0,
  updatedMs: 0,
  config: copilotProvider.config,
  commands: [],
  usage: null,
  queue: [],
  mcpOverrides: {},
};

const initialServers: McpServer[] = [
  {
    id: "user::github-mcp-server",
    name: "github-mcp-server",
    scope: "user",
    transport: "http",
    enabled: true,
    command: null,
    args: [],
    env: [],
    url: "https://api.githubcopilot.com/mcp/",
    headers: [{ name: "Authorization", value: "Bearer ***" }],
    agents: [],
    unapproved: false,
  },
  {
    id: "user::slack-official",
    name: "slack-official",
    scope: "user",
    transport: "stdio",
    enabled: true,
    command: "npx",
    args: ["-y", "mcp-remote", "https://mcp.slack.com/mcp"],
    env: [],
    url: null,
    headers: [],
    agents: [],
    unapproved: false,
  },
  {
    id: "workspace::postgres-local",
    name: "postgres-local",
    scope: "workspace",
    transport: "stdio",
    enabled: true,
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/acme"],
    env: [{ name: "PGPASSWORD", value: "***" }],
    url: null,
    headers: [],
    agents: [],
    unapproved: false,
  },
];

const discoveredSources: McpExternalSource[] = [
  {
    id: "copilot-cli",
    label: "GitHub Copilot CLI",
    path: "/Users/dev/.copilot/mcp-config.json",
    suggestedScope: "user",
    nativeProvider: "copilot",
    servers: [
      {
        name: "playwright",
        transport: "stdio",
        enabled: true,
        command: "npx",
        args: ["-y", "@playwright/mcp@latest"],
        url: null,
        envKeys: [],
        headerKeys: [],
      },
      {
        name: "datadog",
        transport: "http",
        enabled: true,
        command: null,
        args: [],
        url: "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp",
        envKeys: [],
        headerKeys: ["DD-API-KEY"],
      },
    ],
  },
  {
    id: "jetbrains-air",
    label: "JetBrains Air",
    path: "/Users/dev/.jetbrains/mcp/mcp.json",
    suggestedScope: "user",
    nativeProvider: null,
    servers: [
      {
        name: "linear",
        transport: "stdio",
        enabled: true,
        command: "npx",
        args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"],
        url: null,
        envKeys: [],
        headerKeys: [],
      },
    ],
  },
];

const probeResult: McpProbeResult = {
  ok: true,
  serverName: "github-mcp-server",
  serverVersion: "0.18.2",
  protocolVersion: "2024-11-05",
  durationMs: 68,
  error: null,
  tools: [
    { name: "search_issues", description: "Search issues across GitHub repositories using semantic matching" },
    { name: "pull_request_read", description: "Read pull request details, diff, reviews, and CI check runs" },
    { name: "list_commits", description: "List commits on a branch in a GitHub repository" },
  ],
};

test("manages multi-level MCP servers in Settings and per-session overrides via Composer /mcp", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 1280, height: 840 });
  await stubDesktop(page);

  await page.evaluate(
    async ({ copilotProvider, sampleTask, initialServers, discoveredSources, probeResult }) => {
      const storeModule = "/src/features/agents/store.ts";
      const store = await import(/* @vite-ignore */ storeModule);
      const projectModule = "/src/platform/project.ts";
      const { useProject } = await import(/* @vite-ignore */ projectModule);

      const prevSettings = useProject.getState().settings ?? {};
      useProject.setState({
        settings: {
          ...prevSettings,
          mcpServer: { ...(prevSettings as { mcpServer?: object }).mcpServer, enabled: true },
        } as never,
      });

      let servers = structuredClone(initialServers);
      let currentTask = structuredClone(sampleTask);
      const entries: AgentEntry[] = [
        { type: "user", text: "Can you check why p95 latency spiked on /v1/token?", attachments: [] },
        {
          type: "agent",
          text: "I inspected the token endpoint traces and local Postgres pool configuration. Ready for follow-up.",
        },
      ];

      const handlers = window.__ipc.handlers;
      handlers.agent_subscribe = () => [currentTask];
      handlers.agent_providers = () => [copilotProvider];
      handlers.agent_refresh_models = () => ({
        provider: copilotProvider.id,
        config: copilotProvider.config,
        thoughtLevels: {},
        refreshing: false,
        refreshedAtMs: Date.now(),
        retryAtMs: null,
        error: null,
      });
      handlers.agent_probe = () => null;
      handlers.agent_commands = () => [];
      handlers.agent_entries = () => entries;
      handlers.agent_changes = () => [];
      handlers.agent_grouped_changes = () => ({ uncommitted: [], commits: [] });
      handlers.vcs_branch_info = () => ({ head: "main" });
      handlers.vcs_branches = () => [];
      handlers.agent_mcp_list = () => servers;
      handlers.agent_mcp_discover_sources = () => discoveredSources;
      handlers.agent_mcp_test = () => probeResult;
      handlers.agent_mcp_set_enabled = ({ id, enabled }) => {
        servers = servers.map((s) => (s.id === id ? { ...s, enabled: Boolean(enabled) } : s));
        return servers;
      };
      handlers.agent_mcp_import_selected = ({ scope, selections }) => {
        for (const sel of selections as Array<{ sourceId: string; name: string }>) {
          const src = discoveredSources.find((d) => d.id === sel.sourceId);
          const srv = src?.servers.find((d) => d.name === sel.name);
          if (!srv) continue;
          const id = `${String(scope)}::${srv.name}`;
          if (!servers.some((s) => s.id === id)) {
            servers = [
              ...servers,
              {
                id,
                name: srv.name,
                scope: scope as "user" | "workspace",
                transport: srv.transport,
                enabled: true,
                command: srv.command,
                args: srv.args,
                env: [],
                url: srv.url,
                headers: [],
                agents: [],
                unapproved: false,
              },
            ];
          }
        }
        return servers;
      };
      handlers.agent_set_mcp_overrides = ({ overrides }) => {
        currentTask = { ...currentTask, mcpOverrides: overrides as Record<string, boolean> };
        return currentTask;
      };

      await store.connect();
      store.openTask(currentTask.id);
    },
    { copilotProvider, sampleTask, initialServers, discoveredSources, probeResult },
  );

  // 1. Open per-session MCP picker via `/mcp` in the active session composer.
  const composerBox = page.getByRole("textbox", { name: "Message" });
  await expect(composerBox).toBeVisible();
  await composerBox.click();
  await page.keyboard.type("/mc");
  await expect(page.getByRole("listbox", { name: "Commands" })).toContainText("/mcp");
  await page.keyboard.press("Enter");

  const sessionPopup = page.getByRole("dialog", { name: "Session MCP Servers" });
  await expect(sessionPopup).toBeVisible();
  await expect(sessionPopup).toContainText("openidea");
  await expect(sessionPopup).toContainText("postgres-local");
  await expect(sessionPopup).toContainText("github-mcp-server");
  await expect(sessionPopup).toContainText("playwright");

  // Disable `slack-official` (Global) and `playwright` (Agent Config) for this session only.
  await sessionPopup.getByRole("switch", { name: "Enable slack-official for this session" }).click();
  await sessionPopup.getByRole("switch", { name: "Enable playwright for this session" }).click();
  await expect(sessionPopup).toContainText("Disabled for this session (GitHub Copilot CLI)");
  const overrideCalls = await ipcCalls(page, "agent_set_mcp_overrides");
  expect(overrideCalls.at(-1)?.overrides).toEqual({ "slack-official": false, playwright: false });

  const screenshotDir = process.env.CAPTURE_MCP_SCREENSHOTS;
  if (screenshotDir) {
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${screenshotDir}/mcp-session-picker.png` });
  }

  await sessionPopup.getByRole("button", { name: "Reset" }).click();
  await expect(sessionPopup.getByRole("button", { name: "Reset" })).toHaveCount(0);

  // 2. Jump directly from the session MCP popover's gear button to Settings › Agents › MCP Connections.
  await sessionPopup.getByRole("button", { name: "MCP Connections…", exact: true }).click();
  const settingsDialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settingsDialog).toBeVisible();
  await expect(settingsDialog.getByRole("heading", { name: "MCP Connections", exact: true })).toBeVisible();
  await expect(settingsDialog.getByRole("treeitem", { name: "MCP Connections", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // Probe `github-mcp-server` and inspect discovered tools inside the expandable card.
  await settingsDialog.getByRole("button", { name: "Test github-mcp-server" }).click();
  await expect(settingsDialog.getByText("Tools (3)")).toBeVisible();
  await expect(settingsDialog.getByText("pull_request_read")).toBeVisible();

  if (screenshotDir) {
    await settingsDialog
      .getByRole("heading", { name: "MCP Connections", exact: true })
      .evaluate((el) => el.scrollIntoView({ block: "start" }));
    await settingsDialog.screenshot({ path: `${screenshotDir}/mcp-hub-levels.png` });
    await settingsDialog.getByRole("button", { name: "Add from JSON" }).click();
    const addDialog = page.getByRole("dialog", { name: "Add MCP Server" });
    await expect(addDialog).toBeVisible();
    await addDialog.screenshot({ path: `${screenshotDir}/mcp-hub-add-json.png` });
    await addDialog.getByRole("button", { name: "Cancel" }).click();
  }

  // Switch to `Agent Configs` tab and verify discovered Copilot CLI + JetBrains Air configs.
  await settingsDialog.getByRole("tab", { name: /Agent Configs/ }).click();
  await expect(settingsDialog.getByText("GitHub Copilot CLI")).toBeVisible();
  await expect(settingsDialog.getByText("JetBrains Air")).toBeVisible();

  if (screenshotDir) {
    await settingsDialog.screenshot({ path: `${screenshotDir}/mcp-hub-agent-configs.png` });
  }

  await settingsDialog.getByRole("checkbox", { name: "Select linear" }).click();
  await settingsDialog.getByRole("button", { name: "Import Selected (1)" }).click();
  await expect(settingsDialog.getByText("Imported 1 MCP servers into Global settings.")).toBeVisible();
});
