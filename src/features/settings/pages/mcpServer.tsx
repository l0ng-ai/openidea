/** Built-in MCP server status and client configurations. */
import { useEffect, useState } from "react";
import { commands, call, isTauri, onIdeEvent, type McpServerStatus } from "@/platform/ipc";
import { backgroundProjectState, unloadBackgroundProject, useBackgroundProjects } from "@/platform/mcpBackground";
import { basename, useProject } from "@/platform/project";
import { WORKFLOW_LIMITS } from "@/platform/workflowSettings";
import { useTx } from "@/platform/i18n";
import { ProjectBadge } from "@/workbench/ProjectBadge";
import { useRemote } from "@/platform/remote";
import { Button, Input, T, copyText } from "@/ui";
import { GlobListEditor, Row, SettingNumber, SettingSelect } from "../components/Form";
import { useSetting } from "../components/context";
import {
  DEFAULT_MCP_ADDRESS,
  MCP_BACKGROUND_IDLE_LIMITS,
  MCP_BACKGROUND_MODES,
  MCP_BACKGROUND_PROJECT_LIMITS,
  MCP_PORT_LIMITS,
} from "../model/schema";
import { useSettingsDialog } from "../model/staging";
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
    // Turning the server on or off takes effect on Apply. A remote host's server reports its
    // settings changes to the project window only, so the end of Apply reloads too.
    const off = onIdeEvent("settingsChanged", (e) => {
      if (!e.key || e.key.startsWith("mcpServer")) load();
    });
    const offApplied = useSettingsDialog.subscribe((s, prev) => {
      if (prev.saving && !s.saving) load();
    });
    return () => {
      live = false;
      off();
      offApplied();
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
            ? "For this window's project. Other projects: the X-OpenIDEA-Project header or ?project= query."
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
        hint="HTTP survives restarts only with a fixed port and a kept token. Stdio relays through OpenIDEA's executable."
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
        <Row label="Token" hint="Clients using the current token stop working.">
          <Button size="small" disabled={!status.running} onClick={regenerate}>
            <T>Regenerate Token</T>
          </Button>
        </Row>
      )}
    </>
  );
}

/**
 * Background projects belong to OpenIDEA on this computer: a remote window's settings are its
 * host's, whose server serves only the project open in that window.
 */
function useRemoteHost(): boolean {
  return useRemote((s) => s.session !== null);
}

/** The folders, the idle time and the limit apply only while a mode serves something. */
function useBackgroundOff(): boolean {
  const [mode] = useSetting<string>("mcpServer.backgroundProjects");
  return useRemoteHost() || mode === "off";
}

function BackgroundMode() {
  return (
    <SettingSelect
      k="mcpServer.backgroundProjects"
      label="Serve without a window"
      options={BACKGROUND_MODES}
      disabled={useRemoteHost()}
      hint="A folder opens on the first tool call inside it and unloads when idle. Trusted projects also serves trusted projects and locations. Untrusted folders get read-only tools."
    />
  );
}

function BackgroundFolders() {
  const [paths, setPaths] = useSetting<string[]>("mcpServer.backgroundProjectPaths");
  const off = useBackgroundOff();
  return (
    <Row label="Folders" stacked disabled={off} hint="Served without a window.">
      <div inert={off} className={off ? styles.off : undefined}>
        <GlobListEditor
          value={paths}
          onChange={setPaths}
          placeholder="/path/to/project"
          emptyText="No folders listed"
          itemLabel="Folder"
          aria-label="Folders"
          browse={{ directory: true, title: "Choose Folder to Serve" }}
        />
      </div>
    </Row>
  );
}

function BackgroundIdleMinutes() {
  return (
    <SettingNumber
      k="mcpServer.backgroundIdleMinutes"
      label="Unload after"
      {...MCP_BACKGROUND_IDLE_LIMITS}
      integer
      unit="min"
      disabled={useBackgroundOff()}
      hint="0 never unloads."
    />
  );
}

function BackgroundProjectLimit() {
  return (
    <SettingNumber
      k="mcpServer.backgroundProjectLimit"
      label="Project limit"
      {...MCP_BACKGROUND_PROJECT_LIMITS}
      integer
      disabled={useBackgroundOff()}
      hint="At the limit, the longest idle project unloads."
    />
  );
}

