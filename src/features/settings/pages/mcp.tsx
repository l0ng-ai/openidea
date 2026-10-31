/**
 * Tools › MCP Server: the built-in MCP endpoint external agents (Claude Code,
 * Codex, Cursor…) connect to, like IDEA's MCP Server page. The settings are
 * global and staged like every page; the clients, token and tool list are read
 * from the running backend.
 */
import { useCallback, useEffect, useId, useState } from "react";
import clsx from "clsx";
import { call, commands, isTauri, onIdeEvent, type McpClientConfig, type McpToolInfo } from "@/platform/ipc";
import { tx, useTx } from "@/platform/i18n";
import {
  MCP_CLIENT_NAMES,
  MCP_PORT_LIMITS,
  parseMcpPort,
  useLiveMcpStatus,
  type McpSettingsValid,
} from "@/platform/mcp";
import { Badge, Button, Checkbox, Input, T, copyText } from "@/ui";
import { confirm } from "@/workbench/messages";
import { Row, Toggle } from "../components/Form";
import { useSetting } from "../components/context";
import type { PageSpec } from "./spec";
import { TOOLS_GROUP } from "./tools";
import styles from "./Mcp.module.css";

export const MCP_PAGE = "tools.mcpServer";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function useMcpSetting<K extends keyof McpSettingsValid>(key: K) {
  return useSetting<McpSettingsValid[K]>(`mcp.${key}`, "global");
}

// ---------------------------------------------------------------------------
// Server

/** Running at <url> / not running (and why), as the backend reports it. */
function StatusLine({ enabled }: { enabled: boolean }) {
  const status = useLiveMcpStatus();
  let text: string;
  let tone: "ok" | "error" | "idle" = "idle";
  if (status?.running && status.url) {
    text = tx`Running at ${status.url}`;
    tone = "ok";
  } else if (status?.error) {
    text = tx`Not running: ${status.error}`;
    tone = "error";
  } else text = tx(enabled ? "Not running yet: apply the settings to start the server." : "Not running");
  return (
    <div
      role="status"
      aria-label={tx("Server status")}
      className={clsx(styles.status, tone === "ok" && styles.ok, tone === "error" && styles.error)}
    >
      {text}
    </div>
  );
}

/** Port field: committed on blur / Enter (not per keystroke), so a half-typed port never restarts the server. */
function PortRow() {
  const [port, setPort] = useMcpSetting("port");
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? String(port);
  const invalid = draft !== null && parseMcpPort(draft) === null;
  const commit = () => {
    if (draft === null) return;
    const n = parseMcpPort(draft);
    if (n !== null && n !== port) setPort(n);
    if (n !== null) setDraft(null);
  };
  return (
    <Row
      label="Port"
      htmlFor={id}
      hint={invalid ? undefined : "The server listens on 127.0.0.1 only."}
      className={styles.portRow}
    >
      <Input
        id={id}
        className={styles.port}
        inputMode="numeric"
        value={text}
        invalid={invalid}
        aria-invalid={invalid || undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape" && draft !== null) {
            e.stopPropagation();
            setDraft(null);
          }
        }}
      />
      {invalid && (
        <span className={styles.error} role="alert">
          {tx`Enter a port between ${MCP_PORT_LIMITS.min} and ${MCP_PORT_LIMITS.max}`}
        </span>
      )}
    </Row>
  );
}

