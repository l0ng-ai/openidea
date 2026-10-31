/**
 * Tools › MCP Server: the built-in MCP endpoint external agents (Claude Code,
 * Codex, Cursor…) connect to, like IDEA's MCP Server page. The settings are
 * global and staged like every page; the clients, token and tool list are read
 * from the running backend.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import clsx from "clsx";
import {
  call,
  commands,
  isTauri,
  onIdeEvent,
  type McpClientConfig,
  type McpClientKind,
  type McpDetectedClient,
  type McpSkillInfo,
  type McpSkillTarget,
  type McpStatus,
  type McpTransport,
} from "@/platform/ipc";
import { tx, useTx } from "@/platform/i18n";
import {
  MCP_CLIENT_NAMES,
  MCP_PORT_LIMITS,
  onlyCallsChanged,
  parseMcpPort,
  useLiveMcpStatus,
  type McpSettingsValid,
} from "@/platform/mcp";
import { exportToolsMarkdown } from "@/features/mcp/exportTools";
import { MCP_TOOLS_PAGE } from "@/features/mcp/model";
import { basename, useProject } from "@/platform/project";
import { Badge, Button, Checkbox, Input, Select, T, copyText } from "@/ui";
import { confirm } from "@/workbench/messages";
import { Row, Toggle } from "../components/Form";
import { useSetting } from "../components/context";
import { useSettingsDialog } from "../model/staging";
import type { PageSpec } from "./spec";
import { TOOLS_GROUP } from "./tools";
import { PageLink } from "./workflowControls";
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
  // Reset drops a half-typed port along with the staged values.
  const resets = useSettingsDialog((s) => s.resets);
  const [enabled, setEnabled] = useMcpSetting("enabled");
  const [brave, setBrave] = useMcpSetting("braveMode");
  const [agents, setAgents] = useMcpSetting("agents");
  const [clientConfirmations, setClientConfirmations] = useMcpSetting("clientConfirmations");
  return (
    <div className={styles.block}>
      <Toggle label="Enable MCP Server" checked={enabled} onChange={setEnabled} />
      <StatusLine enabled={enabled} />
      <PortRow key={resets} />
      <Toggle
        label="Run shell commands and run configurations without confirmation (brave mode)"
        checked={brave}
        onChange={setBrave}
        hint="Caution: a connected agent can then run any command on this computer without asking you first."
      />
      <Toggle
        label="Let MCP clients ask for confirmations themselves (elicitation)"
        checked={clientConfirmations}
        onChange={setClientConfirmations}
        hint="The client then shows the question instead of OpenIDEA; a client that approves automatically runs commands without asking you."
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
  /** `mcpDetectClients`: installed clients (user level and this project's). */
  detected: McpDetectedClient[];
  error: string | null;
}

interface ClientsApi {
  state: ClientsState;
  reload: () => void;
  replace: (c: McpClientConfig) => void;
  project: string | null;
}

/** Calls `load` now, and again when the configurations may have changed (not on every tool call). */
function useReloadOnChange(load: () => void) {
  const lastStatus = useRef<McpStatus | null>(null);
  useEffect(() => {
    load();
    const disposers = [
      // A new token or port changes every snippet; a client's call count does not.
      onIdeEvent("mcpStatusChanged", (e) => {
        const quiet = onlyCallsChanged(lastStatus.current, e.status);
        lastStatus.current = e.status;
        if (!quiet) load();
      }),
      // The snippets use the saved port (from any window).
      onIdeEvent("settingsChanged", (e) => {
        if (e.key === "mcp" || e.key.startsWith("mcp.")) load();
      }),
    ];
    return () => disposers.forEach((d) => d());
  }, [load]);
}

function useDetection(project: string | null): [McpDetectedClient[], () => void] {
  const [detected, setDetected] = useState<McpDetectedClient[]>([]);
  const load = useCallback(() => {
    if (!isTauri()) return;
    call(commands.mcpDetectClients(project)).then(setDetected, () => {});
  }, [project]);
  return [detected, load];
}

