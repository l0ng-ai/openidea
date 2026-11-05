// Ported from JetBrains intellij-community plugins/mcp-server (mcpserver.frontend/src/widget/McpServerStatusBarWidget.kt, McpServerPopupContent.kt, McpServerPopupModel.kt), Apache-2.0.
/**
 * Status bar widget of the MCP server: running / failed / disabled, the URL and
 * clients as tooltip. A click opens IDEA's MCP Server popup: the server switch,
 * its status, connected clients and recent calls, the detected clients to
 * configure, brave mode, and quick actions. Whether it is enabled comes from the
 * saved global settings (the server follows them in every window).
 */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { executeAction } from "@/platform/actions";
import { tx, useTx } from "@/platform/i18n";
import { call, commands, isTauri, type McpClientConfig, type McpDetectedClient, type McpStatus } from "@/platform/ipc";
import { MCP_CLIENT_NAMES, useLiveMcpStatus, validateMcp } from "@/platform/mcp";
import { useProject } from "@/platform/project";
import { BarButton, Button, Checkbox, Icon, IconButton, Popup, T, Toggle, copyText } from "@/ui";
import { toolWindowService } from "@/workbench/contributions";
import { confirm } from "@/workbench/messages";
import { useMcpCalls, refreshCalls } from "./calls";
import { exportToolsMarkdown } from "./exportTools";
import { MCP_SETTINGS_PAGE, MCP_TOOL_WINDOW, MCP_TOOLS_PAGE, setGlobalMcpSetting } from "./model";
import styles from "./Mcp.module.css";

/** The widget's tooltip: the state, then each connected client. */
export function statusTooltip(status: McpStatus | null, t: ReturnType<typeof useTx>, enabled = true): string {
  const lines: string[] = [];
  if (status?.running && status.url) lines.push(t`MCP Server running at ${status.url}`);
  else if (status?.error) lines.push(t`MCP Server not running: ${status.error}`);
  else if (!enabled) lines.push(t("MCP Server (Disabled)"));
  else lines.push(t("MCP Server not running"));
  if (status?.running) {
    if (!status.clients.length) lines.push(t("No clients connected"));
    for (const c of status.clients) {
      const calls = c.calls;
      lines.push(t`${c.name} ${c.version}: ${calls} tool calls`);
    }
  }
  return lines.join(" · ");
}

const useMcpEnabled = () => useProject((s) => validateMcp(s.settings?.mcp).enabled);

export function McpStatusWidget() {
  const status = useLiveMcpStatus();
  const enabled = useMcpEnabled();
  return status || enabled ? <Widget status={status} enabled={enabled} /> : null;
}

