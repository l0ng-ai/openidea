/** Built-in MCP server status and client configurations. */
import { useEffect, useState } from "react";
import { commands, call, isTauri, onIdeEvent, type McpServerStatus } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { WORKFLOW_LIMITS } from "@/platform/workflowSettings";
import { useTx } from "@/platform/i18n";
import { Button, Input, T, copyText } from "@/ui";
import { Row } from "../components/Form";
import { useSetting } from "../components/context";
import { DEFAULT_MCP_ADDRESS, MCP_PORT_LIMITS } from "../model/schema";
import type { PageSpec } from "./spec";
import styles from "./McpServer.module.css";

/** `mcpServers` entry of an MCP client configuration (Claude Code, Cursor…). */
export function httpConfig(status: McpServerStatus): string | null {
  if (!status.url || !status.token) return null;
  const server = { type: "http", url: status.url, headers: { Authorization: `Bearer ${status.token}` } };
  return JSON.stringify({ mcpServers: { openidea: server } }, null, 2);
}

/** The same through the stdio bridge: no token, works for as long as OpenIDEA runs. */
export function stdioConfig(status: McpServerStatus): string | null {
  const [command, ...args] = status.stdioCommand;
  if (!command) return null;
  return JSON.stringify({ mcpServers: { openidea: { type: "stdio", command, args } } }, null, 2);
}

function useStatus(): [McpServerStatus | null, () => void] {
  const root = useProject((s) => s.project?.root);
  const [status, setStatus] = useState<McpServerStatus | null>(null);
  const [loads, setLoads] = useState(0);
  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    const load = () =>
      void call(commands.mcpServerStatus()).then(
        (s) => live && setStatus(s),
        () => undefined,
      );
    load();
    // Turning the server on or off takes effect on Apply.
    const off = onIdeEvent("settingsChanged", (e) => {
      if (!e.key || e.key.startsWith("mcpServer")) load();
    });
    return () => {
      live = false;
      off();
    };
  }, [root, loads]);
  return [status, () => setLoads((n) => n + 1)];
}

function McpServerEndpoint() {
  const tx = useTx();
  const [status, reload] = useStatus();
  const [fixedToken] = useSetting<boolean>("mcpServer.fixedToken");
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  if (!status) return null;
  const copy = (which: string, text: string | null) => {
    if (!text) return;
    void copyText(text).then(() => setCopied(which));
  };
  const regenerate = () => void call(commands.mcpRegenerateToken()).then(reload, reload);
  const { port, error } = status;
  // Another address than this computer's only: say so, as other computers may connect.
  const at = status.address && status.address !== DEFAULT_MCP_ADDRESS ? status.address : null;
  const busy = status.portUnavailable;
  const state = status.running
    ? busy
      ? tx`Running on port ${port}: the fixed port is unavailable (${busy})`
      : at
        ? tx`Running on ${at}, port ${port}`
        : tx`Running on port ${port}`
    : error
      ? tx`Failed to start: ${error}`
      : tx("Not running");
  const http = httpConfig(status);
  const stdio = stdioConfig(status);
  return (
    <>
      <Row label="Status">
        <span className={error || busy ? styles.error : styles.status}>{state}</span>
      </Row>
      <Row
        label="Endpoint"
        hint={
          status.project
            ? "For this window's project. Agents name the project with the X-OpenIDEA-Project header or the ?project= query."
            : "Open a project to get its endpoint."
        }
      >
        <Input
          mono
          readOnly
          className={styles.endpoint}
          value={status.url ?? ""}
          placeholder={status.running ? tx("No project open") : tx("Not running")}
          aria-label="Endpoint"
        />
      </Row>
      <Row
        label="Client configuration"
        stacked
        hint="The HTTP configuration holds the token: it keeps working after OpenIDEA restarts only with a fixed port and a kept token. The stdio one starts OpenIDEA's executable, which relays to the running IDE."
      >
        <div className={styles.buttons}>
          <Button size="small" disabled={!http} onClick={() => copy("http", http)}>
            <T>Copy HTTP Config</T>
          </Button>
          <Button size="small" disabled={!stdio} onClick={() => copy("stdio", stdio)}>
            <T>Copy Stdio Config</T>
          </Button>
          {copied && (
            <span className={styles.status} role="status">
              <T>Copied to the clipboard</T>
            </span>
          )}
        </div>
      </Row>
      {fixedToken && (
        <Row label="Token" hint="Clients configured with the current token stop working.">
          <Button size="small" disabled={!status.running} onClick={regenerate}>
            <T>Regenerate Token</T>
          </Button>
        </Row>
      )}
    </>
  );
}