/** The client configurations (`mcpClients`) and what the detection found for the user and the open project. */
function useClients(withConfigs = true): ClientsApi {
  const project = useProject((s) => s.project?.root ?? null);
  const [clients, setClients] = useState<McpClientConfig[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detected, detect] = useDetection(project);
  const load = useCallback(() => {
    detect();
    if (!isTauri() || !withConfigs) return;
    call(commands.mcpClients()).then(
      (list) => {
        setClients(list);
        setError(null);
      },
      (e: unknown) => setError(errorText(e)),
    );
  }, [detect, withConfigs]);
  const replace = useCallback(
    (c: McpClientConfig) => {
      setClients((list) => list?.map((x) => (x.client === c.client ? c : x)) ?? [c]);
      // The detection reads the file again (configured, port).
      detect();
    },
    [detect],
  );
  useReloadOnChange(load);
  return { state: { clients, detected, error }, reload: load, replace, project };
}

/** JetBrains' names of the transports (Copy Config menu). */
const TRANSPORT_NAMES: Record<McpTransport, string> = { stdio: "Stdio", sse: "SSE", http: "HTTP Stream" };

/** What the detection says of a client's configuration, as the settings page shows it. */
export function detectionStatus(d: McpDetectedClient | undefined): "mismatch" | "configured" | "notConfigured" | null {
  if (!d) return null;
  if (d.configured === true && !d.portCorrect) return "mismatch";
  return d.configured === true ? "configured" : "notConfigured";
}

function StatusBadge({ config, detected }: { config: McpClientConfig | null; detected?: McpDetectedClient }) {
  const t = useTx();
  const status = detectionStatus(detected);
  if (status === "mismatch") return <Badge tone="warning">{t("Port mismatch detected – please reconfigure")}</Badge>;
  const configured = status ? status === "configured" : !!config?.configured;
  if (!configured) return <Badge>{t("Not configured")}</Badge>;
  const transports = (detected?.transports ?? []).map((x) => TRANSPORT_NAMES[x]).join(", ");
  return <Badge tone="success">{transports ? t`Configured (${transports})` : t("Configured")}</Badge>;
}

interface ClientRowProps {
  config: McpClientConfig;
  detected?: McpDetectedClient;
  onChange: (c: McpClientConfig) => void;
  /** The port or the server switch has unapplied edits: writing the configuration waits for Apply. */
  unapplied: boolean;
}

function ClientRow({ config, detected, onChange, unapplied }: ClientRowProps) {
  const t = useTx();
  const name = MCP_CLIENT_NAMES[config.client] ?? config.client;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState(false);
  const snippetId = useId();
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  const mismatch = detectionStatus(detected) === "mismatch";
  const configure = async () => {
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      onChange(await call(commands.mcpConfigureClient(config.client)));
      setDone(true);
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
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <li className={styles.client} aria-label={name}>
      <div className={styles.clientHead}>
        <span className={styles.clientName}>{name}</span>
        <StatusBadge config={config} detected={detected} />
        {detected && <Badge tone="accent">{t("Installed")}</Badge>}
        <span className={styles.spacer} />
        <Button size="small" icon="copy" onClick={() => void copy()}>
          {copied ? t("Copied") : t("Copy configuration")}
        </Button>
        <Button
          size="small"
          disabled={!config.canWrite || busy || unapplied}
          title={
            !config.canWrite
              ? "Copy the configuration and add it by hand"
              : unapplied
                ? "Apply the settings first"
                : undefined
          }
          onClick={() => void configure()}
        >
          {mismatch ? t("Fix Configuration") : t("Auto-Configure")}
        </Button>
      </div>
      {config.client === "claudeDesktop" && (
        <div className={styles.note}>
          <T>
            Claude Desktop starts the server as a command (stdio bridge); the configuration holds paths of this
            computer.
          </T>
        </div>
      )}
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
      {done && <div className={styles.note}>{t`${name} – restart the client if changes aren’t applied`}</div>}
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
    </li>
  );
}

/** Keys whose saved value the client configurations are written for. */
const CONFIG_KEYS = new Set(["mcp", "mcp.port", "mcp.enabled"]);

