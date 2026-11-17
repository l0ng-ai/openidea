/**
 * Settings › Agents › External MCP Servers: multi-level MCP management across Global (`settings.toml`
 * + Keychain), Project (`.openidea/settings.toml`), and Agent CLI config directories
 * (`~/.copilot/mcp-config.json`, `~/.claude.json`, `~/.codex/config.toml`, `~/.cursor/mcp.json`,
 * `~/.gemini/settings.json`, `~/.jetbrains/mcp/mcp.json`, `.mcp.json`, `.vscode/mcp.json`), with
 * Cline-inspired expandable server cards, live tool probing, and Form / JSON configuration.
 */
import clsx from "clsx";
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type {
  McpDiscoveredServer,
  McpExternalSource,
  McpImportSelection,
  McpKeyValue,
  McpProbeResult,
  McpScope,
  McpServer,
  McpServerInput,
  McpTransport,
} from "@/bindings";
import { executeAction } from "@/platform/actions";
import { formatMessage, useTx } from "@/platform/i18n";
import { openExternalUrl } from "@/platform/openUrl";
import { useProject } from "@/platform/project";
import {
  Button,
  Checkbox,
  Dialog,
  Icon,
  IconButton,
  Input,
  Menu,
  SearchField,
  Select,
  Spinner,
  T,
  Tabs,
  Toggle,
  copyText,
  type MenuItem,
} from "@/ui";
import { IDE_MCP_SETTINGS_PAGE, defaultMcpBackend, useMcpCatalog, type McpBackend } from "./mcpModel";
import { providerIcon } from "./model";
import { useAgents } from "./store";
import styles from "./McpServers.module.css";

export { defaultMcpBackend, type McpBackend };

const MCP_DOCS_URL = "https://modelcontextprotocol.io";
const MCP_BROWSE_URL = "https://github.com/modelcontextprotocol/servers";

type LevelTab = "all" | "user" | "workspace" | "discovered";

interface SectionSpec {
  scope: McpScope;
  title: string;
  hint: string;
}

const SECTIONS: readonly SectionSpec[] = [
  { scope: "user", title: "User", hint: "Shared across projects · secrets stored in Keychain" },
  { scope: "workspace", title: "Workspace", hint: ".openidea/settings.toml · overrides Global by name" },
];

const KNOWN_AGENTS: ReadonlyArray<{ id: string; name: string }> = [
  { id: "copilot", name: "GitHub Copilot" },
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "cursor", name: "Cursor" },
  { id: "gemini", name: "Gemini CLI" },
  { id: "opencode", name: "OpenCode" },
];

function formatKeyValues(items: readonly McpKeyValue[]): string {
  return items.map(({ name, value }) => `${name}=${value}`).join("\n");
}

function parseKeyValues(text: string): McpKeyValue[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const eq = line.indexOf("=");
      const colon = line.indexOf(":");
      const idx = eq >= 0 && (colon < 0 || eq < colon) ? eq : colon;
      if (idx < 0) return { name: line, value: "" };
      return {
        name: line.slice(0, idx).trim(),
        value: line.slice(idx + 1).trim(),
      };
    })
    .filter((kv) => kv.name.length > 0);
}

function parseArgs(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) out.push(current);
  return out;
}

