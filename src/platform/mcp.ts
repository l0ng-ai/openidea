/**
 * The built-in MCP server as the UI consumes it: Tools › MCP Server settings
 * (mirrors `ide-core::mcp::McpSettings` defaults, normalisation never throws)
 * and the server's live status, shared by the settings page and the status bar.
 */
import { useEffect } from "react";
import { create } from "zustand";
import { commands, isTauri, onIdeEvent, type McpClientKind, type McpInvocationMode, type McpStatus } from "./ipc";

/** One tool's entry in `toolStates` (`ide-core::mcp::McpToolState`). */
export interface McpToolStateValid {
  enabled: boolean;
  routerOnly: boolean;
}

export interface McpSettingsValid {
  enabled: boolean;
  port: number;
  braveMode: boolean;
  disabledTools: string[];
  agents: boolean;
  /** Comma-separated masks over fully qualified tool names; empty = no filter. */
  toolsFilter: string;
  /** Per-tool state by fully qualified (or plain) name; absent = `DEFAULT_MCP_TOOL_STATE`. */
  toolStates: Record<string, McpToolStateValid>;
  invocationMode: McpInvocationMode;
  experimentalTools: boolean;
  /** Ask confirmations through the MCP client (elicitation) when it supports it. */
  clientConfirmations: boolean;
  /** What the database tools may do without asking. */
  databaseConsents: McpDatabaseConsentsValid;
}

/** `ide-core::mcp::McpDatabaseConsents`. */
export interface McpDatabaseConsentsValid {
  readData: boolean;
  writeData: boolean;
  readSchema: boolean;
  writeSchema: boolean;
}

/** `McpToolState::default()`: offered, and behind the router in router mode. */
export const DEFAULT_MCP_TOOL_STATE: McpToolStateValid = { enabled: true, routerOnly: true };

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
  toolsFilter: "",
  toolStates: {},
  invocationMode: "direct",
  experimentalTools: false,
  clientConfirmations: false,
  databaseConsents: { readData: false, writeData: false, readSchema: false, writeSchema: false },
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
    toolsFilter: typeof m.toolsFilter === "string" ? m.toolsFilter : "",
    toolStates: validateToolStates(m.toolStates),
    invocationMode: m.invocationMode === "viaRouter" ? "viaRouter" : "direct",
    experimentalTools: m.experimentalTools === true,
    clientConfirmations: m.clientConfirmations === true,
    databaseConsents: validateConsents(m.databaseConsents),
  };
}

function validateConsents(raw: unknown): McpDatabaseConsentsValid {
  const c = obj(raw);
  return {
    readData: c.readData === true,
    writeData: c.writeData === true,
    readSchema: c.readSchema === true,
    writeSchema: c.writeSchema === true,
  };
}

function validateToolStates(raw: unknown): Record<string, McpToolStateValid> {
  const out: Record<string, McpToolStateValid> = {};
  for (const [name, value] of Object.entries(obj(raw))) {
    if (!name.trim()) continue;
    const v = obj(value);
    // serde(default): a missing field takes its default.
    out[name] = { enabled: v.enabled !== false, routerOnly: v.routerOnly !== false };
  }
  return out;
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
  claudeDesktop: "Claude Desktop",
  junie: "Junie",
  air: "Air",
  gitHubCopilotCli: "GitHub Copilot CLI",
  gitHubCopilotIdePlugin: "GitHub Copilot (IDE Plugin)",
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