function useUnapplied() {
  return useSettingsDialog((s) => Object.values(s.staged).some((c) => c.scope === "global" && CONFIG_KEYS.has(c.key)));
}

/** Installed clients first (JetBrains' "Set up detected clients"), then the others. */
export function sortClients(clients: readonly McpClientConfig[], detected: readonly McpDetectedClient[]) {
  const installed = new Set(detected.filter((d) => d.project == null).map((d) => d.client));
  return [...clients].sort((a, b) => Number(installed.has(b.client)) - Number(installed.has(a.client)));
}

function Clients() {
  const {
    state: { clients, detected, error },
    reload,
    replace,
  } = useClients();
  const unapplied = useUnapplied();
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
  const global = (k: McpClientKind) => detected.find((d) => d.client === k && d.project == null);
  return (
    <div className={styles.block}>
      <div className={styles.note}>
        <T>
          Set up detected clients for use with the MCP Server. The configurations contain the server's access token:
          keep them private.
        </T>
      </div>
      {unapplied && (
        <div className={styles.note} role="note">
          <T>The configurations use the applied settings: apply the new port or server state to update them.</T>
        </div>
      )}
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
      {clients && (
        <ul className={styles.clients} aria-label={tx("MCP clients")}>
          {sortClients(clients, detected).map((c) => (
            <ClientRow key={c.client} config={c} detected={global(c.client)} onChange={replace} unapplied={unapplied} />
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

/** `ide-mcp::clients::project_config_file`: the clients with a project-level configuration. */
const PROJECT_CLIENTS: readonly McpClientKind[] = [
  "claudeCode",
  "codex",
  "cursor",
  "vsCode",
  "gemini",
  "junie",
  "air",
  "gitHubCopilotCli",
];

function ProjectClientRow({
  kind,
  project,
  detected,
  unapplied,
  onDone,
}: {
  kind: McpClientKind;
  project: string;
  detected?: McpDetectedClient;
  unapplied: boolean;
  onDone: () => void;
}) {
  const t = useTx();
  const name = MCP_CLIENT_NAMES[kind];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const configure = async () => {
    setBusy(true);
    setError(null);
    try {
      setFile(await call(commands.mcpConfigureProjectClient(kind, project)));
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const shownFile = file ?? detected?.file ?? null;
  return (
    <li className={styles.client} aria-label={name}>
      <div className={styles.clientHead}>
        <span className={styles.clientName}>{name}</span>
        <StatusBadge config={null} detected={detected} />
        <span className={styles.spacer} />
        <Button
          size="small"
          disabled={busy || unapplied}
          title={unapplied ? "Apply the settings first" : undefined}
          onClick={() => void configure()}
        >
          {detectionStatus(detected) === "mismatch" ? t("Fix Configuration") : t("Auto-Configure")}
        </Button>
      </div>
      {shownFile && (
        <div className={styles.clientFile}>
          <span className={styles.mono} data-tooltip={shownFile}>
            {shownFile}
          </span>
        </div>
      )}
      {file && <div className={styles.note}>{t`${name} – restart the client if changes aren’t applied`}</div>}
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
    </li>
  );
}

function ProjectClients() {
  const {
    state: { detected },
    reload,
    project,
  } = useClients(false);
  const unapplied = useUnapplied();
  if (!project) return null;
  const projectName = basename(project);
  const inProject = (k: McpClientKind) => detected.find((d) => d.client === k && d.project != null);
  const kinds = [...PROJECT_CLIENTS].sort((a, b) => Number(!!inProject(b)) - Number(!!inProject(a)));
  return (
    <div className={styles.block}>
      <div className={styles.note}>
        {tx`Project Clients Auto-Configuration (${projectName})`}:{" "}
        {tx("Set up detected project-level clients for use with the MCP Server")}
      </div>
      <div className={styles.note}>
        <T>Uses the stdio bridge; the file holds paths of this computer.</T>
      </div>
      <ul className={styles.clients} aria-label={tx("Project MCP clients")}>
        {kinds.map((k) => (
          <ProjectClientRow
            key={k}
            kind={k}
            project={project}
            detected={inProject(k)}
            unapplied={unapplied}
            onDone={reload}
          />
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skills

const SKILL_TARGETS: Record<McpSkillTarget, () => string> = {
  claude: () => MCP_CLIENT_NAMES.claudeCode,
  codex: () => MCP_CLIENT_NAMES.codex,
  junie: () => MCP_CLIENT_NAMES.junie,
  other: () => tx("Other agents (~/.agents)"),
};

function Skills() {
  const t = useTx();
  const projectRoot = useProject((s) => s.project?.root ?? null);
  const [scope, setScope] = useState<"user" | "project">("user");
  const project = scope === "project" ? projectRoot : null;
  const [skills, setSkills] = useState<McpSkillInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    call(commands.mcpSkills(project)).then(
      (list) => live && setSkills(list),
      (e: unknown) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [project]);
  const toggle = async (skill: McpSkillInfo, target: McpSkillTarget, install: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setSkills(
        await call(
          install
            ? commands.mcpInstallSkill(skill.id, target, project)
            : commands.mcpRemoveSkill(skill.id, target, project),
        ),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.block}>
      <div className={styles.note}>
        <T>Skills teach agents when and how to use the IDE's tools. Install them for the agents you use.</T>
      </div>
      {projectRoot && (
        <div className={styles.actions}>
          <Select
            aria-label="Install skills for"
            value={scope}
            onChange={(v) => setScope(v)}
            options={[
              { value: "user", label: "All projects (user)" },
              { value: "project", label: "This project" },
            ]}
          />
        </div>
      )}
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
      {skills && !skills.length && (
        <div className={styles.note}>
          <T>No skills are bundled.</T>
        </div>
      )}
      {skills && skills.length > 0 && (
        <ul className={styles.clients} aria-label={t("Agent skills")}>
          {skills.map((skill) => (
            <li key={skill.id} className={styles.client} aria-label={skill.id}>
              <div className={styles.clientHead}>
                <span className={clsx(styles.clientName, styles.mono)}>{skill.id}</span>
                {!skill.available && <Badge tone="warning">{t("Uses disabled tools")}</Badge>}
              </div>
              <div className={styles.description}>{skill.description}</div>
              {skill.tools.length > 0 && <div className={clsx(styles.note, styles.mono)}>{skill.tools.join(", ")}</div>}
              <div className={styles.targets}>
                {skill.targets.map((target) => {
                  const label = SKILL_TARGETS[target]();
                  return (
                    <Checkbox
                      key={target}
                      aria-label={t`${label}: ${skill.id}`}
                      label={label}
                      disabled={busy}
                      checked={skill.installed.includes(target)}
                      onChange={(on) => void toggle(skill, target, on)}
                    />
                  );
                })}
              </div>
            </li>
          ))}
        </ul>
      )}
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
// Exposed tools

function ExposedToolsLink() {
  return (
    <div className={styles.actions}>
      <span className={styles.note}>
        <T>Choose the tools clients see, and whether they reach them through the router:</T>
      </span>
      <PageLink page={MCP_TOOLS_PAGE}>
        <T>Exposed Tools</T>
      </PageLink>
      <Button size="small" icon="export" onClick={() => void exportToolsMarkdown()}>
        Export to Markdown
      </Button>
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
              "Let MCP clients ask for confirmations themselves (elicitation)",
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
        title: "Project Clients",
        options: [{ kind: "custom", label: "Project Clients Auto-Configuration", component: ProjectClients }],
      },
      {
        title: "Skills",
        options: [{ kind: "custom", label: "Agent skills", component: Skills }],
      },
      {
        title: "Connected Clients",
        options: [{ kind: "custom", label: "Connected clients", component: ConnectedClients }],
      },
      {
        title: "Exposed Tools",
        options: [
          { kind: "custom", label: "Exposed Tools", keywords: ["Export to Markdown"], component: ExposedToolsLink },
        ],
      },
    ],
  },
];