function parseAgents(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(/[,\s]+/)) {
    const trimmed = part.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

function serverEndpoint(server: Pick<McpServer, "transport" | "command" | "args" | "url">): string {
  return server.transport === "stdio"
    ? [server.command, ...server.args].filter(Boolean).join(" ")
    : `${server.transport.toUpperCase()} · ${server.url ?? ""}`;
}

function serverSummary(server: McpServer): string {
  const endpoint = serverEndpoint(server);
  const agents = server.agents ?? [];
  if (agents.length === 0) return endpoint;
  return endpoint ? `${endpoint} (${agents.join(", ")})` : agents.join(", ");
}

function serializeServerToJson(server?: McpServer): string {
  if (!server) {
    return JSON.stringify(
      {
        mcpServers: {
          "my-mcp-server": {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
          },
        },
      },
      null,
      2,
    );
  }
  const entry: Record<string, unknown> =
    server.transport === "stdio"
      ? {
          type: "stdio",
          command: server.command ?? "",
          ...(server.args.length > 0 ? { args: server.args } : {}),
          ...(server.env.length > 0 ? { env: Object.fromEntries(server.env.map((kv) => [kv.name, kv.value])) } : {}),
        }
      : {
          type: server.transport,
          url: server.url ?? "",
          ...(server.headers.length > 0
            ? { headers: Object.fromEntries(server.headers.map((kv) => [kv.name, kv.value])) }
            : {}),
        };
  if (!server.enabled) entry.disabled = true;
  if ((server.agents ?? []).length > 0) entry.agents = server.agents;
  return JSON.stringify({ mcpServers: { [server.name]: entry } }, null, 2);
}

export function McpServersPage({ backend = defaultMcpBackend }: { backend?: McpBackend }) {
  const tx = useTx();
  const ideMcpEnabled = useProject((s) => s.settings?.mcpServer?.enabled ?? false);
  const hasProject = useProject((s) => !!s.project?.root);
  const providers = useAgents((s) => s.providers);
  const [tab, setTab] = useState<LevelTab>("all");
  const [servers, setServers] = useState<McpServer[]>([]);
  const [sources, setSources] = useState<McpExternalSource[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [probes, setProbes] = useState<Record<string, McpProbeResult>>({});
  const [probing, setProbing] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState<Record<McpScope, boolean>>({
    user: false,
    workspace: false,
  });
  const [selectedImports, setSelectedImports] = useState<Record<string, boolean>>({});
  const [importScope, setImportScope] = useState<McpScope>("user");
  const [overwriteExisting, setOverwriteExisting] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<{ server: McpServer; el: HTMLElement } | null>(null);
  const [editing, setEditing] = useState<{
    mode: "add" | "edit";
    editorTab?: "form" | "json";
    scope: McpScope;
    server?: McpServer;
  } | null>(null);

  const syncCatalog = useCallback(
    (nextServers: McpServer[], nextSources?: McpExternalSource[]) => {
      setServers(nextServers);
      if (backend === defaultMcpBackend) {
        useMcpCatalog.setState((prev) => ({
          servers: nextServers,
          sources: nextSources ?? prev.sources,
          loaded: true,
        }));
      }
    },
    [backend],
  );

  const load = useCallback(() => {
    Promise.all([
      backend.list(),
      backend.discoverSources ? backend.discoverSources().catch(() => [] as McpExternalSource[]) : Promise.resolve([]),
    ])
      .then(([list, discovered]) => {
        setSources(discovered);
        syncCatalog(list, discovered);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [backend, syncCatalog]);

  useEffect(() => {
    load();
  }, [load]);

  const userServerNames = useMemo(
    () => new Set(servers.filter((s) => s.scope === "user").map((s) => s.name)),
    [servers],
  );
  const workspaceServerNames = useMemo(
    () => new Set(servers.filter((s) => s.scope === "workspace").map((s) => s.name)),
    [servers],
  );

  const unimportedCount = useMemo(() => {
    let count = 0;
    for (const src of sources) {
      for (const srv of src.servers) {
        if (!userServerNames.has(srv.name) && !workspaceServerNames.has(srv.name)) count += 1;
      }
    }
    return count;
  }, [sources, userServerNames, workspaceServerNames]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return servers;
    return servers.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.command ?? "").toLowerCase().includes(q) ||
        (s.url ?? "").toLowerCase().includes(q) ||
        (s.agents ?? []).some((a) => a.toLowerCase().includes(q)),
    );
  }, [servers, query]);

  const filteredSources = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sources;
    return sources
      .map((src) => ({
        ...src,
        servers: src.servers.filter(
          (s) =>
            src.label.toLowerCase().includes(q) ||
            s.name.toLowerCase().includes(q) ||
            (s.command ?? "").toLowerCase().includes(q) ||
            (s.url ?? "").toLowerCase().includes(q),
        ),
      }))
      .filter((src) => src.servers.length > 0);
  }, [sources, query]);

  const grouped = useMemo(() => {
    const map: Record<McpScope, McpServer[]> = {
      user: [],
      workspace: [],
    };
    for (const s of filtered) {
      map[s.scope]?.push(s);
    }
    return map;
  }, [filtered]);

  const agentOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of KNOWN_AGENTS) map.set(a.id, a.name);
    for (const p of providers) {
      const norm = p.id.endsWith("-acp") ? p.id.slice(0, -4) : p.id;
      if (!map.has(norm)) map.set(norm, p.name);
    }
    return [...map.entries()].map(([id, name]) => ({ id, name }));
  }, [providers]);

  const toggleServer = async (server: McpServer, enabled: boolean) => {
    setBusyId(server.id);
    setError(null);
    setServers((prev) => prev.map((s) => (s.id === server.id ? { ...s, enabled, unapproved: false } : s)));
    try {
      const next = await backend.setEnabled(server.id, enabled);
      syncCatalog(next);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      load();
    } finally {
      setBusyId(null);
    }
  };

  const removeServer = async (server: McpServer) => {
    setBusyId(server.id);
    setError(null);
    try {
      const next = await backend.remove(server.id);
      syncCatalog(next);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const probeServer = async (server: McpServer) => {
    if (!backend.testServer) return;
    setProbing((prev) => ({ ...prev, [server.id]: true }));
    setExpanded((prev) => ({ ...prev, [server.id]: true }));
    setError(null);
    try {
      const result = await backend.testServer(server.id);
      setProbes((prev) => ({ ...prev, [server.id]: result }));
    } catch (e: unknown) {
      setProbes((prev) => ({
        ...prev,
        [server.id]: {
          ok: false,
          serverName: null,
          serverVersion: null,
          protocolVersion: null,
          tools: [],
          durationMs: 0,
          error: e instanceof Error ? e.message : String(e),
        },
      }));
    } finally {
      setProbing((prev) => ({ ...prev, [server.id]: false }));
    }
  };

  const copyServerToScope = async (server: McpServer, targetScope: McpScope) => {
    setBusyId(server.id);
    setError(null);
    try {
      const next = await backend.save({
        id: null,
        scope: targetScope,
        name: server.name,
        transport: server.transport,
        enabled: true,
        command: server.command,
        args: server.args,
        env: server.env,
        url: server.url,
        headers: server.headers,
        agents: server.agents,
      });
      syncCatalog(next);
      setNotice(
        formatMessage(
          tx(targetScope === "user" ? "Copied {name} to Global MCP servers." : "Copied {name} to Project MCP servers."),
          { name: server.name },
        ),
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const importFromProject = async () => {
    setImporting(true);
    setError(null);
    setNotice(null);
    try {
      const before = servers.filter((s) => s.scope === "workspace").length;
      const next = await backend.importWorkspace();
      syncCatalog(next);
      const added = next.filter((s) => s.scope === "workspace").length - before;
      setNotice(
        added === 0
          ? tx("No new MCP servers in the project's .mcp.json or .vscode/mcp.json.")
          : added === 1
            ? tx("Imported 1 MCP server from the project.")
            : formatMessage(tx("Imported {count} MCP servers from the project."), { count: added }),
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  const importSelections = async (selections: McpImportSelection[], scope: McpScope, overwrite = overwriteExisting) => {
    if (!backend.importSelected || selections.length === 0) return;
    setImporting(true);
    setError(null);
    setNotice(null);
    try {
      const beforeCount = servers.filter((s) => s.scope === scope).length;
      const next = await backend.importSelected(scope, selections, overwrite);
      syncCatalog(next);
      const delta = Math.max(0, next.filter((s) => s.scope === scope).length - beforeCount);
      const count = overwrite ? selections.length : delta;
      setSelectedImports({});
      setNotice(
        count === 0
          ? tx("Selected MCP servers are already configured in that scope.")
          : formatMessage(
              tx(
                scope === "user"
                  ? "Imported {count} MCP servers into Global settings."
                  : "Imported {count} MCP servers into Project settings.",
              ),
              { count },
            ),
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  const menuItems = (server: McpServer): MenuItem[] => {
    const otherScope: McpScope = server.scope === "user" ? "workspace" : "user";
    return [
      {
        label: server.enabled ? tx("Disable Server") : tx("Enable Server"),
        run: () => void toggleServer(server, !server.enabled),
      },
      ...(backend.testServer
        ? [
            {
              label: tx("Test Connection"),
              run: () => void probeServer(server),
            },
          ]
        : []),
      {
        label: tx("Configure…"),
        run: () =>
          setEditing({
            mode: "edit",
            editorTab: "form",
            scope: server.scope,
            server,
          }),
      },
      ...(backend.saveJson
        ? [
            {
              label: tx("Edit as JSON…"),
              run: () =>
                setEditing({
                  mode: "edit",
                  editorTab: "json",
                  scope: server.scope,
                  server,
                }),
            },
          ]
        : []),
      ...(otherScope === "user" || hasProject
        ? [
            {
              label: otherScope === "user" ? tx("Copy to Global") : tx("Copy to Project"),
              run: () => void copyServerToScope(server, otherScope),
            },
          ]
        : []),
      {
        label: tx("Copy Server Name"),
        run: () => void copyText(server.name),
      },
      { kind: "separator" as const },
      {
        label: tx("Delete Server"),
        danger: true,
        run: () => void removeServer(server),
      },
    ];
  };

  const visibleScopes = useMemo(() => {
    if (tab === "user") return SECTIONS.filter((s) => s.scope === "user");
    if (tab === "workspace") return SECTIONS.filter((s) => s.scope === "workspace");
    if (tab === "all") return SECTIONS;
    return [];
  }, [tab]);

  const selectedImportList = useMemo(() => {
    const out: McpImportSelection[] = [];
    for (const src of sources) {
      for (const srv of src.servers) {
        if (selectedImports[`${src.id}::${srv.name}`]) {
          out.push({ sourceId: src.id, name: srv.name });
        }
      }
    }
    return out;
  }, [sources, selectedImports]);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h2 className={styles.title}>
          <T>External MCP Servers</T>
        </h2>
        <div className={styles.headerActions}>
          <Button
            variant="primary"
            onClick={() =>
              setEditing({
                mode: "add",
                editorTab: "form",
                scope: tab === "workspace" ? "workspace" : "user",
              })
            }
          >
            <Icon name="plus" size={14} /> <T>Add Server</T>
          </Button>
          {backend.saveJson && (
            <Button
              variant="secondary"
              onClick={() =>
                setEditing({
                  mode: "add",
                  editorTab: "json",
                  scope: tab === "workspace" ? "workspace" : "user",
                })
              }
            >
              <Icon name="file-json" size={14} /> <T>Add from JSON</T>
            </Button>
          )}
          <Button
            variant="secondary"
            disabled={importing}
            title={tx("Import MCP servers from .mcp.json and .vscode/mcp.json")}
            onClick={() => void importFromProject()}
          >
            <T>Import from Project</T>
          </Button>
          <Button variant="secondary" onClick={() => void openExternalUrl(MCP_BROWSE_URL)}>
            <Icon name="web" size={14} /> <T>Browse</T>
          </Button>
        </div>
      </div>

      <p className={styles.lead}>
        <T>
          An open standard that lets AI use external tools and services. MCP servers provide tools for file operations,
          databases, APIs, and more.
        </T>{" "}
        <button type="button" className={styles.link} onClick={() => void openExternalUrl(MCP_DOCS_URL)}>
          <T>Learn more about MCP servers</T>
        </button>
      </p>

      <div className={styles.topControls}>
        <div className={styles.tabBar}>
          <Tabs
            variant="compact"
            aria-label={tx("MCP configuration levels")}
            activeId={tab}
            onSelect={(id) => setTab(id as LevelTab)}
            items={[
              {
                id: "all",
                label: tx("All Levels"),
                text: tx("All Levels"),
                trailing: <span className={styles.badge}>{servers.length}</span>,
              },
              {
                id: "user",
                label: tx("Global"),
                text: tx("Global"),
                trailing: <span className={styles.badge}>{servers.filter((s) => s.scope === "user").length}</span>,
              },
              {
                id: "workspace",
                label: tx("Project"),
                text: tx("Project"),
                trailing: <span className={styles.badge}>{servers.filter((s) => s.scope === "workspace").length}</span>,
              },
              {
                id: "discovered",
                label: tx("Agent Configs"),
                text: tx("Agent Configs"),
                trailing:
                  sources.length > 0 ? (
                    <span className={clsx(styles.badge, unimportedCount > 0 && styles.tagAccent)}>
                      {unimportedCount > 0 ? unimportedCount : sources.reduce((n, s) => n + s.servers.length, 0)}
                    </span>
                  ) : undefined,
              },
            ]}
          />
        </div>

        <SearchField
          className={styles.search}
          value={query}
          onChange={setQuery}
          placeholder={tx("Type to search...")}
          aria-label={tx("Search MCP servers")}
        />
      </div>

      {error && (
        <div className={styles.error} role="alert">
          <Icon name="error" size={14} />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className={styles.notice} role="status">
          <span className={styles.noticeMain}>
            <Icon name="info" size={14} />
            <span>{notice}</span>
          </span>
          <IconButton icon="close" size="small" title={tx("Dismiss")} onClick={() => setNotice(null)} />
        </div>
      )}

      {tab === "all" && (
        <div className={styles.builtinCard}>
          <div className={styles.builtinMain}>
            <div className={styles.builtinHeader}>
              <span className={clsx(styles.statusDot, ideMcpEnabled && styles.statusOn)} aria-hidden />
              <span className={styles.serverName}>openidea</span>
              <span className={styles.tag}>
                <T>Built-in IDE</T>
              </span>
              <span className={styles.tag}>
                <T>All agents</T>
              </span>
            </div>
            <span className={styles.hint}>
              <T>
                Exposes OpenIDEA's code intelligence, diagnostics, refactorings, and run configurations to coding
                agents. Can also be toggled per session from the composer MCP menu.
              </T>
            </span>
          </div>
          <Button variant="secondary" onClick={() => void executeAction("file.settings", IDE_MCP_SETTINGS_PAGE)}>
            <Icon name="settings" size={13} /> <T>IDE MCP Settings</T>
          </Button>
        </div>
      )}

      {visibleScopes.length > 0 && (
        <div className={styles.sections}>
          {visibleScopes.map(({ scope, title, hint }) => {
            const items = grouped[scope];
            const isCollapsed = collapsed[scope];
            return (
              <section key={scope} className={styles.section} aria-label={tx(title)}>
                <div className={styles.sectionBar}>
                  <button
                    type="button"
                    className={styles.sectionToggle}
                    aria-expanded={!isCollapsed}
                    onClick={() => setCollapsed((prev) => ({ ...prev, [scope]: !prev[scope] }))}
                  >
                    <Icon name={isCollapsed ? "chevron-right" : "chevron-down"} size={14} className={styles.chevron} />
                    <span className={styles.sectionTitle}>
                      <T>{title}</T>
                    </span>
                    <span className={styles.badge}>{items.length}</span>
                    <span className={styles.sectionHint}>{tx(hint)}</span>
                  </button>
                  <IconButton
                    icon="plus"
                    size="small"
                    title={scope === "workspace" ? tx("Add Workspace MCP Server") : tx("Add User MCP Server")}
                    aria-label={scope === "workspace" ? tx("Add Workspace MCP Server") : tx("Add User MCP Server")}
                    onClick={() =>
                      setEditing({
                        mode: "add",
                        editorTab: "form",
                        scope,
                      })
                    }
                  />
                </div>

                {!isCollapsed && scope === "workspace" && (
                  <p className={styles.sectionNote}>
                    <T>
                      Servers added to the project's settings file outside OpenIDEA stay off until you turn them on
                      here.
                    </T>
                  </p>
                )}

                {!isCollapsed && items.length > 0 && (
                  <div className={styles.sectionBody} role="list">
                    {items.map((server) => {
                      const summary = serverSummary(server);
                      const isExpanded = !!expanded[server.id];
                      const isProbing = !!probing[server.id];
                      const probe = probes[server.id];
                      const shadowsGlobal = scope === "workspace" && userServerNames.has(server.name);
                      const shadowedByProject = scope === "user" && workspaceServerNames.has(server.name);
                      return (
                        <div key={server.id} role="listitem" className={styles.card}>
                          <div className={styles.cardHeader}>
                            <button
                              type="button"
                              className={styles.cardExpandBtn}
                              aria-expanded={isExpanded}
                              onClick={() => setExpanded((prev) => ({ ...prev, [server.id]: !prev[server.id] }))}
                            >
                              <Icon
                                name={isExpanded ? "chevron-down" : "chevron-right"}
                                size={13}
                                className={styles.chevron}
                              />
                              <div className={styles.cardMain}>
                                <div className={styles.cardTitleRow}>
                                  <span className={styles.serverName}>{server.name}</span>
                                  <span className={styles.tag}>{server.transport.toUpperCase()}</span>
                                  {shadowsGlobal && (
                                    <span className={clsx(styles.tag, styles.tagAccent)}>
                                      <T>Overrides Global</T>
                                    </span>
                                  )}
                                  {shadowedByProject && (
                                    <span className={styles.tag}>
                                      <T>Overridden by Project</T>
                                    </span>
                                  )}
                                  {server.unapproved && (
                                    <span className={clsx(styles.tag, styles.tagWarning)}>
                                      <T>Needs Approval</T>
                                    </span>
                                  )}
                                  {(server.agents ?? []).length === 0 ? (
                                    <span className={styles.tag}>
                                      <T>All agents</T>
                                    </span>
                                  ) : (
                                    (server.agents ?? []).map((agentId) => (
                                      <span key={agentId} className={styles.tag}>
                                        <Icon name={providerIcon(agentId)} size={11} />
                                        {agentId}
                                      </span>
                                    ))
                                  )}
                                  {probe?.ok && (
                                    <span className={clsx(styles.tag, styles.tagSuccess)}>
                                      {formatMessage(tx("{count} MCP tools"), { count: probe.tools.length })}
                                    </span>
                                  )}
                                </div>
                                {summary && (
                                  <span className={styles.subtitle} title={summary}>
                                    {summary}
                                  </span>
                                )}
                              </div>
                            </button>

                            <div className={styles.rowActions}>
                              {backend.testServer && (
                                <IconButton
                                  icon="refresh"
                                  size="small"
                                  disabled={isProbing || server.unapproved}
                                  title={tx`Test ${server.name}`}
                                  aria-label={tx`Test ${server.name}`}
                                  onClick={() => void probeServer(server)}
                                />
                              )}
                              <Toggle
                                checked={server.enabled}
                                aria-label={tx`Enable ${server.name}`}
                                disabled={busyId === server.id}
                                onChange={(on) => void toggleServer(server, on)}
                              />
                              <span
                                className={clsx(
                                  styles.statusDot,
                                  isProbing
                                    ? styles.statusProbing
                                    : probe && !probe.ok
                                      ? styles.statusError
                                      : server.enabled && styles.statusOn,
                                )}
                                title={
                                  isProbing
                                    ? tx("Testing connection…")
                                    : probe && !probe.ok
                                      ? (probe.error ?? tx("Connection failed"))
                                      : server.enabled
                                        ? tx("Enabled")
                                        : tx("Disabled")
                                }
                              />
                              <IconButton
                                icon="more"
                                size="small"
                                title={tx`More actions for ${server.name}`}
                                aria-label={tx`More actions for ${server.name}`}
                                onClick={(e) => setMenuAnchor({ server, el: e.currentTarget })}
                              />
                            </div>
                          </div>

                          {isExpanded && (
                            <div className={styles.cardDrawer}>
                              <div className={styles.metaGrid}>
                                {server.transport === "stdio" ? (
                                  <>
                                    <span className={styles.metaLabel}>
                                      <T>Command</T>
                                    </span>
                                    <span className={styles.metaValue}>
                                      {[server.command, ...server.args].filter(Boolean).join(" ")}
                                    </span>
                                    {server.env.length > 0 && (
                                      <>
                                        <span className={styles.metaLabel}>
                                          <T>Env vars</T>
                                        </span>
                                        <span className={styles.metaValue}>
                                          {server.env.map((kv) => `${kv.name}=•••`).join(", ")}
                                        </span>
                                      </>
                                    )}
                                  </>
                                ) : (
                                  <>
                                    <span className={styles.metaLabel}>
                                      <T>Endpoint</T>
                                    </span>
                                    <span className={styles.metaValue}>{server.url}</span>
                                    {server.headers.length > 0 && (
                                      <>
                                        <span className={styles.metaLabel}>
                                          <T>Headers</T>
                                        </span>
                                        <span className={styles.metaValue}>
                                          {server.headers.map((kv) => `${kv.name}: •••`).join(", ")}
                                        </span>
                                      </>
                                    )}
                                  </>
                                )}
                              </div>

                              {backend.testServer && (
                                <div className={styles.toolsPanel}>
                                  <div className={styles.toolsHeader}>
                                    <span>
                                      {probe?.ok
                                        ? formatMessage(tx("Tools ({count})"), { count: probe.tools.length })
                                        : tx("Tools & Connection")}
                                    </span>
                                    {probe?.ok && (
                                      <span className={styles.toolsMeta}>
                                        {[
                                          probe.serverName,
                                          probe.serverVersion ? `v${probe.serverVersion}` : null,
                                          `${probe.durationMs} ms`,
                                        ]
                                          .filter(Boolean)
                                          .join(" · ")}
                                      </span>
                                    )}
                                  </div>

                                  {isProbing ? (
                                    <div className={styles.hint}>
                                      <Spinner size={12} /> <T>Connecting and listing tools…</T>
                                    </div>
                                  ) : probe ? (
                                    probe.ok ? (
                                      probe.tools.length > 0 ? (
                                        <div className={styles.toolsList}>
                                          {probe.tools.map((tool) => (
                                            <div key={tool.name} className={styles.toolRow}>
                                              <span className={styles.toolName}>{tool.name}</span>
                                              {tool.description && (
                                                <span className={styles.toolDesc}>{tool.description}</span>
                                              )}
                                            </div>
                                          ))}
                                        </div>
                                      ) : (
                                        <span className={styles.hint}>
                                          <T>Connected, no tools advertised by this server.</T>
                                        </span>
                                      )
                                    ) : (
                                      <div className={styles.error} role="alert">
                                        <Icon name="error" size={14} />
                                        <span>{probe.error ?? tx("Connection failed")}</span>
                                      </div>
                                    )
                                  ) : (
                                    <span className={styles.hint}>
                                      <T>Click Test Connection to run MCP handshake and inspect available tools.</T>
                                    </span>
                                  )}
                                </div>
                              )}

                              <div className={styles.drawerFooter}>
                                <div className={styles.drawerButtons}>
                                  <Button
                                    variant="secondary"
                                    onClick={() =>
                                      setEditing({
                                        mode: "edit",
                                        editorTab: "form",
                                        scope: server.scope,
                                        server,
                                      })
                                    }
                                  >
                                    <Icon name="edit" size={12} /> <T>Configure…</T>
                                  </Button>
                                  {backend.testServer && (
                                    <Button
                                      variant="secondary"
                                      disabled={isProbing || server.unapproved}
                                      onClick={() => void probeServer(server)}
                                    >
                                      <Icon name="refresh" size={12} />{" "}
                                      <T>{probe && !probe.ok ? "Retry Connection" : "Test Connection"}</T>
                                    </Button>
                                  )}
                                </div>
                                <Button variant="ghost" onClick={() => void removeServer(server)}>
                                  <Icon name="trash" size={12} /> <T>Delete Server</T>
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}

          {tab === "all" && unimportedCount > 0 && (
            <div className={styles.notice}>
              <span className={styles.noticeMain}>
                <Icon name="plugin" size={14} />
                <span>
                  {formatMessage(tx("Detected {count} MCP servers in external agent config directories ({sources})."), {
                    count: unimportedCount,
                    sources: sources.map((s) => s.label).join(", "),
                  })}
                </span>
              </span>
              <Button variant="secondary" onClick={() => setTab("discovered")}>
                <T>Review & Import</T>
              </Button>
            </div>
          )}
        </div>
      )}

      {tab === "discovered" && (
        <DiscoveredSourcesView
          sources={filteredSources}
          userServerNames={userServerNames}
          workspaceServerNames={workspaceServerNames}
          hasProject={hasProject}
          selected={selectedImports}
          onSelectChange={setSelectedImports}
          importScope={importScope}
          onImportScopeChange={setImportScope}
          overwrite={overwriteExisting}
          onOverwriteChange={setOverwriteExisting}
          importing={importing}
          onRefresh={load}
          onImportSelected={() => void importSelections(selectedImportList, importScope, overwriteExisting)}
          onQuickImport={(sourceId, name, scope) => void importSelections([{ sourceId, name }], scope, true)}
        />
      )}

      {menuAnchor && (
        <Menu
          open
          anchor={menuAnchor.el}
          placement="bottom-end"
          onClose={() => setMenuAnchor(null)}
          items={menuItems(menuAnchor.server)}
          aria-label={tx`Actions for ${menuAnchor.server.name}`}
        />
      )}

      {editing && (
        <McpServerModal
          backend={backend}
          mode={editing.mode}
          initialEditorTab={editing.editorTab ?? "form"}
          initialScope={editing.scope}
          server={editing.server}
          agentOptions={agentOptions}
          onClose={() => setEditing(null)}
          onSaved={(next) => {
            syncCatalog(next);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function DiscoveredSourcesView({
  sources,
  userServerNames,
  workspaceServerNames,
  hasProject,
  selected,
  onSelectChange,
  importScope,
  onImportScopeChange,
  overwrite,
  onOverwriteChange,
  importing,
  onRefresh,
  onImportSelected,
  onQuickImport,
}: {
  sources: readonly McpExternalSource[];
  userServerNames: ReadonlySet<string>;
  workspaceServerNames: ReadonlySet<string>;
  hasProject: boolean;
  selected: Record<string, boolean>;
  onSelectChange: (next: Record<string, boolean>) => void;
  importScope: McpScope;
  onImportScopeChange: (scope: McpScope) => void;
  overwrite: boolean;
  onOverwriteChange: (overwrite: boolean) => void;
  importing: boolean;
  onRefresh: () => void;
  onImportSelected: () => void;
  onQuickImport: (sourceId: string, name: string, scope: McpScope) => void;
}) {
  const tx = useTx();
  const selectedCount = Object.values(selected).filter(Boolean).length;

  return (
    <div className={styles.sections}>
      <div className={styles.importToolbar}>
        <div className={styles.importControls}>
          <Select
            aria-label={tx("Import target scope")}
            value={importScope}
            options={[
              { value: "user", label: tx("Import into Global (settings.toml)") },
              ...(hasProject
                ? [{ value: "workspace", label: tx("Import into Project (.openidea/settings.toml)") }]
                : []),
            ]}
            onChange={(v) => onImportScopeChange(v as McpScope)}
          />
          <Checkbox checked={overwrite} label={tx("Overwrite existing")} onChange={onOverwriteChange} />
        </div>
        <div className={styles.importControls}>
          <Button variant="secondary" onClick={onRefresh}>
            <Icon name="refresh" size={13} /> <T>Rescan</T>
          </Button>
          <Button variant="primary" disabled={selectedCount === 0 || importing} onClick={onImportSelected}>
            {selectedCount > 0
              ? formatMessage(tx("Import Selected ({count})"), { count: selectedCount })
              : tx("Import Selected")}
          </Button>
        </div>
      </div>

      {sources.length === 0 ? (
        <div className={styles.emptyBox}>
          <T>
            No external MCP configuration files found in ~/.copilot, ~/.claude.json, ~/.codex, ~/.cursor, ~/.gemini,
            ~/.jetbrains/mcp, or the current project.
          </T>
        </div>
      ) : (
        sources.map((source) => (
          <div key={source.id} className={styles.sourceCard}>
            <div className={styles.sourceHeader}>
              <div className={styles.sourceTitleGroup}>
                <div className={styles.sourceTitleRow}>
                  <Icon name={source.nativeProvider ? providerIcon(source.nativeProvider) : "plugin"} size={14} />
                  <span>{source.label}</span>
                  <span className={styles.badge}>{source.servers.length}</span>
                  {source.nativeProvider && (
                    <span className={styles.tag}>
                      {formatMessage(tx("Native to {agent}"), { agent: source.nativeProvider })}
                    </span>
                  )}
                </div>
                <span className={styles.sourcePath} title={source.path}>
                  {source.path}
                </span>
              </div>
              <Button
                variant="secondary"
                disabled={importing}
                onClick={() => {
                  const next = { ...selected };
                  const allChecked = source.servers.every((s) => !!next[`${source.id}::${s.name}`]);
                  for (const s of source.servers) {
                    next[`${source.id}::${s.name}`] = !allChecked;
                  }
                  onSelectChange(next);
                }}
              >
                <T>Select All</T>
              </Button>
            </div>

            <div className={styles.discoveredList}>
              {source.servers.map((srv) => {
                const key = `${source.id}::${srv.name}`;
                const inGlobal = userServerNames.has(srv.name);
                const inProject = workspaceServerNames.has(srv.name);
                return (
                  <DiscoveredServerRow
                    key={key}
                    srv={srv}
                    checked={!!selected[key]}
                    inGlobal={inGlobal}
                    inProject={inProject}
                    hasProject={hasProject}
                    importing={importing}
                    onCheck={(on) => onSelectChange({ ...selected, [key]: on })}
                    onQuickImport={(scope) => onQuickImport(source.id, srv.name, scope)}
                  />
                );
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function DiscoveredServerRow({
  srv,
  checked,
  inGlobal,
  inProject,
  hasProject,
  importing,
  onCheck,
  onQuickImport,
}: {
  srv: McpDiscoveredServer;
  checked: boolean;
  inGlobal: boolean;
  inProject: boolean;
  hasProject: boolean;
  importing: boolean;
  onCheck: (checked: boolean) => void;
  onQuickImport: (scope: McpScope) => void;
}) {
  const tx = useTx();
  const endpoint = serverEndpoint(srv);
  return (
    <div className={styles.discoveredRow}>
      <div className={styles.discoveredMain}>
        <Checkbox checked={checked} aria-label={tx`Select ${srv.name}`} onChange={onCheck} />
        <div className={styles.discoveredInfo}>
          <div className={styles.cardTitleRow}>
            <span className={styles.serverName}>{srv.name}</span>
            <span className={styles.tag}>{srv.transport.toUpperCase()}</span>
            {inGlobal && (
              <span className={clsx(styles.tag, styles.tagSuccess)}>
                <T>In Global</T>
              </span>
            )}
            {inProject && (
              <span className={clsx(styles.tag, styles.tagAccent)}>
                <T>In Project</T>
              </span>
            )}
            {srv.envKeys.length > 0 && (
              <span className={styles.tag}>{formatMessage(tx("{count} env"), { count: srv.envKeys.length })}</span>
            )}
            {srv.headerKeys.length > 0 && (
              <span className={styles.tag}>
                {formatMessage(tx("{count} headers"), { count: srv.headerKeys.length })}
              </span>
            )}
          </div>
          {endpoint && (
            <span className={styles.subtitle} title={endpoint}>
              {endpoint}
            </span>
          )}
        </div>
      </div>

      <div className={styles.rowActions}>
        {!inGlobal && (
          <Button variant="secondary" disabled={importing} onClick={() => onQuickImport("user")}>
            <Icon name="plus" size={12} /> <T>Global</T>
          </Button>
        )}
        {hasProject && !inProject && (
          <Button variant="secondary" disabled={importing} onClick={() => onQuickImport("workspace")}>
            <Icon name="plus" size={12} /> <T>Project</T>
          </Button>
        )}
      </div>
    </div>
  );
}

function McpServerModal({
  backend,
  mode,
  initialEditorTab,
  initialScope,
  server,
  agentOptions,
  onClose,
  onSaved,
}: {
  backend: McpBackend;
  mode: "add" | "edit";
  initialEditorTab: "form" | "json";
  initialScope: McpScope;
  server?: McpServer;
  agentOptions: ReadonlyArray<{ id: string; name: string }>;
  onClose: () => void;
  onSaved: (servers: McpServer[]) => void;
}) {
  const tx = useTx();
  const id = useId();
  const [editorTab, setEditorTab] = useState<"form" | "json">(backend.saveJson ? initialEditorTab : "form");
  const [name, setName] = useState(server?.name ?? "");
  const [scope, setScope] = useState<McpScope>(initialScope);
  const [transport, setTransport] = useState<McpTransport>(server?.transport ?? "stdio");
  const [command, setCommand] = useState(server?.command ?? "");
  const [argsText, setArgsText] = useState((server?.args ?? []).join(" "));
  const [envText, setEnvText] = useState(formatKeyValues(server?.env ?? []));
  const [url, setUrl] = useState(server?.url ?? "");
  const [headersText, setHeadersText] = useState(formatKeyValues(server?.headers ?? []));
  const [agentsText, setAgentsText] = useState((server?.agents ?? []).join(", "));
  const [jsonText, setJsonText] = useState(() => serializeServerToJson(server));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedAgents = useMemo(() => parseAgents(agentsText), [agentsText]);

  const toggleAgentChip = (agentId: string) => {
    const next = selectedAgents.includes(agentId)
      ? selectedAgents.filter((a) => a !== agentId)
      : [...selectedAgents, agentId];
    setAgentsText(next.join(", "));
  };

  const canSave =
    !saving &&
    (editorTab === "json"
      ? jsonText.trim().length > 0 && !!backend.saveJson
      : name.trim().length > 0 && (transport === "stdio" ? command.trim().length > 0 : url.trim().length > 0));

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      if (editorTab === "json" && backend.saveJson) {
        const next = await backend.saveJson(scope, jsonText, name.trim() || server?.name || null, selectedAgents);
        onSaved(next);
        return;
      }
      const input: McpServerInput = {
        id: server?.id ?? null,
        scope,
        name: name.trim(),
        transport,
        enabled: server?.enabled ?? true,
        command: transport === "stdio" ? command.trim() : null,
        args: transport === "stdio" ? parseArgs(argsText) : [],
        url: transport === "stdio" ? null : url.trim(),
        env: transport === "stdio" ? parseKeyValues(envText) : [],
        headers: transport === "stdio" ? [] : parseKeyValues(headersText),
        agents: selectedAgents,
      };
      const next = await backend.save(input);
      onSaved(next);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={mode === "edit" ? tx("Configure MCP Server") : tx("Add MCP Server")}
      width={580}
      buttons={[
        { label: mode === "edit" ? "Save" : "Add", role: "default", disabled: !canSave, onClick: () => void save() },
        { label: "Cancel", role: "cancel", onClick: onClose },
      ]}
    >
      {backend.saveJson && (
        <div className={styles.modalModeBar}>
          <span className={styles.hint}>
            <T>Configure via structured fields or paste a standard mcpServers JSON snippet.</T>
          </span>
          <div className={styles.segmented} role="tablist" aria-label={tx("Editor mode")}>
            <button
              type="button"
              role="tab"
              aria-selected={editorTab === "form"}
              className={clsx(styles.segmentBtn, editorTab === "form" && styles.segmentActive)}
              onClick={() => setEditorTab("form")}
            >
              <T>Form</T>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={editorTab === "json"}
              className={clsx(styles.segmentBtn, editorTab === "json" && styles.segmentActive)}
              onClick={() => setEditorTab("json")}
            >
              <T>JSON</T>
            </button>
          </div>
        </div>
      )}

      <div className={styles.form}>
        {error && (
          <div className={`${styles.error} ${styles.formWide}`} role="alert">
            <Icon name="error" size={14} />
            <span>{error}</span>
          </div>
        )}

        <Field label={<T>Scope:</T>}>
          <Select
            aria-label={tx("Scope")}
            value={scope}
            options={[
              { value: "user", label: tx("User (Global settings)") },
              { value: "workspace", label: tx("Workspace (.openidea/settings.toml)") },
            ]}
            onChange={(v) => setScope(v as McpScope)}
          />
        </Field>

        {editorTab === "json" ? (
          <Field
            id={`${id}-json`}
            label={<T>JSON:</T>}
            hint={<T>Accepts mcpServers, servers, or a single server JSON object.</T>}
          >
            <textarea
              id={`${id}-json`}
              data-autofocus
              className={`${styles.textarea} ${styles.jsonArea}`}
              rows={9}
              spellCheck={false}
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
            />
          </Field>
        ) : (
          <>
            <Field id={`${id}-name`} label={<T>Name:</T>}>
              <Input
                id={`${id}-name`}
                data-autofocus
                value={name}
                placeholder="my-mcp-server"
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label={<T>Type:</T>}>
              <Select
                aria-label={tx("Type")}
                value={transport}
                options={[
                  { value: "stdio", label: tx("stdio (Local Command)") },
                  { value: "http", label: tx("http (Streamable HTTP)") },
                  { value: "sse", label: tx("sse (Server-Sent Events)") },
                ]}
                onChange={(v) => setTransport(v as McpTransport)}
              />
            </Field>

            <hr className={styles.formDivider} />

            {transport === "stdio" ? (
              <>
                <Field id={`${id}-command`} label={<T>Command:</T>}>
                  <Input
                    id={`${id}-command`}
                    mono
                    value={command}
                    placeholder="npx"
                    onChange={(e) => setCommand(e.target.value)}
                  />
                </Field>
                <Field id={`${id}-args`} label={<T>Arguments:</T>}>
                  <Input
                    id={`${id}-args`}
                    mono
                    value={argsText}
                    placeholder="-y @modelcontextprotocol/server-filesystem /path"
                    onChange={(e) => setArgsText(e.target.value)}
                  />
                </Field>
                <Field
                  id={`${id}-env`}
                  label={<T>Environment variables:</T>}
                  hint={<T>One KEY=VALUE entry per line.</T>}
                >
                  <textarea
                    id={`${id}-env`}
                    className={styles.textarea}
                    rows={3}
                    spellCheck={false}
                    value={envText}
                    placeholder={"API_KEY=...\nANOTHER_VAR=value"}
                    onChange={(e) => setEnvText(e.target.value)}
                  />
                </Field>
              </>
            ) : (
              <>
                <Field id={`${id}-url`} label={<T>URL:</T>}>
                  <Input
                    id={`${id}-url`}
                    mono
                    value={url}
                    placeholder="https://mcp.linear.app/mcp"
                    onChange={(e) => setUrl(e.target.value)}
                  />
                </Field>
                <Field id={`${id}-headers`} label={<T>HTTP headers:</T>} hint={<T>One Header=Value entry per line.</T>}>
                  <textarea
                    id={`${id}-headers`}
                    className={styles.textarea}
                    rows={3}
                    spellCheck={false}
                    value={headersText}
                    placeholder={"Authorization=Bearer ...\nX-Custom-Header=value"}
                    onChange={(e) => setHeadersText(e.target.value)}
                  />
                </Field>
              </>
            )}
          </>
        )}

        <Field
          id={`${id}-agents`}
          label={<T>Agents:</T>}
          hint={<T>Leave empty to enable for all agents, or pick specific coding agents.</T>}
        >
          <div className={styles.agentPicker}>
            <button
              type="button"
              className={clsx(styles.agentChip, selectedAgents.length === 0 && styles.agentChipSelected)}
              onClick={() => setAgentsText("")}
            >
              <T>All agents</T>
            </button>
            {agentOptions.map((agent) => {
              const active = selectedAgents.includes(agent.id);
              return (
                <button
                  key={agent.id}
                  type="button"
                  className={clsx(styles.agentChip, active && styles.agentChipSelected)}
                  onClick={() => toggleAgentChip(agent.id)}
                >
                  <Icon name={providerIcon(agent.id)} size={12} />
                  <span>{agent.name}</span>
                </button>
              );
            })}
          </div>
          <Input
            id={`${id}-agents`}
            mono
            value={agentsText}
            placeholder="claude, codex"
            onChange={(e) => setAgentsText(e.target.value)}
          />
        </Field>
      </div>
    </Dialog>
  );
}

/** One row of the server form: the label in the left column, the control and its hint on the right. */
function Field({
  id,
  label,
  hint,
  children,
}: {
  id?: string;
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <label className={styles.formLabel} htmlFor={id}>
        {label}
      </label>
      <div className={styles.formControl}>
        {children}
        {hint && <span className={styles.hint}>{hint}</span>}
      </div>
    </>
  );
}