function ServerOptions() {
  const [enabled, setEnabled] = useMcpSetting("enabled");
  const [brave, setBrave] = useMcpSetting("braveMode");
  const [agents, setAgents] = useMcpSetting("agents");
  return (
    <div className={styles.block}>
      <Toggle label="Enable MCP Server" checked={enabled} onChange={setEnabled} />
      <StatusLine enabled={enabled} />
      <PortRow />
      <Toggle
        label="Run shell commands and run configurations without confirmation (brave mode)"
        checked={brave}
        onChange={setBrave}
        hint="Caution: a connected agent can then run any command on this computer without asking you first."
      />
      <Toggle
        label="Give the IDE's agents these tools"
        checked={agents}
        onChange={setAgents}
        hint="Agents started from the Agents tool window can use the IDE's tools too."
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Clients

interface ClientsState {
  clients: McpClientConfig[] | null;
  error: string | null;
}

function useClients(): [ClientsState, () => void, (c: McpClientConfig) => void] {
  const [state, setState] = useState<ClientsState>({ clients: null, error: null });
  const load = useCallback(() => {
    if (!isTauri()) return;
    call(commands.mcpClients()).then(
      (clients) => setState({ clients, error: null }),
      (e: unknown) => setState((s) => ({ ...s, error: errorText(e) })),
    );
  }, []);
  const replace = useCallback(
    (c: McpClientConfig) =>
      setState((s) => ({ ...s, clients: s.clients?.map((x) => (x.client === c.client ? c : x)) ?? [c] })),
    [],
  );
  useEffect(() => {
    load();
    // A new token or port changes every snippet.
    return onIdeEvent("mcpStatusChanged", load);
  }, [load]);
  return [state, load, replace];
}

function ClientRow({ config, onChange }: { config: McpClientConfig; onChange: (c: McpClientConfig) => void }) {
  const t = useTx();
  const name = MCP_CLIENT_NAMES[config.client] ?? config.client;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState(false);
  const snippetId = useId();
  const configure = async () => {
    setBusy(true);
    setError(null);
    try {
      onChange(await call(commands.mcpConfigureClient(config.client)));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    try {
      await copyText(config.snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <li className={styles.client} aria-label={name}>
      <div className={styles.clientHead}>
        <span className={styles.clientName}>{name}</span>
        {config.configured ? <Badge tone="success">{t("Configured")}</Badge> : <Badge>{t("Not configured")}</Badge>}
        <span className={styles.spacer} />
        <Button size="small" icon="copy" onClick={() => void copy()}>
          {copied ? t("Copied") : t("Copy configuration")}
        </Button>
        <Button
          size="small"
          disabled={!config.canWrite || busy}
          title={config.canWrite ? undefined : "Copy the configuration and add it by hand"}
          onClick={() => void configure()}
        >
          <T>Auto-Configure</T>
        </Button>
      </div>
      <div className={styles.clientFile}>
        {config.file ? (
          <span className={styles.mono} data-tooltip={config.file}>
            {config.file}
          </span>
        ) : (
          <T>Run this command in a terminal:</T>
        )}
        <button
          type="button"
          className={styles.link}
          aria-expanded={shown}
          aria-controls={snippetId}
          onClick={() => setShown((v) => !v)}
        >
          {shown ? t("Hide configuration") : t("Show configuration")}
        </button>
      </div>
      {shown && (
        <pre id={snippetId} className={styles.snippet} aria-label={t("Configuration")}>
          {config.snippet}
        </pre>
      )}
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
    </li>
  );
}

function Clients() {
  const [{ clients, error }, reload, replace] = useClients();
  const [regenerating, setRegenerating] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const regenerate = async () => {
    const ok = await confirm({
      title: "Regenerate Token",
      message: tx(
        "Clients configured with the current token can no longer connect. Configure them again (Auto-Configure or Copy configuration) after regenerating.",
      ),
      ok: "Regenerate",
      icon: "warning",
    });
    if (!ok) return;
    setRegenerating(true);
    setTokenError(null);
    try {
      await call(commands.mcpRegenerateToken());
    } catch (e) {
      setTokenError(errorText(e));
    } finally {
      setRegenerating(false);
      reload();
    }
  };
  return (
    <div className={styles.block}>
      <div className={styles.note}>
        <T>The configurations contain the server's access token: keep them private.</T>
      </div>
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
      {clients && (
        <ul className={styles.clients} aria-label={tx("MCP clients")}>
          {clients.map((c) => (
            <ClientRow key={c.client} config={c} onChange={replace} />
          ))}
        </ul>
      )}
      <div className={styles.actions}>
        <Button size="small" disabled={!isTauri() || regenerating} onClick={() => void regenerate()}>
          <T>Regenerate token…</T>
        </Button>
        {tokenError && (
          <span className={styles.error} role="alert">
            {tokenError}
          </span>
        )}
      </div>
    </div>
  );
}

function ConnectedClients() {
  const status = useLiveMcpStatus();
  const clients = status?.clients ?? [];
  if (!clients.length)
    return (
      <div className={styles.note}>
        <T>No client has connected since the server started.</T>
      </div>
    );
  return (
    <table className={styles.table} aria-label={tx("Connected clients")}>
      <thead>
        <tr>
          <th>
            <T>Client</T>
          </th>
          <th>
            <T>Version</T>
          </th>
          <th className={styles.number}>
            <T>Tool calls</T>
          </th>
        </tr>
      </thead>
      <tbody>
        {clients.map((c) => (
          <tr key={`${c.name}@${c.version}`}>
            <td>{c.name}</td>
            <td>{c.version}</td>
            <td className={styles.number}>{c.calls}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Tools

const KIND_LABEL: Record<McpToolInfo["kind"], string> = { read: "Read", edit: "Edit", execute: "Execute" };
const KIND_TONE = { read: "neutral", edit: "warning", execute: "danger" } as const;

/** `disabledTools` with `name` switched on or off (sorted, so the list does not depend on click order). */
export function withToolEnabled(disabled: readonly string[], name: string, enabled: boolean): string[] {
  const rest = disabled.filter((n) => n !== name);
  return enabled ? rest : [...rest, name].sort();
}

function Tools() {
  const t = useTx();
  const [disabled, setDisabled] = useMcpSetting("disabledTools");
  const [tools, setTools] = useState<McpToolInfo[] | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    const show = (list: McpToolInfo[]) => {
      if (live) setTools(list);
    };
    void commands.mcpTools().then(show, () => show([]));
    return () => {
      live = false;
    };
  }, []);
  if (!tools) return null;
  const off = new Set(disabled);
  return (
    <div className={styles.block}>
      <div className={styles.note}>
        <T>Edit tools change files; Execute tools run processes and ask first unless brave mode is on.</T>
      </div>
      <ul className={styles.tools} aria-label={t("MCP tools")}>
        {tools.map((tool) => (
          <li key={tool.name} className={styles.tool}>
            <Checkbox
              checked={!off.has(tool.name)}
              onChange={(on) => setDisabled(withToolEnabled(disabled, tool.name, on))}
              aria-label={tool.name}
              label={<span className={styles.mono}>{tool.name}</span>}
            />
            <Badge tone={KIND_TONE[tool.kind]}>{t(KIND_LABEL[tool.kind])}</Badge>
            <span className={styles.description} data-tooltip={tool.description}>
              {tool.description}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export const MCP_PAGES: PageSpec[] = [
  {
    id: MCP_PAGE,
    title: "MCP Server",
    group: TOOLS_GROUP,
    order: 604,
    keywords: ["mcp", "model context protocol", "claude", "codex", "cursor", "agent", "token", "brave mode"],
    sections: [
      {
        options: [
          {
            kind: "custom",
            label: "Enable MCP Server",
            keywords: [
              "Port",
              "Run shell commands and run configurations without confirmation (brave mode)",
              "Give the IDE's agents these tools",
            ],
            component: ServerOptions,
          },
        ],
      },
      {
        title: "Clients",
        options: [
          {
            kind: "custom",
            label: "Auto-Configure",
            keywords: ["Copy configuration", "Regenerate token…"],
            component: Clients,
          },
        ],
      },
      {
        title: "Connected Clients",
        options: [{ kind: "custom", label: "Connected clients", component: ConnectedClients }],
      },
      {
        title: "Tools",
        options: [{ kind: "custom", label: "MCP tools", component: Tools }],
      },
    ],
  },
];
