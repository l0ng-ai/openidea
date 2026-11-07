import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { call, commands, isTauri, type RunConfig, type TomcatInstallation, type WebArtifact } from "@/platform/ipc";
import { isRemoteWindow } from "@/platform/remote";
import { Button, Checkbox, Dialog, Icon, IconButton, Input, Menu, Select, T, type MenuItem } from "@/ui";
import { useTx } from "@/platform/i18n";
import { tomcatBrowserUrl } from "./tomcat";
import styles from "./Run.module.css";

export type TomcatTab = "server" | "deployment" | "logs" | "coverage" | "startup";
export type StartupRunnerId = "run" | "debug" | "cover" | "profile" | "visualgc";

export interface TomcatServerProfile {
  id: string;
  name: string;
  home: string;
  base: string;
  version: string;
  libraries: string[];
  tomee?: boolean;
}

export interface TomcatLogEntry {
  id: string;
  name: string;
  pattern: string;
  active: boolean;
  skipContent: boolean;
  builtin?: boolean;
}

const DEFAULT_TOMCAT_LOGS: ReadonlyArray<TomcatLogEntry> = [
  {
    id: "localhost",
    name: "Tomcat Localhost Log",
    pattern: "<CATALINA_BASE>/logs/localhost.*.log",
    active: true,
    skipContent: true,
    builtin: true,
  },
  {
    id: "catalina",
    name: "Tomcat Catalina Log",
    pattern: "<CATALINA_BASE>/logs/catalina.*.log",
    active: true,
    skipContent: true,
    builtin: true,
  },
  {
    id: "manager",
    name: "Tomcat Manager Log",
    pattern: "<CATALINA_BASE>/logs/manager.*.log",
    active: false,
    skipContent: true,
    builtin: true,
  },
  {
    id: "host-manager",
    name: "Tomcat Host Manager Log",
    pattern: "<CATALINA_BASE>/logs/host-manager.*.log",
    active: false,
    skipContent: true,
    builtin: true,
  },
  {
    id: "access",
    name: "Tomcat Localhost Access Log",
    pattern: "<CATALINA_BASE>/logs/localhost_access_log.*.txt",
    active: false,
    skipContent: true,
    builtin: true,
  },
];

const SERVERS_STORAGE_KEY = "openidea.tomcat.servers.v1";

function shortVersion(version: string): string {
  return version.replace(/^Apache Tomcat\//i, "").trim() || version;
}

function defaultServerName(home: string, version: string): string {
  const short = shortVersion(version);
  if (short && short !== "Apache Tomcat") return `Tomcat ${short}`;
  const base = home.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop();
  return base || "Tomcat";
}

function loadSavedServers(): TomcatServerProfile[] {
  try {
    const raw = localStorage.getItem(SERVERS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is TomcatServerProfile =>
        x && typeof x.id === "string" && typeof x.name === "string" && typeof x.home === "string",
    );
  } catch {
    return [];
  }
}

function saveServersToStorage(servers: TomcatServerProfile[]): void {
  try {
    localStorage.setItem(SERVERS_STORAGE_KEY, JSON.stringify(servers));
  } catch {
    // ignore storage errors
  }
}

function parseLogEntries(raw: string | undefined): TomcatLogEntry[] {
  if (!raw) return DEFAULT_TOMCAT_LOGS.map((l) => ({ ...l }));
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {
    // fallback to defaults
  }
  return DEFAULT_TOMCAT_LOGS.map((l) => ({ ...l }));
}

function parseEnvPairs(
  raw: string | undefined,
  runner: StartupRunnerId,
  debugPort: string,
): Array<{ name: string; value: string }> {
  if (raw !== undefined) {
    if (!raw.trim()) return [];
    return raw
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const idx = line.indexOf("=");
        return idx >= 0 ? { name: line.slice(0, idx), value: line.slice(idx + 1) } : { name: line, value: "" };
      });
  }
  if (runner === "run") return [{ name: "JAVA_OPTS", value: "" }];
  if (runner === "debug") {
    const port = debugPort || "60981";
    return [
      {
        name: "JAVA_OPTS",
        value: `-agentlib:jdwp=transport=dt_socket,address=127.0.0.1:${port},suspend=y,server=n`,
      },
    ];
  }
  return [];
}

function serializeEnvPairs(rows: ReadonlyArray<{ name: string; value: string }>): string {
  return rows.map((r) => `${r.name}=${r.value}`).join("\n");
}

async function pickLocalPath(directory: boolean, defaultPath?: string): Promise<string | null> {
  if (!isTauri() || isRemoteWindow()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory, multiple: false, defaultPath: defaultPath || undefined });
  return typeof picked === "string" ? picked : Array.isArray(picked) ? (picked[0] ?? null) : null;
}