export const MCP_SERVER_PAGE: PageSpec = {
  id: "agents.mcpServer",
  title: "IDE MCP Server",
  group: "Agents",
  order: 470,
  keywords: [
    "mcp",
    "model context protocol",
    "ai",
    "agent",
    "claude",
    "codex",
    "tools",
    "stdio",
    "address",
    "listen",
    "port",
    "token",
  ],
  sections: [
    {
      options: [
        {
          kind: "toggle",
          key: "mcpServer.enabled",
          label: "Enable MCP server",
          hint: "Agents can read, edit, and run projects open in OpenIDEA through its built-in tools. Run tools ask for confirmation. The server listens on 127.0.0.1 unless Listen address says otherwise, and requires a token.",
        },
        {
          kind: "toggle",
          key: "mcpServer.runWithoutConfirmation",
          label: "Run tools without confirmation (brave mode)",
          hint: "Run configurations, terminal commands and other tools that change a project start without asking, for unattended agents. Only the IDE's own settings can turn this on, not a project's.",
        },
        {
          kind: "text",
          key: "mcpServer.address",
          label: "Listen address",
          placeholder: DEFAULT_MCP_ADDRESS,
          hint: "The IP address the server listens on: 127.0.0.1 for this computer only (the default); another address of this computer, such as a LAN or VPN one, or 0.0.0.0 for every address, so that agents on other computers can connect. Anyone who can reach the address and has the token can use the tools.",
        },
        {
          kind: "toggle",
          key: "mcpServer.fixedPort",
          label: "Use a fixed port",
          hint: "Listen on the same port in every run, so HTTP clients and port forwards keep working after OpenIDEA restarts. When the port is in use, this run takes a free one and Status says so. Off: a free port in every run.",
        },
        {
          kind: "number",
          key: "mcpServer.port",
          label: "Port",
          ...MCP_PORT_LIMITS,
          integer: true,
          hint: "The fixed port, used while Use a fixed port is on.",
        },
        {
          kind: "toggle",
          key: "mcpServer.fixedToken",
          label: "Keep the token",
          hint: "Keep the same bearer token in every run, stored for your account only. Off: a new token in every run. Anyone with the token can use the tools while OpenIDEA runs, so regenerate it if it leaks.",
        },
        {
          kind: "number",
          key: "mcpServer.agentTabLimit",
          label: "Finished agent tabs to show",
          ...WORKFLOW_LIMITS.agentTabLimit,
          integer: true,
          hint: "Commands agents run appear in the Run tool window as _agent_ tabs. Beyond this many finished ones, the oldest move to the archive at the end of the tab strip. Running commands are never archived.",
        },
        {
          kind: "number",
          key: "mcpServer.agentArchiveLimit",
          label: "Archived agent tabs to keep",
          ...WORKFLOW_LIMITS.agentArchiveLimit,
          integer: true,
          hint: "Beyond this many archived agent tabs, the oldest are closed.",
        },
        {
          kind: "custom",
          label: "Endpoint",
          keywords: ["Copy HTTP Config", "Copy Stdio Config", "Client configuration", "Status"],
          component: McpServerEndpoint,
        },
      ],
    },
  ],
};
