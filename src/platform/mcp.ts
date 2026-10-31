/**
 * The built-in MCP server as the UI consumes it: Tools › MCP Server settings
 * (mirrors `ide-core::mcp::McpSettings` defaults, normalisation never throws)
 * and the server's live status, shared by the settings page and the status bar.
 */
import { useEffect } from "react";
import { create } from "zustand";
import { commands, isTauri, onIdeEvent, type McpClientKind, type McpStatus } from "./ipc";

export interface McpSettingsValid {
  enabled: boolean;
  port: number;
  braveMode: boolean;
  disabledTools: string[];
  agents: boolean;
}

/** `ide-core::mcp::DEFAULT_MCP_PORT`. */
export const MCP_DEFAULT_PORT = 64352;
/** Ports the settings page accepts (no privileged ports). */
export const MCP_PORT_LIMITS = { min: 1024, max: 65535 } as const;

export const DEFAULT_MCP: McpSettingsValid = {
  enabled: false,
  port: MCP_DEFAULT_PORT,
  braveMode: false,
  disabledTools: [],
  agents: true,
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

export function validateMcp(raw: unknown): McpSettingsValid {
  const m = obj(raw);
  const port =
    typeof m.port === "number" && Number.isInteger(m.port) && m.port >= 1 && m.port <= 65535
      ? m.port
      : MCP_DEFAULT_PORT;
  return {
    enabled: m.enabled === true,
    port,
    braveMode: m.braveMode === true,
    disabledTools: Array.isArray(m.disabledTools)
      ? m.disabledTools.filter((t): t is string => typeof t === "string" && !!t.trim())
      : [],
    agents: m.agents !== false,
  };
}

/** The port typed into the settings page, or null when it is not one the server may use. */
export function parseMcpPort(text: string): number | null {
  if (!/^\s*\d+\s*$/.test(text)) return null;
  const n = Number(text);
  return n >= MCP_PORT_LIMITS.min && n <= MCP_PORT_LIMITS.max ? n : null;
}

/** Product names of the clients Tools › MCP Server can configure (not translated). */
export const MCP_CLIENT_NAMES: Record<McpClientKind, string> = {
  claudeCode: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  vsCode: "VS Code",
  windsurf: "Windsurf",
  gemini: "Gemini CLI",
};

// ---------------------------------------------------------------------------
// Live status

export const useMcpStatus = create<{ status: McpStatus | null }>(() => ({ status: null }));

const sameStatus = (a: McpStatus | null, b: McpStatus) => !!a && JSON.stringify(a) === JSON.stringify(b);

/** Whether `next` differs from `prev` only in the clients' call counts (no new URL, port or client). */
export function onlyCallsChanged(prev: McpStatus | null, next: McpStatus): boolean {
  if (!prev || sameStatus(prev, next)) return false;
  const withoutCalls = (s: McpStatus) => ({ ...s, clients: s.clients.map((c) => ({ ...c, calls: 0 })) });
  return sameStatus(withoutCalls(prev), withoutCalls(next));
}

let watchers = 0;
let stop: (() => void) | null = null;

/**
 * Keeps `useMcpStatus` current (initial `mcpStatus()`, then `mcpStatusChanged`)
 * until every caller has called the returned disposer.
 */
export function trackMcpStatus(): () => void {
  if (watchers++ === 0) {
    let changed = false;
    stop = onIdeEvent("mcpStatusChanged", (e) => {
      changed = true;
      // Sent again on every few tool calls: an unchanged status re-renders nothing.
      if (!sameStatus(useMcpStatus.getState().status, e.status)) useMcpStatus.setState({ status: e.status });
    });
    if (isTauri())
      void commands.mcpStatus().then(
        (status) => {
          // An event that arrived meanwhile is newer than this answer.
          if (!changed) useMcpStatus.setState({ status });
        },
        () => {},
      );
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (--watchers === 0) {
      stop?.();
      stop = null;
    }
  };
}

/** The server's status while the calling component is mounted (null until known). */
export function useLiveMcpStatus(): McpStatus | null {
  useEffect(() => trackMcpStatus(), []);
  return useMcpStatus((s) => s.status);
}