/** Asynchronous installation validation, Application Servers dialog, 5-tab IDEA bar, and artifact discovery. */
export function TomcatSettings({ config, onChange }: { config: RunConfig; onChange: (config: RunConfig) => void }) {
  const tx = useTx();
  const [activeTab, setActiveTab] = useState<TomcatTab>("server");
  const [installations, setInstallations] = useState<TomcatInstallation[]>([]);
  const [savedServers, setSavedServers] = useState<TomcatServerProfile[]>(() => loadSavedServers());
  const [appServersOpen, setAppServersOpen] = useState(false);
  const [vmDialogOpen, setVmDialogOpen] = useState(false);
  const [deployMenuOpen, setDeployMenuOpen] = useState(false);
  const [jreMenuOpen, setJreMenuOpen] = useState(false);
  const [detectedJdks, setDetectedJdks] = useState<Array<{ label: string; path: string }>>([]);
  const [artifacts, setArtifacts] = useState<WebArtifact[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [selectedLogId, setSelectedLogId] = useState<string>("localhost");
  const [editingLogId, setEditingLogId] = useState<string | null>(null);
  const [selectedIncludeIdx, setSelectedIncludeIdx] = useState<number>(0);
  const [selectedExcludeIdx, setSelectedExcludeIdx] = useState<number>(0);
  const [startupRunner, setStartupRunner] = useState<StartupRunnerId>("run");
  const [selectedEnvIdx, setSelectedEnvIdx] = useState<number>(0);
  const [beforeLaunchOpen, setBeforeLaunchOpen] = useState(true);
  const deployAddRef = useRef<HTMLButtonElement>(null);
  const jreBtnRef = useRef<HTMLButtonElement>(null);
  const latest = useRef({ config, onChange });
  useEffect(() => {
    latest.current = { config, onChange };
  }, [config, onChange]);

  const setParams = (patch: Record<string, string>, nextName?: string) => {
    const { config, onChange } = latest.current;
    const nextParams = { ...(config.params ?? {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (v) nextParams[k] = v;
      else delete nextParams[k];
    }
    onChange({
      ...config,
      ...(nextName ? { name: nextName } : {}),
      params: nextParams,
    });
  };

  const select = (artifact: WebArtifact) => {
    const { config, onChange } = latest.current;
    onChange({
      ...config,
      cwd: artifact.module || null,
      params: {
        ...config.params,
        deployment: "artifact",
        artifact: artifact.id,
        artifactName: artifact.name,
        contextPath: config.params?.contextPath || `/${artifact.name}`,
      },
    });
  };

  useEffect(() => {
    let live = true;
    if (commands.runTomcatInstallations) {
      void call(commands.runTomcatInstallations())
        .then((items) => {
          if (!live) return;
          setInstallations(items);
          const { config, onChange } = latest.current;
          if (!config.params?.tomcatHome && items[0]) {
            const first = items[0];
            const isDefaultUnnamed = config.name === "Unnamed" || /^Unnamed \(\d+\)$/.test(config.name);
            onChange({
              ...config,
              ...(isDefaultUnnamed && first.name ? { name: first.name } : {}),
              params: {
                ...config.params,
                tomcatHome: first.path,
                ...(first.name ? { serverName: first.name } : {}),
                ...(first.base && first.base !== first.path ? { tomcatBase: first.base } : {}),
              },
            });
          }
        })
        .catch(() => {});
    }
    if (commands.sdkDetect) {
      void call(commands.sdkDetect("jdk"))
        .then((sdks) => {
          if (!live || !Array.isArray(sdks)) return;
          const jdks = sdks.map((s) => ({
            label: s.name || (s.version ? `${s.version} (${s.path})` : s.path),
            path: s.path,
          }));
          setDetectedJdks(jdks);
        })
        .catch(() => {});
    }
    void call(commands.runTomcatArtifacts())
      .then((items) => {
        if (!live) return;
        setArtifacts(items);
        if (!latest.current.config.params?.artifact && items[0]) select(items[0]);
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, []);

  const home = config.params?.tomcatHome ?? "";
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      setStatus("");
      setError("");
      if (home.trim())
        void call(commands.runTomcatHome(home))
          .then((info) => {
            if (live) setStatus(info.version);
          })
          .catch(() => {
            if (live) setError("Invalid Tomcat installation: check bin/catalina and lib/catalina.jar");
          });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [home]);

  const allServers: TomcatServerProfile[] = [...savedServers];
  for (const inst of installations) {
    if (!allServers.some((s) => s.home === inst.path)) {
      allServers.push({
        id: `detected:${inst.path}`,
        name: inst.name || defaultServerName(inst.path, inst.version),
        home: inst.path,
        base: inst.base || inst.path,
        version: shortVersion(inst.version),
        libraries: inst.libraries ?? [],
        tomee: inst.tomee,
      });
    }
  }
  if (home.trim() && !allServers.some((s) => s.home === home)) {
    allServers.push({
      id: `current:${home}`,
      name: config.params?.serverName || defaultServerName(home, status),
      home,
      base: config.params?.tomcatBase || home,
      version: shortVersion(status),
      libraries: config.params?.tomcatLibraries ? config.params.tomcatLibraries.split(";").filter(Boolean) : [],
    });
  }

  const deploymentKind = config.params?.deployment ?? "artifact";
  const noArtifactConfigured =
    (deploymentKind === "artifact" && !config.params?.artifact) ||
    (deploymentKind !== "artifact" && !config.params?.deploymentPath?.trim());

  const logEntries = parseLogEntries(config.params?.tomcatLogs);
  const updateLogs = (next: TomcatLogEntry[]) => setParams({ tomcatLogs: JSON.stringify(next) });

  const includePatterns = (config.params?.coverageInclude ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  const excludePatterns = (config.params?.coverageExclude ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  const useDefaultStartup = config.params?.useDefaultStartup !== "false";
  const useDefaultShutdown = config.params?.useDefaultShutdown !== "false";
  const defaultStartupCmd = home ? `${home.replace(/\/+$/, "")}/bin/catalina.sh run` : "bin/catalina.sh run";
  const defaultShutdownCmd = home ? `${home.replace(/\/+$/, "")}/bin/catalina.sh stop` : "bin/catalina.sh stop";

  const debugPort = config.params?.debugPort || (config.kind === "tomcat-remote" ? "5005" : "60981");
  const envParamKey =
    startupRunner === "debug"
      ? "startupEnvDebug"
      : startupRunner === "cover"
        ? "startupEnvCover"
        : startupRunner === "profile"
          ? "startupEnvProfile"
          : startupRunner === "visualgc"
            ? "startupEnvVisualgc"
            : "startupEnvRun";
  const rawEnvForRunner =
    config.params?.[envParamKey] ?? (startupRunner === "run" ? config.params?.startupEnv : undefined);
  const envRows = parseEnvPairs(rawEnvForRunner, startupRunner, debugPort);
  const setEnvRows = (next: Array<{ name: string; value: string }>) => {
    setParams({ [envParamKey]: serializeEnvPairs(next) });
  };

  const defaultJdkInfo = detectedJdks[0];
  const defaultJrePlaceholder = defaultJdkInfo
    ? `Default (${defaultJdkInfo.label.split(" ")[0]} - project SDK)`
    : "Default (project SDK)";

  const jreMenuItems: MenuItem[] = [
    {
      label: defaultJrePlaceholder,
      verbatim: true,
      run: () => setParams({ jre: "" }),
    },
    ...detectedJdks.map((jdk): MenuItem => ({
      label: jdk.label,
      verbatim: true,
      run: () => setParams({ jre: jdk.path }),
    })),
  ];

  const deployMenuItems: MenuItem[] = [
    ...(artifacts.length > 0
      ? artifacts.map((a): MenuItem => {
          const itemLabel = [a.name, "war exploded"].join(":");
          return {
            label: itemLabel,
            verbatim: true,
            icon: "file-archive",
            run: () => select(a),
          };
        })
      : []),
    {
      label: "External Source…",
      icon: "folder-open",
      run: () => {
        if (isTauri() && !isRemoteWindow()) {
          void pickLocalPath(true).then((picked) => {
            if (picked) {
              const folderName = picked.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || "app";
              setParams({
                deployment: picked.endsWith(".war") ? "war" : "directory",
                deploymentPath: picked,
                contextPath: config.params?.contextPath || `/${folderName}`,
              });
            }
          });
        } else {
          setParams({
            deployment: "directory",
            deploymentPath: "src/main/webapp",
            contextPath: config.params?.contextPath || "/",
          });
        }
      },
    },
  ];

  return (
    <div className={styles.tomcatContainer}>
      <div className={styles.tomcatTabs} role="tablist" aria-label={tx("Tomcat configuration tabs")}>
        {(
          [
            ["server", "Server"],
            ["deployment", "Deployment"],
            ["logs", "Logs"],
            ["coverage", "Code Coverage"],
            ["startup", "Startup/Connection"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            className={clsx(styles.tomcatTab, activeTab === id && styles.tomcatTabActive)}
            onClick={() => setActiveTab(id)}
          >
            <T>{label}</T>
          </button>
        ))}
      </div>

      {status && (
        <span className={styles.srOnly} role="status">
          {status}
        </span>
      )}
      {error && (
        <div className={styles.fieldError} role="alert">
          {tx(error)}
        </div>
      )}

      <div className={styles.tomcatScrollArea}>
        {activeTab === "server" && (
          <>
            <div className={styles.tomcatFormRow}>
              <span className={styles.tomcatRowLabel}>
                <T>Application server:</T>
              </span>
              <div className={styles.inputWithButton}>
                <Select
                  aria-label="Application server"
                  value={allServers.some((s) => s.home === home) ? home : null}
                  placeholder="Choose a detected Tomcat installation"
                  options={allServers.map((s) => ({
                    value: s.home,
                    label: s.name || s.home,
                  }))}
                  onChange={(selectedHome) => {
                    if (!selectedHome) return;
                    const srv = allServers.find((s) => s.home === selectedHome);
                    const shouldRename =
                      srv?.name &&
                      (config.name === "Unnamed" ||
                        /^Unnamed \(\d+\)$/.test(config.name) ||
                        config.name === config.params?.serverName);
                    setParams(
                      {
                        tomcatHome: selectedHome,
                        serverName: srv?.name ?? "",
                        tomcatBase: srv && srv.base !== srv.home ? srv.base : "",
                        tomcatLibraries: srv?.libraries.length ? srv.libraries.join(";") : "",
                      },
                      shouldRename ? srv.name : undefined,
                    );
                  }}
                />
                <Button size="small" onClick={() => setAppServersOpen(true)}>
                  <T>Configure...</T>
                </Button>
              </div>
            </div>

            <div className={styles.tomcatSection}>
              <div className={styles.tomcatSectionHeader}>
                <span>
                  <T>Open browser</T>
                </span>
                <span className={styles.tomcatSectionLine} />
              </div>
              <div className={styles.tomcatOpenBrowserControls}>
                <Checkbox
                  checked={config.params?.openBrowser === "true"}
                  onChange={(on) => setParams({ openBrowser: on ? "true" : "false" })}
                  label="After launch"
                />
                <div className={styles.tomcatBrowserSelect}>
                  <Select
                    aria-label="Browser"
                    value={config.params?.browserName || "default"}
                    options={[
                      { value: "default", label: "🌐 Default" },
                      { value: "chrome", label: "Chrome" },
                      { value: "safari", label: "Safari" },
                      { value: "firefox", label: "Firefox" },
                    ]}
                    onChange={(v) => setParams({ browserName: v === "default" ? "" : v })}
                  />
                </div>
                <button
                  type="button"
                  className={styles.tomcatDotsBtn}
                  aria-label="Configure Browsers"
                  title="Configure Browsers…"
                >
                  ...
                </button>
                <Checkbox
                  checked={config.params?.jsDebugger === "true"}
                  disabled={config.params?.openBrowser !== "true"}
                  onChange={(on) => setParams({ jsDebugger: on ? "true" : "" })}
                  label="with JavaScript debugger"
                />
              </div>
              <div className={styles.tomcatUrlRow}>
                <span className={styles.tomcatUrlLabel}>
                  <T>URL:</T>
                </span>
                <div className={styles.tomcatInputInside}>
                  <Input
                    mono
                    aria-label="Browser URL"
                    value={config.params?.browserUrl || tomcatBrowserUrl(config)}
                    onChange={(e) => setParams({ browserUrl: e.target.value })}
                  />
                  <IconButton
                    icon="folder-open"
                    size="small"
                    iconSize={13}
                    title="Browse… (⇧⏎)"
                    className={styles.tomcatInlineIconBtn}
                    onClick={() => {
                      if (isTauri() && !isRemoteWindow()) {
                        void pickLocalPath(false).then((picked) => {
                          if (picked) setParams({ browserUrl: picked });
                        });
                      }
                    }}
                  />
                </div>
              </div>
            </div>

            <div className={styles.tomcatDivider} />

            <div className={styles.tomcatFormRow}>
              <span className={styles.tomcatRowLabel}>
                <T>VM options:</T>
              </span>
              <div className={styles.tomcatInputInside}>
                <Input
                  mono
                  aria-label="VM options"
                  value={config.params?.vmOptions ?? ""}
                  onChange={(e) => setParams({ vmOptions: e.target.value })}
                />
                <IconButton
                  icon="expand-all"
                  size="small"
                  iconSize={13}
                  title="Expand (⇧⏎)"
                  className={styles.tomcatInlineIconBtn}
                  onClick={() => setVmDialogOpen(true)}
                />
              </div>
            </div>

            <div className={styles.tomcatFormRow}>
              <span className={styles.tomcatRowLabel}>
                <T>On 'Update' action:</T>
              </span>
              <div className={styles.tomcatUpdateRow}>
                <div className={styles.tomcatUpdateSelect}>
                  <Select
                    aria-label="On 'Update' action"
                    value={
                      config.params?.onUpdate && !(noArtifactConfigured && config.params.onUpdate === "ask")
                        ? config.params.onUpdate
                        : noArtifactConfigured
                          ? "restart"
                          : "ask"
                    }
                    options={[
                      { value: "restart", label: "Restart server" },
                      { value: "redeploy", label: "Redeploy" },
                      { value: "resources", label: "Update resources" },
                      { value: "classes", label: "Update classes and resources" },
                      { value: "ask", label: "Show chooser" },
                    ]}
                    onChange={(v) => setParams({ onUpdate: v })}
                  />
                </div>
                <Checkbox
                  checked={config.params?.updateShowDialog !== "false"}
                  onChange={(on) => setParams({ updateShowDialog: on ? "true" : "false" })}
                  label="Show dialog"
                />
              </div>
            </div>

            {(!noArtifactConfigured || !!config.params?.onDeactivation) && (
              <div className={styles.tomcatFormRow}>
                <span className={styles.tomcatRowLabel}>
                  <T>On frame deactivation:</T>
                </span>
                <div className={styles.tomcatUpdateSelect}>
                  <Select
                    aria-label="On frame deactivation"
                    value={config.params?.onDeactivation || "none"}
                    options={[
                      { value: "none", label: "Do nothing" },
                      { value: "resources", label: "Update resources" },
                      { value: "classes", label: "Update classes and resources" },
                    ]}
                    onChange={(v) => setParams({ onDeactivation: v })}
                  />
                </div>
              </div>
            )}

            {config.kind !== "tomcat-remote" && (
              <div className={styles.tomcatFormRow}>
                <span className={styles.tomcatRowLabel}>
                  <T>JRE:</T>
                </span>
                <div className={styles.tomcatInputInside}>
                  <Input
                    mono
                    aria-label="JRE"
                    value={config.params?.jre ?? ""}
                    placeholder={defaultJrePlaceholder}
                    onChange={(e) => setParams({ jre: e.target.value })}
                  />
                  {isTauri() && !isRemoteWindow() && (
                    <IconButton
                      icon="folder-open"
                      size="small"
                      iconSize={13}
                      title="Browse…"
                      className={styles.tomcatInlineIconBtn}
                      onClick={() =>
                        void pickLocalPath(true, config.params?.jre || undefined).then((picked) => {
                          if (picked) setParams({ jre: picked });
                        })
                      }
                    />
                  )}
                  <IconButton
                    ref={jreBtnRef}
                    icon="chevron-down"
                    size="small"
                    iconSize={12}
                    title="Select JRE"
                    className={styles.tomcatInlineChevronBtn}
                    onClick={() => setJreMenuOpen((v) => !v)}
                  />
                  <Menu
                    open={jreMenuOpen}
                    anchor={jreBtnRef}
                    items={jreMenuItems}
                    placement="bottom-end"
                    onClose={() => setJreMenuOpen(false)}
                  />
                </div>
              </div>
            )}

            {config.kind === "tomcat-remote" && (
              <>
                <div className={styles.tomcatFormRow}>
                  <span className={styles.tomcatRowLabel}>
                    <T>Remote host:</T>
                  </span>
                  <Input
                    mono
                    aria-label="Remote host"
                    value={config.params?.remoteHost ?? "localhost"}
                    placeholder="localhost"
                    onChange={(e) => setParams({ remoteHost: e.target.value })}
                  />
                </div>
                <div className={styles.tomcatFormRow}>
                  <span className={styles.tomcatRowLabel}>
                    <T>Remote staging:</T>
                  </span>
                  <Select
                    aria-label="Remote staging"
                    value={config.params?.remoteStaging || "local"}
                    options={[
                      { value: "local", label: "Same file system (mounted)" },
                      { value: "manager", label: "Tomcat Manager" },
                      { value: "sftp", label: "SFTP / SSH" },
                    ]}
                    onChange={(v) => setParams({ remoteStaging: v })}
                  />
                </div>
                {(config.params?.remoteStaging ?? "local") === "manager" ? (
                  <div className={styles.tomcatFormRow}>
                    <span className={styles.tomcatRowLabel}>
                      <T>Tomcat Manager URL:</T>
                    </span>
                    <Input
                      mono
                      aria-label="Tomcat Manager URL"
                      value={config.params?.managerUrl ?? ""}
                      placeholder="http://localhost:8080/manager/text"
                      onChange={(e) => setParams({ managerUrl: e.target.value })}
                    />
                  </div>
                ) : (
                  <div className={styles.tomcatFormRow}>
                    <span className={styles.tomcatRowLabel}>
                      <T>Remote staging path:</T>
                    </span>
                    <div className={styles.tomcatInputInside}>
                      <Input
                        mono
                        aria-label="Remote staging path"
                        value={config.params?.remoteStagingPath ?? ""}
                        placeholder="/var/lib/tomcat/webapps"
                        onChange={(e) => setParams({ remoteStagingPath: e.target.value })}
                      />
                      {isTauri() && !isRemoteWindow() && (
                        <IconButton
                          icon="folder-open"
                          size="small"
                          iconSize={13}
                          title="Browse…"
                          className={styles.tomcatInlineIconBtn}
                          onClick={() =>
                            void pickLocalPath(true, config.params?.remoteStagingPath || undefined).then((picked) => {
                              if (picked) setParams({ remoteStagingPath: picked });
                            })
                          }
                        />
                      )}
                    </div>
                  </div>
                )}
              </>
            )}

            <div className={styles.tomcatSection}>
              <div className={styles.tomcatSectionHeader}>
                <span>
                  <T>Tomcat Server Settings</T>
                </span>
                <span className={styles.tomcatSectionLine} />
              </div>
              <div className={styles.tomcatServerSettingsGrid}>
                <div className={styles.tomcatPortsCol}>
                  <div className={styles.tomcatPortField}>
                    <span className={styles.fieldLabel}>
                      <T>HTTP port:</T>
                    </span>
                    <Input
                      mono
                      aria-label="HTTP port"
                      value={config.params?.httpPort ?? "8080"}
                      onChange={(e) => setParams({ httpPort: e.target.value })}
                    />
                  </div>
                  <div className={styles.tomcatPortField}>
                    <span className={styles.fieldLabel}>
                      <T>HTTPs port:</T>
                    </span>
                    <Input
                      mono
                      aria-label="HTTPS port"
                      value={config.params?.httpsPort ?? ""}
                      onChange={(e) => setParams({ httpsPort: e.target.value })}
                    />
                  </div>
                  <div className={styles.tomcatPortField}>
                    <span className={styles.fieldLabel}>
                      <T>JMX port:</T>
                    </span>
                    <Input
                      mono
                      aria-label="JMX port"
                      value={config.params?.jmxPort ?? "1099"}
                      onChange={(e) => setParams({ jmxPort: e.target.value })}
                    />
                  </div>
                  <div className={styles.tomcatPortField}>
                    <span className={styles.fieldLabel}>
                      <T>AJP port:</T>
                    </span>
                    <Input
                      mono
                      aria-label="AJP port"
                      value={config.params?.ajpPort ?? ""}
                      onChange={(e) => setParams({ ajpPort: e.target.value })}
                    />
                  </div>
                </div>
                <div className={styles.tomcatFlagsCol}>
                  <Checkbox
                    checked={config.params?.deployTomcatApps === "true"}
                    onChange={(on) => setParams({ deployTomcatApps: on ? "true" : "" })}
                    label="Deploy applications configured in Tomcat instance"
                  />
                  <Checkbox
                    checked={config.params?.preserveSessions === "true"}
                    onChange={(on) => setParams({ preserveSessions: on ? "true" : "" })}
                    label="Preserve sessions across restarts and redeploys"
                  />
                </div>
              </div>
            </div>
          </>
        )}

        {activeTab === "deployment" && (
          <div className={styles.tomcatSection}>
            <div className={styles.tomcatSectionHeader}>
              <span>
                <T>Deploy at the server startup</T>
              </span>
              <span className={styles.tomcatSectionLine} />
            </div>
            <div className={clsx(styles.tomcatBoxPanel, styles.tomcatDeployPanel)}>
              <div className={styles.appServersToolbar} role="toolbar" aria-label={tx("Deploy at the server startup")}>
                <IconButton
                  ref={deployAddRef}
                  icon="plus"
                  size="small"
                  iconSize={14}
                  title="Add"
                  onClick={() => {
                    if (artifacts.length > 0 && !isTauri()) {
                      select(artifacts[0]!);
                      return;
                    }
                    setDeployMenuOpen((v) => !v);
                  }}
                />
                <Menu
                  open={deployMenuOpen}
                  anchor={deployAddRef}
                  items={deployMenuItems}
                  placement="bottom-start"
                  onClose={() => setDeployMenuOpen(false)}
                />
                <IconButton
                  icon="minus"
                  size="small"
                  iconSize={14}
                  title="Remove"
                  disabled={noArtifactConfigured}
                  onClick={() => setParams({ artifact: "", artifactName: "", deploymentPath: "" })}
                />
                <IconButton icon="arrow-up" size="small" iconSize={13} title="Up" disabled />
                <IconButton icon="arrow-down" size="small" iconSize={13} title="Down" disabled />
                <IconButton
                  icon="edit"
                  size="small"
                  iconSize={13}
                  title="Edit Artifact"
                  disabled={noArtifactConfigured}
                />
              </div>
              {noArtifactConfigured ? (
                <div className={styles.tomcatBoxEmpty}>
                  <T>Nothing to deploy</T>
                </div>
              ) : (
                <div className={styles.appServersList}>
                  <div className={clsx(styles.editItem, styles.editItemSelected)}>
                    <Icon name="file-archive" size={13} className={styles.chooserIcon} />
                    <span className={styles.chooserName}>
                      {deploymentKind === "artifact"
                        ? `${config.params?.artifactName || config.params?.artifact}:war exploded`
                        : config.params?.deploymentPath}
                    </span>
                    <span className={styles.chooserMuted}>{config.params?.contextPath || "/"}</span>
                  </div>
                </div>
              )}
            </div>

            {!noArtifactConfigured && (
              <>
                <div className={styles.tomcatFormRow}>
                  <span className={styles.tomcatRowLabel}>
                    <T>Application context:</T>
                  </span>
                  <Input
                    mono
                    aria-label="Context path"
                    value={config.params?.contextPath ?? "/"}
                    placeholder="/"
                    onChange={(e) => setParams({ contextPath: e.target.value })}
                  />
                </div>
                <div className={styles.tomcatFormRow}>
                  <span className={styles.tomcatRowLabel}>
                    <T>Context descriptor:</T>
                  </span>
                  <div className={styles.tomcatInputInside}>
                    <Input
                      mono
                      aria-label="Context descriptor"
                      value={config.params?.contextDescriptor ?? ""}
                      placeholder="META-INF/context.xml from application"
                      onChange={(e) => setParams({ contextDescriptor: e.target.value })}
                    />
                    {isTauri() && !isRemoteWindow() && (
                      <IconButton
                        icon="folder-open"
                        size="small"
                        iconSize={13}
                        title="Browse…"
                        className={styles.tomcatInlineIconBtn}
                        onClick={() =>
                          void pickLocalPath(false, config.params?.contextDescriptor || undefined).then((picked) => {
                            if (picked) setParams({ contextDescriptor: picked });
                          })
                        }
                      />
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {activeTab === "logs" && (
          <div className={styles.tomcatSection}>
            <div className={styles.tomcatPlainLabel}>
              <span>
                <T>Log files to be shown in console</T>
              </span>
              <span>:</span>
            </div>
            <div className={clsx(styles.tomcatBoxPanel, styles.tomcatLogsPanel)}>
              <div className={styles.appServersToolbar} role="toolbar" aria-label={tx("Log files toolbar")}>
                <IconButton
                  icon="plus"
                  size="small"
                  iconSize={14}
                  title="Add"
                  onClick={() => {
                    const id = `custom:${Date.now()}`;
                    const next = [
                      ...logEntries,
                      {
                        id,
                        name: "Custom Tomcat Log",
                        pattern: "<CATALINA_BASE>/logs/custom.*.log",
                        active: true,
                        skipContent: true,
                      },
                    ];
                    updateLogs(next);
                    setSelectedLogId(id);
                    setEditingLogId(id);
                  }}
                />
                <IconButton
                  icon="minus"
                  size="small"
                  iconSize={14}
                  title="Remove"
                  disabled={!selectedLogId || logEntries.find((l) => l.id === selectedLogId)?.builtin}
                  onClick={() => {
                    const next = logEntries.filter((l) => l.id !== selectedLogId);
                    updateLogs(next);
                    setSelectedLogId(next[0]?.id ?? "");
                  }}
                />
                <IconButton
                  icon="edit"
                  size="small"
                  iconSize={13}
                  title="Edit"
                  disabled={!selectedLogId}
                  onClick={() => setEditingLogId((prev) => (prev === selectedLogId ? null : selectedLogId))}
                />
              </div>
              <div className={styles.tomcatLogHeader}>
                <span>
                  <T>Is Active</T>
                </span>
                <span>
                  <T>Log File Entry</T>
                </span>
                <span>
                  <T>Skip Content</T>
                </span>
              </div>
              <div className={styles.appServersList} role="list" aria-label={tx("Log file entries")}>
                {logEntries.map((entry) => {
                  const sel = entry.id === selectedLogId;
                  return (
                    <div
                      key={entry.id}
                      role="listitem"
                      className={clsx(styles.tomcatLogRow, sel && styles.tomcatLogRowSelected)}
                      onClick={() => setSelectedLogId(entry.id)}
                    >
                      <span className={styles.tomcatLogCheckCell}>
                        <Checkbox
                          checked={entry.active}
                          aria-label={entry.name}
                          onChange={(on) =>
                            updateLogs(logEntries.map((l) => (l.id === entry.id ? { ...l, active: on } : l)))
                          }
                        />
                      </span>
                      {editingLogId === entry.id ? (
                        <div className={styles.inputWithButton}>
                          <Input
                            aria-label="Log entry name"
                            value={entry.name}
                            onChange={(e) =>
                              updateLogs(
                                logEntries.map((l) => (l.id === entry.id ? { ...l, name: e.target.value } : l)),
                              )
                            }
                          />
                          <Input
                            mono
                            aria-label="Log file pattern"
                            value={entry.pattern}
                            onChange={(e) =>
                              updateLogs(
                                logEntries.map((l) => (l.id === entry.id ? { ...l, pattern: e.target.value } : l)),
                              )
                            }
                          />
                        </div>
                      ) : (
                        <span className={styles.chooserName} title={entry.pattern}>
                          {tx(entry.name)}
                        </span>
                      )}
                      <span className={styles.tomcatLogCheckCell}>
                        <Checkbox
                          checked={entry.skipContent}
                          disabled={!!entry.builtin}
                          aria-label="Skip Content"
                          onChange={(on) =>
                            updateLogs(logEntries.map((l) => (l.id === entry.id ? { ...l, skipContent: on } : l)))
                          }
                        />
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className={styles.tomcatSaveLogRow}>
              <Checkbox
                checked={config.outputFile !== null && config.outputFile !== undefined}
                onChange={(on) => onChange({ ...config, outputFile: on ? config.outputFile || "" : null })}
                label="Save console output to file:"
              />
              <div className={styles.tomcatInputInside}>
                <Input
                  mono
                  aria-label="Console output file"
                  disabled={config.outputFile === null || config.outputFile === undefined}
                  value={config.outputFile ?? ""}
                  onChange={(e) => onChange({ ...config, outputFile: e.target.value })}
                />
                {isTauri() && !isRemoteWindow() && (
                  <IconButton
                    icon="folder-open"
                    size="small"
                    iconSize={13}
                    title="Browse… (⇧⏎)"
                    disabled={config.outputFile === null || config.outputFile === undefined}
                    className={styles.tomcatInlineIconBtn}
                    onClick={() =>
                      void pickLocalPath(false, config.outputFile || undefined).then((picked) => {
                        if (picked) onChange({ ...config, outputFile: picked });
                      })
                    }
                  />
                )}
              </div>
            </div>
            <Checkbox
              checked={!!config.showOnStdout}
              onChange={(on) => onChange({ ...config, showOnStdout: on })}
              label="Show console when a message is printed to standard output stream"
            />
            <Checkbox
              checked={!!config.showOnStderr}
              onChange={(on) => onChange({ ...config, showOnStderr: on })}
              label="Show console when a message is printed to standard error stream"
            />
          </div>
        )}

        {activeTab === "coverage" && (
          <div className={styles.tomcatSection}>
            <div className={styles.tomcatSectionHeader}>
              <span>
                <T>Packages and classes to include in coverage data</T>
              </span>
              <span className={styles.tomcatSectionLine} />
            </div>
            <div className={clsx(styles.tomcatBoxPanel, styles.tomcatCoveragePanel)} aria-label="Include packages">
              <div className={styles.appServersToolbar} role="toolbar" aria-label={tx("Include coverage patterns")}>
                <IconButton
                  icon="minus"
                  size="small"
                  iconSize={14}
                  title="Remove"
                  disabled={includePatterns.length === 0}
                  onClick={() => {
                    const next = includePatterns.filter((_, i) => i !== selectedIncludeIdx);
                    setParams({ coverageInclude: next.join(";") });
                    setSelectedIncludeIdx(0);
                  }}
                />
                <IconButton
                  icon="plus"
                  size="small"
                  iconSize={14}
                  title="Add"
                  onClick={() => {
                    const next = [...includePatterns, "*"];
                    setParams({ coverageInclude: next.join(";") });
                    setSelectedIncludeIdx(next.length - 1);
                  }}
                />
              </div>
              {includePatterns.length === 0 ? (
                <div className={styles.tomcatBoxEmpty}>
                  <T>No class patterns configured</T>
                </div>
              ) : (
                <div className={styles.appServersList}>
                  {includePatterns.map((pat, idx) => (
                    <div
                      key={idx}
                      className={clsx(styles.editItem, idx === selectedIncludeIdx && styles.editItemSelected)}
                      onClick={() => setSelectedIncludeIdx(idx)}
                    >
                      <Input
                        mono
                        aria-label="Include package pattern"
                        value={pat}
                        onChange={(e) => {
                          const next = includePatterns.map((p, i) => (i === idx ? e.target.value : p));
                          setParams({ coverageInclude: next.join(";") });
                        }}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className={styles.tomcatSectionHeader}>
              <span>
                <T>Packages and classes to exclude from coverage data</T>
              </span>
              <span className={styles.tomcatSectionLine} />
            </div>
            <div className={clsx(styles.tomcatBoxPanel, styles.tomcatCoveragePanel)}>
              <div className={styles.appServersToolbar} role="toolbar" aria-label={tx("Exclude coverage patterns")}>
                <IconButton
                  icon="minus"
                  size="small"
                  iconSize={14}
                  title="Remove"
                  disabled={excludePatterns.length === 0}
                  onClick={() => {
                    const next = excludePatterns.filter((_, i) => i !== selectedExcludeIdx);
                    setParams({ coverageExclude: next.join(";") });
                    setSelectedExcludeIdx(0);
                  }}
                />
                <IconButton
                  icon="plus"
                  size="small"
                  iconSize={14}
                  title="Add"
                  onClick={() => {
                    const next = [...excludePatterns, "*Test*"];
                    setParams({ coverageExclude: next.join(";") });
                    setSelectedExcludeIdx(next.length - 1);
                  }}
                />
              </div>
              {excludePatterns.length === 0 ? (
                <div className={styles.tomcatBoxEmpty}>
                  <T>No class patterns configured</T>
                </div>
              ) : (
                <div className={styles.appServersList}>
                  {excludePatterns.map((pat, idx) => (
                    <div
                      key={idx}
                      className={clsx(styles.editItem, idx === selectedExcludeIdx && styles.editItemSelected)}
                      onClick={() => setSelectedExcludeIdx(idx)}
                    >
                      <Input
                        mono
                        aria-label="Exclude package pattern"
                        value={pat}
                        onChange={(e) => {
                          const next = excludePatterns.map((p, i) => (i === idx ? e.target.value : p));
                          setParams({ coverageExclude: next.join(";") });
                        }}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === "startup" && (
          <div className={styles.tomcatSection}>
            <div className={styles.tomcatRunnerList} role="listbox" aria-label={tx("Startup runners")}>
              {(
                [
                  ["run", "run", "Run"],
                  ["debug", "debug", "Debug"],
                  ["cover", "run-coverage", "Cover"],
                  ["profile", "profile", "Profile"],
                  ["visualgc", "visualgc", "Run VisualGC"],
                ] as const
              ).map(([id, icon, label]) => {
                const sel = startupRunner === id;
                return (
                  <button
                    key={id}
                    type="button"
                    role="option"
                    aria-selected={sel}
                    className={clsx(styles.editItem, sel && styles.editItemSelected)}
                    onClick={() => setStartupRunner(id)}
                  >
                    <Icon name={icon} size={13} className={styles.chooserIcon} />
                    <span className={styles.chooserName}>
                      <T>{label}</T>
                    </span>
                  </button>
                );
              })}
            </div>

            <div className={styles.tomcatFormRow}>
              <span className={styles.tomcatRowLabel}>
                <T>Startup script:</T>
              </span>
              <div className={styles.tomcatScriptRow}>
                <div className={styles.tomcatInputInside}>
                  <Input
                    mono
                    aria-label="Startup script"
                    disabled={useDefaultStartup}
                    value={useDefaultStartup ? defaultStartupCmd : (config.params?.startupScript ?? "")}
                    placeholder="Default (bin/catalina.sh run)"
                    onChange={(e) => setParams({ startupScript: e.target.value, useDefaultStartup: "false" })}
                  />
                  {isTauri() && !isRemoteWindow() && (
                    <IconButton
                      icon="folder-open"
                      size="small"
                      iconSize={13}
                      title="Browse…"
                      disabled={useDefaultStartup}
                      className={styles.tomcatInlineIconBtn}
                      onClick={() =>
                        void pickLocalPath(false, home || undefined).then((picked) => {
                          if (picked) setParams({ startupScript: picked, useDefaultStartup: "false" });
                        })
                      }
                    />
                  )}
                </div>
                <Checkbox
                  checked={useDefaultStartup}
                  onChange={(on) => setParams({ useDefaultStartup: on ? "true" : "false" })}
                  label="Use default"
                />
              </div>
            </div>

            <div className={styles.tomcatFormRow}>
              <span className={styles.tomcatRowLabel}>
                <T>Shutdown script:</T>
              </span>
              <div className={styles.tomcatScriptRow}>
                <div className={styles.tomcatInputInside}>
                  <Input
                    mono
                    aria-label="Shutdown script"
                    disabled={useDefaultShutdown}
                    value={useDefaultShutdown ? defaultShutdownCmd : (config.params?.shutdownScript ?? "")}
                    placeholder="Default (bin/catalina.sh stop)"
                    onChange={(e) => setParams({ shutdownScript: e.target.value, useDefaultShutdown: "false" })}
                  />
                  {isTauri() && !isRemoteWindow() && (
                    <IconButton
                      icon="folder-open"
                      size="small"
                      iconSize={13}
                      title="Browse…"
                      disabled={useDefaultShutdown}
                      className={styles.tomcatInlineIconBtn}
                      onClick={() =>
                        void pickLocalPath(false, home || undefined).then((picked) => {
                          if (picked) setParams({ shutdownScript: picked, useDefaultShutdown: "false" });
                        })
                      }
                    />
                  )}
                </div>
                <Checkbox
                  checked={useDefaultShutdown}
                  onChange={(on) => setParams({ useDefaultShutdown: on ? "true" : "false" })}
                  label="Use default"
                />
              </div>
            </div>

            <div className={styles.tomcatSectionHeader}>
              <span>
                <T>Environment Variables</T>
              </span>
              <span className={styles.tomcatSectionLine} />
            </div>
            <Checkbox
              checked={config.params?.passEnvVars !== "false"}
              onChange={(on) => setParams({ passEnvVars: on ? "true" : "false" })}
              label="Pass environment variables"
            />
            <div className={clsx(styles.tomcatBoxPanel, styles.tomcatEnvPanel)}>
              <div className={styles.appServersToolbar} role="toolbar" aria-label={tx("Startup environment variables")}>
                <IconButton
                  icon="plus"
                  size="small"
                  iconSize={14}
                  title="Add"
                  onClick={() => {
                    const next = [...envRows, { name: `VAR_${envRows.length + 1}`, value: "" }];
                    setEnvRows(next);
                    setSelectedEnvIdx(next.length - 1);
                  }}
                />
                <IconButton
                  icon="minus"
                  size="small"
                  iconSize={14}
                  title="Remove"
                  disabled={envRows.length === 0 || (envRows.length === 1 && envRows[0]?.name === "JAVA_OPTS")}
                  onClick={() => {
                    const next = envRows.filter((_, i) => i !== selectedEnvIdx);
                    setEnvRows(next);
                    setSelectedEnvIdx(0);
                  }}
                />
                <IconButton
                  icon="copy"
                  size="small"
                  iconSize={13}
                  title="Copy"
                  disabled={envRows.length === 0}
                  onClick={() => {
                    const row = envRows[selectedEnvIdx];
                    if (row) void navigator.clipboard?.writeText(`${row.name}=${row.value}`);
                  }}
                />
                <IconButton
                  icon="paste"
                  size="small"
                  iconSize={13}
                  title="Paste"
                  onClick={() => {
                    void navigator.clipboard?.readText().then((text) => {
                      if (!text.trim()) return;
                      const idx = text.indexOf("=");
                      const name = idx >= 0 ? text.slice(0, idx).trim() : text.trim();
                      const value = idx >= 0 ? text.slice(idx + 1).trim() : "";
                      setEnvRows([...envRows, { name, value }]);
                    });
                  }}
                />
              </div>
              <div className={styles.tomcatEnvHeader}>
                <span>
                  <T>Name</T>
                </span>
                <span>
                  <T>Value</T>
                </span>
              </div>
              {envRows.length === 0 ? (
                <div className={styles.tomcatBoxEmpty}>
                  <T>No variables</T>
                </div>
              ) : (
                <div className={styles.appServersList}>
                  {envRows.map((row, idx) => (
                    <div
                      key={idx}
                      className={clsx(styles.tomcatEnvRow, idx === selectedEnvIdx && styles.tomcatEnvRowSelected)}
                      onClick={() => setSelectedEnvIdx(idx)}
                    >
                      <Input
                        mono
                        aria-label="Variable name"
                        value={row.name}
                        onChange={(e) =>
                          setEnvRows(envRows.map((r, i) => (i === idx ? { ...r, name: e.target.value } : r)))
                        }
                      />
                      <Input
                        mono
                        aria-label="Variable value"
                        value={row.value}
                        onChange={(e) =>
                          setEnvRows(envRows.map((r, i) => (i === idx ? { ...r, value: e.target.value } : r)))
                        }
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>

            {startupRunner === "debug" && (
              <div className={styles.tomcatDebugConnectionSection}>
                <div className={styles.tomcatDebugTransportRow}>
                  <span className={styles.tomcatDebugLabel}>
                    <T>Transport:</T>
                  </span>
                  <label className={styles.tomcatRadioLabel}>
                    <input type="radio" checked readOnly disabled />
                    <span>
                      <T>Socket</T>
                    </span>
                  </label>
                  <label className={styles.tomcatRadioLabel}>
                    <input type="radio" checked={false} readOnly disabled />
                    <span>
                      <T>Shared memory</T>
                    </span>
                  </label>
                </div>
                <div className={styles.tomcatDebugPortRow}>
                  <span className={styles.tomcatDebugLabel}>
                    <T>Port:</T>
                  </span>
                  <div className={styles.tomcatDebugPortInput}>
                    <Input
                      mono
                      aria-label="Debug port"
                      value={debugPort}
                      onChange={(e) => setParams({ debugPort: e.target.value })}
                    />
                  </div>
                  <div className={styles.tomcatDebugSettingsBtnWrap}>
                    <Button size="small">
                      <T>Debugger Settings...</T>
                    </Button>
                  </div>
                </div>
                {config.kind === "tomcat-remote" && (
                  <div className={styles.tomcatFormRow}>
                    <span className={styles.tomcatRowLabel}>
                      <T>Command line arguments for remote JVM</T>
                    </span>
                    <Input
                      mono
                      readOnly
                      aria-label="Command line arguments for remote JVM"
                      value={`-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:${config.params?.debugPort || "5005"}`}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div className={styles.tomcatSection}>
          <div className={styles.tomcatSectionHeader}>
            <button type="button" className={styles.tomcatSectionToggle} onClick={() => setBeforeLaunchOpen((v) => !v)}>
              <Icon name={beforeLaunchOpen ? "chevron-down" : "chevron-right"} size={12} />
              <T>Before launch</T>
            </button>
            <span className={styles.tomcatSectionLine} />
          </div>
          {beforeLaunchOpen && (
            <>
              <div className={clsx(styles.tomcatBoxPanel, styles.tomcatBoxSmall)}>
                <div className={styles.appServersToolbar} role="toolbar" aria-label={tx("Before launch tasks")}>
                  <IconButton
                    icon="plus"
                    size="small"
                    iconSize={14}
                    title="Add"
                    onClick={() => setParams({ buildArtifact: "true" })}
                  />
                  <IconButton
                    icon="minus"
                    size="small"
                    iconSize={14}
                    title="Remove"
                    disabled={config.params?.buildArtifact === "false"}
                    onClick={() => setParams({ buildArtifact: "false" })}
                  />
                  <IconButton icon="edit" size="small" iconSize={13} title="Edit" disabled />
                  <IconButton icon="arrow-up" size="small" iconSize={13} title="Up" disabled />
                  <IconButton icon="arrow-down" size="small" iconSize={13} title="Down" disabled />
                </div>
                <div className={styles.appServersList}>
                  {config.params?.buildArtifact !== "false" && (
                    <div className={styles.editItem}>
                      <Icon name="build-project" size={13} className={styles.chooserIcon} />
                      <span className={styles.chooserName}>
                        <T>Build</T>
                      </span>
                    </div>
                  )}
                </div>
              </div>
              <div className={styles.tomcatBeforeLaunchFooter}>
                <Checkbox
                  checked={config.params?.showSettingsBeforeRun === "true"}
                  onChange={(on) => setParams({ showSettingsBeforeRun: on ? "true" : "" })}
                  label="Show this page"
                />
                <Checkbox
                  checked={config.openToolWindow !== false}
                  onChange={(on) => onChange({ ...config, openToolWindow: on })}
                  label="Activate tool window"
                />
                <Checkbox
                  checked={!!config.focusToolWindow}
                  onChange={(on) => onChange({ ...config, focusToolWindow: on })}
                  label="Focus tool window"
                />
              </div>
            </>
          )}
        </div>
      </div>

      {noArtifactConfigured && (
        <div className={styles.tomcatWarningBar} role="region" aria-label={tx("Configuration warnings")}>
          <span className={styles.tomcatWarningText}>
            <Icon name="warning" size={14} />
            <T>Warning: No artifacts configured</T>
          </span>
          <Button
            size="small"
            icon="bulb-fix"
            onClick={() => {
              setActiveTab("deployment");
              if (artifacts[0]) select(artifacts[0]);
              else setParams({ deployment: "directory" });
            }}
          >
            <T>Fix</T>
          </Button>
        </div>
      )}

      {vmDialogOpen && (
        <Dialog
          open
          onClose={() => setVmDialogOpen(false)}
          title="VM Options"
          width={520}
          buttons={[{ label: "OK", role: "default", onClick: () => setVmDialogOpen(false) }]}
        >
          <div className={styles.dialogBody}>
            <textarea
              className={styles.textarea}
              rows={8}
              aria-label="VM options editor"
              value={config.params?.vmOptions ?? ""}
              placeholder="-Xmx1024m&#10;-Dfile.encoding=UTF-8"
              onChange={(e) => setParams({ vmOptions: e.target.value.replace(/\r?\n/g, " ") })}
            />
          </div>
        </Dialog>
      )}

      {appServersOpen && (
        <ApplicationServersDialog
          key={allServers.length > 0 ? "loaded" : "empty"}
          initialServers={allServers}
          selectedHome={home}
          onClose={() => setAppServersOpen(false)}
          onApply={(servers, active) => {
            setSavedServers(servers);
            saveServersToStorage(servers);
            setAppServersOpen(false);
            if (active) {
              const shouldRename =
                active.name &&
                (config.name === "Unnamed" ||
                  /^Unnamed \(\d+\)$/.test(config.name) ||
                  config.name === config.params?.serverName);
              setParams(
                {
                  tomcatHome: active.home,
                  serverName: active.name,
                  tomcatBase: active.base && active.base !== active.home ? active.base : "",
                  tomcatLibraries: active.libraries.length ? active.libraries.join(";") : "",
                },
                shouldRename ? active.name : undefined,
              );
            }
          }}
        />
      )}
    </div>
  );
}

function ApplicationServersDialog({
  initialServers,
  selectedHome,
  onClose,
  onApply,
}: {
  initialServers: TomcatServerProfile[];
  selectedHome: string;
  onClose: () => void;
  onApply: (servers: TomcatServerProfile[], selected: TomcatServerProfile | null) => void;
}) {
  const tx = useTx();
  const [servers, setServers] = useState<TomcatServerProfile[]>(() =>
    initialServers.length
      ? initialServers.map((s) => ({ ...s, libraries: [...s.libraries] }))
      : [{ id: "server:1", name: "Tomcat", home: "", base: "", version: "", libraries: [] }],
  );
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const match = initialServers.find((s) => s.home === selectedHome) ?? initialServers[0];
    return match ? match.id : "server:1";
  });
  const [selectedLib, setSelectedLib] = useState<string | null>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);

  const current = servers.find((s) => s.id === selectedId) ?? null;

  const updateCurrent = (patch: Partial<TomcatServerProfile>) => {
    if (!current) return;
    setServers((prev) => prev.map((s) => (s.id === current.id ? { ...s, ...patch } : s)));
  };

  const inspectHome = (targetId: string, nextHome: string) => {
    if (!nextHome.trim()) return;
    void call(commands.runTomcatHome(nextHome))
      .then((info) => {
        const ver = shortVersion(info.version);
        setServers((prev) =>
          prev.map((s) => {
            if (s.id !== targetId) return s;
            const autoName = !s.name || s.name === "Tomcat" ? defaultServerName(nextHome, info.version) : s.name;
            const autoBase = !s.base || s.base === s.home ? nextHome : s.base;
            const autoLibs = s.libraries.length ? s.libraries : (info.libraries ?? []);
            return {
              ...s,
              home: nextHome,
              base: autoBase,
              name: autoName,
              version: ver,
              libraries: autoLibs,
              tomee: info.tomee,
            };
          }),
        );
      })
      .catch(() => {});
  };

  const removeServer = () => {
    if (!current) return;
    const next = servers.filter((s) => s.id !== current.id);
    setServers(next);
    setSelectedId(next[0]?.id ?? null);
  };

  const addLibrary = async () => {
    if (!current) return;
    const picked = await pickLocalPath(false, current.home || undefined);
    if (!picked || current.libraries.includes(picked)) return;
    updateCurrent({ libraries: [...current.libraries, picked] });
    setSelectedLib(picked);
  };

  const removeLibrary = () => {
    if (!current || !selectedLib) return;
    const nextLibs = current.libraries.filter((l) => l !== selectedLib);
    updateCurrent({ libraries: nextLibs });
    setSelectedLib(nextLibs[0] ?? null);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Application Servers"
      width={720}
      footerStart={<IconButton icon="help" size="small" iconSize={14} title="Help" />}
      buttons={[
        { label: "Cancel", role: "cancel" },
        {
          label: "OK",
          role: "default",
          onClick: () =>
            onApply(
              servers.filter((s) => s.home.trim()),
              current,
            ),
        },
      ]}
    >
      <div className={styles.appServersBody}>
        <div className={styles.appServersSidebar}>
          <div className={styles.appServersToolbar} role="toolbar" aria-label={tx("Application servers")}>
            <IconButton
              icon="plus"
              size="small"
              iconSize={14}
              title="Add Application Server"
              onClick={() => setAddDialogOpen(true)}
            />
            <IconButton
              icon="minus"
              size="small"
              iconSize={14}
              title="Remove Application Server"
              disabled={!current}
              onClick={removeServer}
            />
          </div>
          <div className={styles.appServersList} role="listbox" aria-label={tx("Application servers")}>
            {servers.map((s) => {
              const sel = s.id === current?.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="option"
                  aria-selected={sel}
                  className={clsx(styles.editItem, sel && styles.editItemSelected)}
                  onClick={() => setSelectedId(s.id)}
                >
                  <span className={styles.chooserName}>{s.name || <T>Unnamed</T>}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className={styles.appServersDetail}>
          {current ? (
            <>
              <div className={styles.appServerFieldRow}>
                <span className={styles.appServerFieldLabel}>
                  <T>Name:</T>
                </span>
                <Input
                  aria-label="Server name"
                  value={current.name}
                  onChange={(e) => updateCurrent({ name: e.target.value })}
                />
              </div>
              <div className={styles.appServerFieldRow}>
                <span className={styles.appServerFieldLabel}>
                  <T>Tomcat Home:</T>
                </span>
                <div className={styles.tomcatInputInside}>
                  <Input
                    mono
                    aria-label="Tomcat Home"
                    value={current.home}
                    onChange={(e) => {
                      const v = e.target.value;
                      updateCurrent({
                        home: v,
                        base: !current.base || current.base === current.home ? v : current.base,
                      });
                      inspectHome(current.id, v);
                    }}
                  />
                  {isTauri() && !isRemoteWindow() && (
                    <IconButton
                      icon="folder-open"
                      size="small"
                      iconSize={13}
                      title="Browse…"
                      className={styles.tomcatInlineIconBtn}
                      onClick={() =>
                        void pickLocalPath(true, current.home || undefined).then((picked) => {
                          if (!picked) return;
                          updateCurrent({
                            home: picked,
                            base: !current.base || current.base === current.home ? picked : current.base,
                          });
                          inspectHome(current.id, picked);
                        })
                      }
                    />
                  )}
                </div>
              </div>
              <div className={styles.appServerFieldRow}>
                <span className={styles.appServerFieldLabel}>
                  <T>Tomcat Version:</T>
                </span>
                <span>
                  {current.version || "—"}
                  {current.tomee ? ` (${tx("TomEE detected")})` : ""}
                </span>
              </div>
              <div className={styles.appServerFieldRow}>
                <span className={styles.appServerFieldLabel}>
                  <T>Tomcat base directory:</T>
                </span>
                <div className={styles.tomcatInputInside}>
                  <Input
                    mono
                    aria-label="Tomcat base directory"
                    value={current.base}
                    onChange={(e) => updateCurrent({ base: e.target.value })}
                  />
                  {isTauri() && !isRemoteWindow() && (
                    <IconButton
                      icon="folder-open"
                      size="small"
                      iconSize={13}
                      title="Browse…"
                      className={styles.tomcatInlineIconBtn}
                      onClick={() =>
                        void pickLocalPath(true, current.base || current.home || undefined).then((picked) => {
                          if (picked) updateCurrent({ base: picked });
                        })
                      }
                    />
                  )}
                </div>
              </div>
              <div className={styles.tomcatSection}>
                <div className={styles.tomcatSectionHeader}>
                  <span>
                    <T>Libraries</T>
                  </span>
                  <span className={styles.tomcatSectionLine} />
                </div>
                <div className={styles.appServersToolbarPlain} role="toolbar" aria-label={tx("Server libraries")}>
                  <IconButton
                    icon="plus"
                    size="small"
                    iconSize={14}
                    title="Add Library JAR"
                    onClick={() => void addLibrary()}
                  />
                  <IconButton icon="external-link" size="small" iconSize={13} title="Add External Documentation" />
                  <IconButton
                    icon="folder-open"
                    size="small"
                    iconSize={13}
                    title="Add Classes Directory"
                    onClick={() => void addLibrary()}
                  />
                  <IconButton
                    icon="minus"
                    size="small"
                    iconSize={14}
                    title="Remove Library JAR"
                    disabled={!selectedLib}
                    onClick={removeLibrary}
                  />
                </div>
                <div className={styles.appServersLibs}>
                  <div className={styles.appServersLibTree} role="list" aria-label={tx("Classes")}>
                    <div className={styles.appServersLibHeader}>
                      <Icon name="chevron-down" size={12} />
                      <Icon name="folder-library" size={13} />
                      <span>
                        <T>Classes</T>
                      </span>
                    </div>
                    {current.libraries.map((jar) => (
                      <button
                        key={jar}
                        type="button"
                        role="listitem"
                        className={clsx(
                          styles.appServersLibRow,
                          selectedLib === jar && styles.appServersLibRowSelected,
                        )}
                        onClick={() => setSelectedLib(jar)}
                      >
                        <Icon name="library" size={13} className={styles.chooserIcon} />
                        <span className={styles.chooserName}>{jar}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className={styles.editEmpty}>
              <T>No application server selected</T>
            </div>
          )}
        </div>
      </div>
      {addDialogOpen && (
        <AddTomcatServerDialog
          onClose={() => setAddDialogOpen(false)}
          onAdd={(entry) => {
            setServers((prev) => [...prev, entry]);
            setSelectedId(entry.id);
            setAddDialogOpen(false);
          }}
        />
      )}
    </Dialog>
  );
}

function AddTomcatServerDialog({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (server: TomcatServerProfile) => void;
}) {
  const [home, setHome] = useState("");
  const [base, setBase] = useState("");
  const [version, setVersion] = useState("");
  const [libraries, setLibraries] = useState<string[]>([]);
  const [tomee, setTomee] = useState(false);
  const [validHome, setValidHome] = useState(false);

  const inspect = (nextHome: string) => {
    const trimmed = nextHome.trim();
    if (!trimmed) {
      setVersion("");
      setLibraries([]);
      setTomee(false);
      setValidHome(false);
      return;
    }
    void call(commands.runTomcatHome(trimmed))
      .then((info) => {
        setVersion(shortVersion(info.version));
        setLibraries(info.libraries ?? []);
        setTomee(!!info.tomee);
        setValidHome(true);
      })
      .catch(() => {
        setVersion("");
        setLibraries([]);
        setTomee(false);
        setValidHome(false);
      });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Tomcat Server"
      width={440}
      buttons={[
        { label: "Cancel", role: "cancel" },
        {
          label: "OK",
          role: "default",
          onClick: () => {
            const id = `server:${Date.now()}`;
            const homeTrimmed = home.trim();
            const baseTrimmed = base.trim() || homeTrimmed;
            onAdd({
              id,
              name: defaultServerName(homeTrimmed, version),
              home: homeTrimmed,
              base: baseTrimmed,
              version,
              libraries,
              tomee,
            });
          },
        },
      ]}
    >
      <div className={styles.addServerDialogBody}>
        <div className={styles.addServerFieldRow}>
          <span className={styles.appServerFieldLabel}>
            <T>Tomcat Home:</T>
          </span>
          <div className={styles.tomcatInputInside}>
            <Input
              mono
              autoFocus
              aria-label="New server Tomcat Home"
              value={home}
              onChange={(e) => {
                const next = e.target.value;
                setHome(next);
                if (!base || base === home) setBase(next);
                inspect(next);
              }}
            />
            <IconButton
              icon="folder-open"
              size="small"
              iconSize={13}
              title="Browse… (⇧⏎)"
              className={styles.tomcatInlineIconBtn}
              onClick={() => {
                if (isTauri() && !isRemoteWindow()) {
                  void pickLocalPath(true, home || undefined).then((picked) => {
                    if (!picked) return;
                    setHome(picked);
                    if (!base || base === home) setBase(picked);
                    inspect(picked);
                  });
                }
              }}
            />
          </div>
        </div>
        <div className={styles.addServerFieldRow}>
          <span className={styles.appServerFieldLabel}>
            <T>Tomcat Version:</T>
          </span>
          <span>{version}</span>
        </div>
        {!validHome && (
          <div className={styles.addServerErrorRow} role="alert">
            <Icon name="error" size={14} className={styles.addServerErrorIcon} />
            <span>
              <strong>
                <T>Warning:</T>
              </strong>{" "}
              <T>The selected directory is not a valid Tomcat home</T>
            </span>
          </div>
        )}
        <div className={styles.addServerFieldRow}>
          <span className={styles.appServerFieldLabel}>
            <T>Tomcat base directory:</T>
          </span>
          <div className={styles.tomcatInputInside}>
            <Input
              mono
              aria-label="New server Tomcat base directory"
              value={base}
              onChange={(e) => setBase(e.target.value)}
            />
            <IconButton
              icon="folder-open"
              size="small"
              iconSize={13}
              title="Browse… (⇧⏎)"
              className={styles.tomcatInlineIconBtn}
              onClick={() => {
                if (isTauri() && !isRemoteWindow()) {
                  void pickLocalPath(true, base || home || undefined).then((picked) => {
                    if (picked) setBase(picked);
                  });
                }
              }}
            />
          </div>
        </div>
        {!base.trim() && (
          <div className={styles.addServerErrorRow} role="alert">
            <Icon name="error" size={14} className={styles.addServerErrorIcon} />
            <span>
              <T>Tomcat base directory path is not specified</T>
            </span>
          </div>
        )}
      </div>
    </Dialog>
  );
}
