/**
 * Settings › Agents › Model Context Protocol (MCP): configure, search, toggle, add, edit, remove,
 * and import MCP servers stored in OpenIDEA's User (`settings.toml`) and Workspace
 * (`.openidea/settings.toml`) settings, passed to coding agents over ACP.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { McpKeyValue, McpScope, McpServer, McpServerInput, McpTransport } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { useTx } from "@/platform/i18n";
import { openExternalUrl } from "@/platform/openUrl";
import { Button, Checkbox, Dialog, Icon, IconButton, Input, Menu, SearchField, Select, T, type MenuItem } from "@/ui";
import styles from "./McpServers.module.css";

const MCP_DOCS_URL = "https://modelcontextprotocol.io";
const MCP_BROWSE_URL = "https://github.com/modelcontextprotocol/servers";

export interface McpBackend {
  list(): Promise<McpServer[]>;
  save(input: McpServerInput): Promise<McpServer[]>;
  setEnabled(id: string, enabled: boolean): Promise<McpServer[]>;
  remove(id: string): Promise<McpServer[]>;
  importWorkspace(): Promise<McpServer[]>;
}

export const defaultMcpBackend: McpBackend = {
  list: () => call(commands.agentMcpList()),
  save: (input) => call(commands.agentMcpSave(input)),
  setEnabled: (id, enabled) => call(commands.agentMcpSetEnabled(id, enabled)),
  remove: (id) => call(commands.agentMcpRemove(id)),
  importWorkspace: () => call(commands.agentMcpImport()),
};

interface SectionSpec {
  scope: McpScope;
  title: string;
}

const SECTIONS: readonly SectionSpec[] = [
  { scope: "user", title: "User" },
  { scope: "workspace", title: "Workspace" },
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
  return text
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function serverSummary(server: McpServer): string {
  const endpoint =
    server.transport === "stdio"
      ? [server.command, ...server.args].filter(Boolean).join(" ")
      : `${server.transport.toUpperCase()} · ${server.url ?? ""}`;
  const agents = server.agents ?? [];
  if (agents.length === 0) return endpoint;
  return endpoint ? `${endpoint} (${agents.join(", ")})` : agents.join(", ");
}

export function McpServersPage({ backend = defaultMcpBackend }: { backend?: McpBackend }) {
  const tx = useTx();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<McpScope, boolean>>({
    user: false,
    workspace: false,
  });
  const [menuAnchor, setMenuAnchor] = useState<{ server: McpServer; el: HTMLElement } | null>(null);
  const [editing, setEditing] = useState<{
    mode: "add" | "edit";
    scope: McpScope;
    server?: McpServer;
  } | null>(null);

  const load = useCallback(() => {
    backend
      .list()
      .then((list) => {
        setServers(list);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [backend]);

  useEffect(() => {
    load();
  }, [load]);

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

  const toggleServer = async (server: McpServer, enabled: boolean) => {
    setBusyId(server.id);
    setError(null);
    // Optimistically update UI while persisting.
    setServers((prev) => prev.map((s) => (s.id === server.id ? { ...s, enabled } : s)));
    try {
      const next = await backend.setEnabled(server.id, enabled);
      setServers(next);
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
      setServers(next);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const importFromProject = async () => {
    setImporting(true);
    setError(null);
    try {
      const next = await backend.importWorkspace();
      setServers(next);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  const menuItems = (server: McpServer): MenuItem[] => [
    {
      label: server.enabled ? tx("Disable Server") : tx("Enable Server"),
      run: () => void toggleServer(server, !server.enabled),
    },
    {
      label: tx("Configure…"),
      run: () =>
        setEditing({
          mode: "edit",
          scope: server.scope,
          server,
        }),
    },
    {
      label: tx("Copy Server Name"),
      run: () => void navigator.clipboard?.writeText(server.name),
    },
    { kind: "separator" },
    {
      label: tx("Delete Server"),
      danger: true,
      run: () => void removeServer(server),
    },
  ];

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h2 className={styles.title}>
          <T>Model Context Protocol (MCP)</T>
        </h2>
        <div className={styles.headerActions}>
          <Button
            variant="secondary"
            disabled={importing}
            title={tx("Import MCP servers from .mcp.json and .vscode/mcp.json")}
            onClick={() => void importFromProject()}
          >
            <T>Import</T>
          </Button>
          <Button variant="secondary" onClick={() => void openExternalUrl(MCP_BROWSE_URL)}>
            <Icon name="globe" size={14} /> <T>Browse</T>
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

      <SearchField
        className={styles.search}
        value={query}
        onChange={setQuery}
        placeholder={tx("Type to search...")}
        aria-label={tx("Search MCP servers")}
      />

      {error && (
        <div className={styles.error} role="alert">
          <Icon name="error" size={14} />
          <span>{error}</span>
        </div>
      )}

      <div className={styles.sections}>
        {SECTIONS.map(({ scope, title }) => {
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
                </button>
                <IconButton
                  icon="plus"
                  size="small"
                  title={scope === "workspace" ? tx("Add Workspace MCP Server") : tx("Add User MCP Server")}
                  aria-label={scope === "workspace" ? tx("Add Workspace MCP Server") : tx("Add User MCP Server")}
                  onClick={() =>
                    setEditing({
                      mode: "add",
                      scope,
                    })
                  }
                />
              </div>

              {!isCollapsed && items.length > 0 && (
                <div className={styles.sectionBody} role="list">
                  {items.map((server) => {
                    const summary = serverSummary(server);
                    return (
                      <div key={server.id} role="listitem" className={styles.row}>
                        <div className={styles.rowMain}>
                          <span className={styles.serverName}>{server.name}</span>
                          {summary && (
                            <span className={styles.subtitle} title={summary}>
                              {summary}
                            </span>
                          )}
                        </div>
                        <div className={styles.rowActions}>
                          <Checkbox
                            checked={server.enabled}
                            aria-label={tx`Enable ${server.name}`}
                            disabled={busyId === server.id}
                            onChange={(on) => void toggleServer(server, on)}
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
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </div>

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
          initialScope={editing.scope}
          server={editing.server}
          onClose={() => setEditing(null)}
          onSaved={(next) => {
            setServers(next);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function McpServerModal({
  backend,
  mode,
  initialScope,
  server,
  onClose,
  onSaved,
}: {
  backend: McpBackend;
  mode: "add" | "edit";
  initialScope: McpScope;
  server?: McpServer;
  onClose: () => void;
  onSaved: (servers: McpServer[]) => void;
}) {
  const tx = useTx();
  const [name, setName] = useState(server?.name ?? "");
  const [scope, setScope] = useState<McpScope>(initialScope);
  const [transport, setTransport] = useState<McpTransport>(server?.transport ?? "stdio");
  const [command, setCommand] = useState(server?.command ?? "");
  const [argsText, setArgsText] = useState((server?.args ?? []).join(" "));
  const [envText, setEnvText] = useState(formatKeyValues(server?.env ?? []));
  const [url, setUrl] = useState(server?.url ?? "");
  const [headersText, setHeadersText] = useState(formatKeyValues(server?.headers ?? []));
  const [agentsText, setAgentsText] = useState((server?.agents ?? []).join(", "));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave =
    name.trim().length > 0 && (transport === "stdio" ? command.trim().length > 0 : url.trim().length > 0) && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
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
      agents: parseAgents(agentsText),
    };
    try {
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
      width={480}
      buttons={[
        { label: mode === "edit" ? "Save" : "Add", role: "default", disabled: !canSave, onClick: () => void save() },
        { label: "Cancel", role: "cancel", onClick: onClose },
      ]}
    >
      <div className={styles.form}>
        {error && (
          <div className={styles.error} role="alert">
            <Icon name="error" size={14} />
            <span>{error}</span>
          </div>
        )}
        <div className={styles.fieldRow}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>
              <T>Server Name</T>
            </span>
            <Input data-autofocus value={name} placeholder="my-mcp-server" onChange={(e) => setName(e.target.value)} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>
              <T>Scope</T>
            </span>
            <Select
              aria-label={tx("Scope")}
              value={scope}
              options={[
                { value: "user", label: tx("User (Global settings)") },
                { value: "workspace", label: tx("Workspace (.openidea/settings.toml)") },
              ]}
              onChange={(v) => setScope(v as McpScope)}
            />
          </label>
        </div>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>
            <T>Type</T>
          </span>
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
        </label>

        {transport === "stdio" ? (
          <>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>
                <T>Command</T>
              </span>
              <Input mono value={command} placeholder="npx" onChange={(e) => setCommand(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>
                <T>Arguments</T>
              </span>
              <Input
                mono
                value={argsText}
                placeholder="-y @modelcontextprotocol/server-filesystem /path"
                onChange={(e) => setArgsText(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>
                <T>Environment Variables</T>
              </span>
              <textarea
                className={styles.textarea}
                value={envText}
                placeholder={"API_KEY=...\nANOTHER_VAR=value"}
                onChange={(e) => setEnvText(e.target.value)}
              />
              <span className={styles.hint}>
                <T>One KEY=VALUE entry per line.</T>
              </span>
            </label>
          </>
        ) : (
          <>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>
                <T>Server URL</T>
              </span>
              <Input
                mono
                value={url}
                placeholder="https://mcp.linear.app/mcp"
                onChange={(e) => setUrl(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>
                <T>HTTP Headers</T>
              </span>
              <textarea
                className={styles.textarea}
                value={headersText}
                placeholder={"Authorization=Bearer ...\nX-Custom-Header=value"}
                onChange={(e) => setHeadersText(e.target.value)}
              />
              <span className={styles.hint}>
                <T>One Header=Value entry per line.</T>
              </span>
            </label>
          </>
        )}

        <label className={styles.field}>
          <span className={styles.fieldLabel}>
            <T>Agents</T>
          </span>
          <Input mono value={agentsText} placeholder="claude, codex" onChange={(e) => setAgentsText(e.target.value)} />
          <span className={styles.hint}>
            <T>Leave empty to enable for all agents, or list agent IDs separated by commas.</T>
          </span>
        </label>
      </div>
    </Dialog>
  );
}