/** The projects loaded now. Unloading acts at once: it is not an edit of the settings. */
function BackgroundOpenNow() {
  const tx = useTx();
  const loaded = useBackgroundProjects();
  const remote = useRemoteHost();
  const projects = remote ? [] : loaded;
  const [mode] = useSetting<string>("mcpServer.backgroundProjects");
  const [enabled] = useSetting<boolean>("mcpServer.enabled");
  return (
    <Row label="Open now" stacked hint="Unloading takes effect at once; the next tool call loads the project again.">
      {projects.length === 0 ? (
        <span className={styles.status}>
          {remote ? (
            <T>A remote host serves only the project open in its window</T>
          ) : !enabled ? (
            <T>The MCP server is off</T>
          ) : mode === "off" ? (
            <T>Background projects are off</T>
          ) : (
            <T>No background projects are loaded</T>
          )}
        </span>
      ) : (
        <ul className={styles.projects}>
          {projects.map((project) => {
            const name = basename(project.root) || project.root;
            return (
              <li key={project.root} className={styles.project}>
                <ProjectBadge name={name} path={project.root} />
                <div className={styles.projectText}>
                  <span className={styles.projectName} title={name}>
                    {name}
                  </span>
                  <span className={styles.projectPath} title={project.root}>
                    {project.root}
                  </span>
                  <span className={styles.projectState}>{backgroundProjectState(project)}</span>
                </div>
                <Button
                  size="small"
                  className={styles.unload}
                  aria-label={tx`Unload ${project.root}`}
                  onClick={() => unloadBackgroundProject(project.root)}
                >
                  <T>Unload</T>
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </Row>
  );
}

const BACKGROUND_MODE_LABELS: Record<(typeof MCP_BACKGROUND_MODES)[number], string> = {
  off: "Off",
  trusted: "Trusted projects",
  listed: "Listed projects",
};
const BACKGROUND_MODES = MCP_BACKGROUND_MODES.map((value) => ({ value, label: BACKGROUND_MODE_LABELS[value] }));

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
    "brave mode",
    "run tool window",
    "archive",
  ],
  sections: [
    {
      options: [
        {
          kind: "toggle",
          key: "mcpServer.enabled",
          label: "Enable MCP server",
          hint: "Agents can read, edit and run the projects open in OpenIDEA.",
        },
        {
          kind: "toggle",
          key: "mcpServer.runWithoutConfirmation",
          label: "Run tools without confirmation",
          hint: "For unattended agents. Only the IDE settings can turn this on, not a project.",
        },
        {
          kind: "custom",
          label: "Endpoint",
          keywords: ["Copy HTTP Config", "Copy Stdio Config", "Client configuration", "Status"],
          component: McpServerEndpoint,
        },
      ],
    },
    {
      title: "Connection",
      options: [
        {
          kind: "text",
          key: "mcpServer.address",
          label: "Listen address",
          placeholder: DEFAULT_MCP_ADDRESS,
          hint: "127.0.0.1 is this computer only. Use 0.0.0.0 or a LAN address to let other computers connect.",
        },
        {
          kind: "toggle",
          key: "mcpServer.fixedPort",
          label: "Use a fixed port",
          hint: "Keeps HTTP clients working after a restart. Falls back to a free port when it's taken.",
          children: [
            {
              kind: "number",
              key: "mcpServer.port",
              label: "Port",
              ...MCP_PORT_LIMITS,
              integer: true,
            },
          ],
        },
        {
          kind: "toggle",
          key: "mcpServer.fixedToken",
          label: "Keep the token",
          hint: "Off: a new token in every run.",
        },
      ],
    },
    {
      title: "Agent Tabs",
      options: [
        {
          kind: "number",
          key: "mcpServer.agentTabLimit",
          label: "Finished tabs to show",
          ...WORKFLOW_LIMITS.agentTabLimit,
          integer: true,
          hint: "Older finished _agent_ tabs in the Run tool window move to the archive.",
        },
        {
          kind: "number",
          key: "mcpServer.agentArchiveLimit",
          label: "Archived tabs to keep",
          ...WORKFLOW_LIMITS.agentArchiveLimit,
          integer: true,
        },
      ],
    },
    {
      title: "Background Projects",
      options: [
        {
          kind: "custom",
          label: "Serve without a window",
          keywords: Object.values(BACKGROUND_MODE_LABELS),
          component: BackgroundMode,
        },
        {
          kind: "custom",
          label: "Folders",
          keywords: ["Choose Folder to Serve", "background projects", "listed"],
          component: BackgroundFolders,
        },
        { kind: "custom", label: "Unload after", component: BackgroundIdleMinutes },
        { kind: "custom", label: "Project limit", component: BackgroundProjectLimit },
        {
          kind: "custom",
          label: "Open now",
          keywords: ["Unload", "background projects", "No background projects are loaded"],
          component: BackgroundOpenNow,
        },
      ],
    },
  ],
};