function Widget({ status, enabled }: { status: McpStatus | null; enabled: boolean }) {
  const t = useTx();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const failed = !!status && !status.running && !!status.error;
  const off = !enabled && !status?.running;
  return (
    <>
      <BarButton
        ref={ref}
        className={clsx(styles.statusItem, failed && styles.statusError, off && styles.statusOff)}
        aria-label={t("MCP Server")}
        aria-expanded={open}
        aria-haspopup="dialog"
        tooltip={statusTooltip(status, t, enabled)}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={failed ? "warning" : "plugin"} size={13} />
        MCP
        {status?.running && status.clients.length > 0 && <span>{status.clients.length}</span>}
      </BarButton>
      <Popup
        open={open}
        anchor={ref}
        placement="top-end"
        offset={6}
        onClose={() => setOpen(false)}
        aria-label="MCP Server"
      >
        <McpServerPopup status={status} enabled={enabled} onClose={() => setOpen(false)} />
      </Popup>
    </>
  );
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Detected (user-level) clients whose configuration does not reach this server. */
export function clientsNeedingConfig(detected: readonly McpDetectedClient[]): McpDetectedClient[] {
  return detected.filter((d) => d.project == null && (d.configured !== true || !d.portCorrect || !d.current));
}

interface PopupProps {
  status: McpStatus | null;
  enabled: boolean;
  onClose: () => void;
}

export function McpServerPopup({ status, enabled, onClose }: PopupProps) {
  const t = useTx();
  const project = useProject((s) => s.project?.root ?? null);
  const brave = useProject((s) => validateMcp(s.settings?.mcp).braveMode);
  const calls = useMcpCalls((s) => s.calls.length);
  const [detected, setDetected] = useState<McpDetectedClient[] | null>(null);
  const [configs, setConfigs] = useState<McpClientConfig[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    void refreshCalls();
    call(commands.mcpDetectClients(project)).then(
      (d) => live && setDetected(d),
      () => live && setDetected([]),
    );
    call(commands.mcpClients()).then(
      (c) => live && setConfigs(c),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [project]);

  const run = (f: () => unknown) => () => {
    onClose();
    void f();
  };
  const setEnabled = async (on: boolean) => {
    setError(null);
    if (on) {
      onClose();
      const ok = await confirm({
        title: "Enable MCP Server?",
        message: tx(
          "By clicking Enable, you will allow third-party applications to interact with all projects opened in the IDE: read the structure and content of files, trigger IDE actions, run terminal commands, and more.",
        ),
        ok: "Enable",
        icon: "warning",
      });
      if (!ok) return;
    }
    try {
      await setGlobalMcpSetting("enabled", on);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const setBrave = (on: boolean) =>
    void setGlobalMcpSetting("braveMode", on).catch((e: unknown) => setError(errorText(e)));
  const copy = async (c: McpClientConfig) => {
    setCopyOpen(false);
    try {
      await copyText(c.snippet);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const n = status?.running ? status.clients.length : 0;
  return (
    <div className={styles.popup}>
      <div className={styles.popupHeader}>
        <span className={styles.popupTitle}>
          <T>MCP Server</T>
        </span>
        <Toggle aria-label={t("Enable MCP Server")} checked={enabled} onChange={(v) => void setEnabled(v)} />
        <span className={styles.spacer} />
        <IconButton
          icon="settings"
          size="small"
          title="MCP Server Settings"
          onClick={run(() => executeAction("file.settings", MCP_SETTINGS_PAGE))}
        />
      </div>
      {!enabled ? (
        <div className={styles.popupBody}>
          <div className={styles.popupText}>
            <T>
              The MCP Server allows external AI clients to use functionality from the IDE, integrating the power of your
              IDE into your AI tools.
            </T>
          </div>
          {!!detected?.length && (
            <div className={styles.popupText}>
              {t("When enabled, these detected clients can be auto-configured to use IDE features in one click:")}{" "}
              {[...new Set(detected.map((d) => MCP_CLIENT_NAMES[d.client]))].join(", ")}
            </div>
          )}
        </div>
      ) : (
        <div className={styles.popupBody}>
          <div
            role="status"
            aria-label={t("Server status")}
            className={clsx(styles.popupText, status?.error && styles.error)}
          >
            {status?.running && status.url
              ? t`Running at ${status.url}`
              : status?.error
                ? t`Not running: ${status.error}`
                : t("MCP Server (Starting)")}
          </div>
          {status?.running && (
            <div className={styles.popupLinks}>
              <button
                type="button"
                className={styles.link}
                onClick={run(() => toolWindowService().show(MCP_TOOL_WINDOW, true))}
              >
                {n === 1 ? t("1 active connection") : n ? t`${n} active connections` : t("No active connections")}
              </button>
              <button
                type="button"
                className={styles.link}
                onClick={run(() => toolWindowService().show(MCP_TOOL_WINDOW, true))}
              >
                {calls === 1 ? t("1 recent tool call") : t`${calls} recent tool calls`}
              </button>
            </div>
          )}
          {status?.running && status.clients.length > 0 && (
            <ul className={styles.popupList} aria-label={t("Connected clients")}>
              {status.clients.map((c) => (
                <li key={`${c.name}@${c.version}`}>{t`${c.name} ${c.version}: ${c.calls} tool calls`}</li>
              ))}
            </ul>
          )}
          <DetectedClients detected={detected} />
          <Checkbox
            checked={brave}
            onChange={setBrave}
            label={
              <span data-tooltip={t("Run shell commands or run configurations without confirmation")}>
                {t("Brave mode")}
              </span>
            }
          />
        </div>
      )}
      {error && (
        <div className={clsx(styles.popupBody, styles.error)} role="alert">
          {error}
        </div>
      )}
      <div className={styles.popupFooter}>
        {enabled && (
          <button type="button" className={styles.link} aria-expanded={copyOpen} onClick={() => setCopyOpen((v) => !v)}>
            {t("Copy Config")} ▾
          </button>
        )}
        <button
          type="button"
          className={styles.link}
          onClick={run(() => executeAction("file.settings", MCP_TOOLS_PAGE))}
        >
          <T>All MCP Tools</T>
        </button>
        <button type="button" className={styles.link} onClick={run(() => exportToolsMarkdown())}>
          <T>Export to Markdown</T>
        </button>
        {enabled && (
          <button
            type="button"
            className={styles.link}
            onClick={run(() => toolWindowService().show(MCP_TOOL_WINDOW, true))}
          >
            <T>Show Tool Calls</T>
          </button>
        )}
      </div>
      {copyOpen && (
        <ul className={styles.copyList} aria-label={t("Copy JSON configuration for")}>
          {status?.url && (
            <li>
              <button type="button" className={styles.link} onClick={() => void copyUrl(status.url!, setError)}>
                {t("Copy server URL")}
              </button>
            </li>
          )}
          {configs.map((c) => (
            <li key={c.client}>
              <button type="button" className={styles.link} onClick={() => void copy(c)}>
                {MCP_CLIENT_NAMES[c.client] ?? c.client}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

async function copyUrl(url: string, setError: (e: string | null) => void) {
  try {
    await copyText(url);
    setError(null);
  } catch (e) {
    setError(errorText(e));
  }
}

type ClientButton = "configuring" | "configured" | { error: string };

function DetectedClients({ detected }: { detected: McpDetectedClient[] | null }) {
  const t = useTx();
  const [states, setStates] = useState<Record<string, ClientButton>>({});
  if (!detected) return null;
  const pending = clientsNeedingConfig(detected);
  if (!detected.length) return <div className={styles.popupHint}>{t("No supported clients detected")}</div>;
  const total = detected.length;
  if (!pending.length)
    return (
      <div className={styles.popupHint}>
        {detected.length === 1
          ? t("The detected client is configured")
          : t`All ${total} detected clients are configured`}
      </div>
    );
  const configure = async (d: McpDetectedClient) => {
    setStates((s) => ({ ...s, [d.client]: "configuring" }));
    try {
      await call(commands.mcpConfigureClient(d.client));
      setStates((s) => ({ ...s, [d.client]: "configured" }));
    } catch (e) {
      setStates((s) => ({ ...s, [d.client]: { error: errorText(e) } }));
    }
  };
  return (
    <ul className={styles.popupList} aria-label={t("Detected clients")}>
      {pending.map((d) => {
        const state = states[d.client];
        const mismatch = d.configured === true && !d.portCorrect;
        const name = MCP_CLIENT_NAMES[d.client];
        return (
          <li key={d.client} className={styles.popupClient}>
            <span className={styles.clientName}>{name}</span>
            <span className={styles.spacer} />
            {state === "configured" ? (
              <span className={styles.ok}>{t("Configured")}</span>
            ) : (
              <Button
                size="small"
                aria-label={t`Auto-Configure ${name}`}
                disabled={state === "configuring"}
                onClick={() => void configure(d)}
              >
                <T>Auto-Configure</T>
              </Button>
            )}
            {mismatch && state !== "configured" && (
              <div className={styles.popupWarning}>{t("Port mismatch detected – please reconfigure")}</div>
            )}
            {typeof state === "object" && (
              <div className={styles.error} role="alert">
                {t("Configuration failed")}: {state.error}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
