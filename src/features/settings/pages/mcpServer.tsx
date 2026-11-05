/**
 * Tools › MCP Server: AI agents outside the IDE (Claude Code, Codex…) call the
 * tools of installed plugins through a local MCP server. Shows where it
 * listens for this window's project and copies client configurations.
 */
import { useEffect, useState } from "react";
import { commands, isTauri, onIdeEvent, type McpServerStatus } from "@/platform/ipc";
import { useTx } from "@/platform/i18n";
import { Button, Input, T, copyText } from "@/ui";
import { Row } from "../components/Form";
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

function useStatus(): McpServerStatus | null {
  const [status, setStatus] = useState<McpServerStatus | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    const load = () =>
      void commands.mcpServerStatus().then(
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
  }, []);
  return status;
}

function McpServerEndpoint() {
  const tx = useTx();
  const status = useStatus();
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
  const { port, error } = status;
  const state = status.running
    ? tx`Running on port ${port}`
    : error
      ? tx`Failed to start: ${error}`
      : tx("Not running");
  const http = httpConfig(status);
  const stdio = stdioConfig(status);
  return (
    <>
      <Row label="Status">
        <span className={error ? styles.error : styles.status}>{state}</span>
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
        hint="The HTTP configuration holds this run's token and stops working when OpenIDEA restarts. The stdio one starts OpenIDEA's executable, which relays to the running IDE."
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
    </>
  );
}

export const MCP_SERVER_PAGE: PageSpec = {
  id: "tools.mcpServer",
  title: "MCP Server",
  group: "Tools",
  order: 604,
  keywords: ["mcp", "model context protocol", "ai", "agent", "claude", "codex", "tools", "stdio"],
  sections: [
    {
      options: [
        {
          kind: "toggle",
          key: "mcpServer.enabled",
          label: "Enable MCP server",
          hint: "AI agents outside the IDE can call the tools of plugins granted the MCP permission, for projects open in OpenIDEA. It listens on 127.0.0.1 only and needs a token.",
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
