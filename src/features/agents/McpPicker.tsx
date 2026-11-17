/**
 * Per-session MCP picker for the New Task and Session composers: shows inherited IDE, Project,
 * Global, and Agent-Native CLI MCP servers, lets the user toggle servers for this session only,
 * reset session overrides, or jump to Settings › Agents › External MCP Servers.
 */
import clsx from "clsx";
import { useEffect, useMemo, useRef, useState } from "react";
import type { McpExternalSource, McpServer } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { formatMessage, useTx } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { Icon, IconButton, Popup, SearchField, T, Toggle } from "@/ui";
import {
  IDE_MCP_SETTINGS_PAGE,
  defaultMcpBackend,
  nextSessionOverrides,
  refreshMcpCatalog,
  resolveSessionMcp,
  useMcpCatalog,
  useMcpCatalogSync,
  type McpBackend,
  type NativeCliMcpItem,
  type SessionMcpItem,
} from "./mcpModel";
import { MCP_PAGE } from "./model";
import styles from "./McpPicker.module.css";

export interface McpPickerProps {
  provider: string;
  overrides: Readonly<Record<string, boolean>> | undefined;
  onChange: (nextOverrides: Record<string, boolean>) => void;
  disabled?: boolean;
  /** True while the session is actively running a turn (changes apply on the next turn). */
  busy?: boolean;
  /** Bumped when `/mcp` is invoked from the composer to open this popover. */
  openRequest?: number;
  /** No button of its own: opened only through `openRequest`, above the composer. */
  hideTrigger?: boolean;
  /** Optional overrides for unit tests. */
  backend?: McpBackend;
  testData?: {
    servers: readonly McpServer[];
    sources?: readonly McpExternalSource[];
    ideMcpEnabled?: boolean;
  };
}

export function McpPicker({
  provider,
  overrides,
  onChange,
  disabled = false,
  busy = false,
  openRequest = 0,
  hideTrigger = false,
  backend = defaultMcpBackend,
  testData,
}: McpPickerProps) {
  const tx = useTx();
  useMcpCatalogSync();
  const catalogServers = useMcpCatalog((s) => s.servers);
  const catalogSources = useMcpCatalog((s) => s.sources);
  const projectIdeMcp = useProject((s) => s.settings?.mcpServer?.enabled ?? false);

  const servers = testData?.servers ?? catalogServers;
  const sources = testData?.sources ?? catalogSources;
  const ideMcpEnabled = testData?.ideMcpEnabled ?? projectIdeMcp;

  const [open, setOpen] = useState(false);
  const [seenOpenRequest, setSeenOpenRequest] = useState(openRequest);
  const [query, setQuery] = useState("");
  const [importingKey, setImportingKey] = useState<string | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const setAnchor = (el: HTMLElement | null) => {
    anchor.current = el;
  };

  if (openRequest !== seenOpenRequest) {
    setSeenOpenRequest(openRequest);
    if (openRequest > 0 && !disabled) setOpen(true);
  }

  useEffect(() => {
    if (openRequest > 0 && !disabled && !testData) {
      void refreshMcpCatalog();
    }
  }, [openRequest, disabled, testData]);

  const toggleOpen = () => {
    const next = !open;
    if (next && !testData) void refreshMcpCatalog();
    if (!next) setQuery("");
    setOpen(next);
  };

  const resolved = useMemo(
    () => resolveSessionMcp(servers, sources, ideMcpEnabled, provider, overrides ?? {}),
    [servers, sources, ideMcpEnabled, provider, overrides],
  );

  const q = query.trim().toLowerCase();
  const matchesQuery = (name: string, detail?: string) =>
    !q || name.toLowerCase().includes(q) || (detail ?? "").toLowerCase().includes(q);

  const showIde = matchesQuery(resolved.ide.name, "openidea ide");
  const filteredWorkspace = resolved.workspace.filter((i) =>
    matchesQuery(i.name, i.server?.command ?? i.server?.url ?? undefined),
  );
  const filteredUser = resolved.user.filter((i) =>
    matchesQuery(i.name, i.server?.command ?? i.server?.url ?? undefined),
  );
  const filteredNative = resolved.nativeCli.filter((i) => matchesQuery(i.name, i.sourceLabel));

  const totalRows = 1 + resolved.workspace.length + resolved.user.length + resolved.nativeCli.length;

  const countLabel =
    resolved.totalCount === 0
      ? "0"
      : resolved.activeCount === resolved.totalCount
        ? String(resolved.activeCount)
        : `${resolved.activeCount}/${resolved.totalCount}`;

  const handleToggleItem = (item: Pick<SessionMcpItem, "name" | "defaultEnabled">, nextEnabled: boolean) => {
    onChange(nextSessionOverrides(overrides, item, nextEnabled));
  };

  const handleImportNative = async (item: NativeCliMcpItem) => {
    if (!backend.importSelected) return;
    const key = `${item.sourceId}::${item.name}`;
    setImportingKey(key);
    try {
      const next = await backend.importSelected("user", [{ sourceId: item.sourceId, name: item.name }], false);
      if (!testData) {
        useMcpCatalog.setState({ servers: next, loaded: true });
      }
    } finally {
      setImportingKey(null);
    }
  };

  return (
    <>
      {hideTrigger ? (
        // Pinned to the composer's bottom-right corner: the popover opens under the box, like its other pickers.
        <span ref={setAnchor} className={styles.hiddenAnchor} aria-hidden />
      ) : (
        <button
          ref={setAnchor}
          type="button"
          disabled={disabled}
          className={styles.trigger}
          title={
            resolved.overrideCount > 0
              ? formatMessage(tx("MCP servers ({active}/{total} active · {overrides} session overrides)"), {
                  active: resolved.activeCount,
                  total: resolved.totalCount,
                  overrides: resolved.overrideCount,
                })
              : formatMessage(tx("MCP servers ({active}/{total} active)"), {
                  active: resolved.activeCount,
                  total: resolved.totalCount,
                })
          }
          aria-label={tx("MCP servers")}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={toggleOpen}
        >
          <Icon name="plugin" size={13} />
          <span className={styles.triggerLabel}>MCP</span>
          <span className={styles.triggerCount}>{countLabel}</span>
          {resolved.overrideCount > 0 && <span className={styles.overrideDot} aria-hidden />}
        </button>
      )}

      <Popup
        open={open}
        anchor={anchor}
        placement={hideTrigger ? "bottom-end" : "top-start"}
        offset={6}
        onClose={() => {
          setOpen(false);
          setQuery("");
        }}
        aria-label={tx("Session MCP Servers")}
        className={styles.popup}
      >
        <div className={styles.header}>
          <span className={styles.title}>
            <T>Session MCP Servers</T>
          </span>
          <div className={styles.headerActions}>
            {resolved.overrideCount > 0 && (
              <button type="button" className={styles.resetBtn} onClick={() => onChange({})}>
                <T>Reset</T>
              </button>
            )}
            <IconButton
              icon="settings"
              size="small"
              title={tx("External MCP Servers…")}
              aria-label={tx("External MCP Servers…")}
              onClick={() => {
                setOpen(false);
                void executeAction("file.settings", MCP_PAGE);
              }}
            />
          </div>
        </div>

        {totalRows > 5 && (
          <div className={styles.searchWrap}>
            <SearchField
              value={query}
              onChange={setQuery}
              placeholder={tx("Filter MCP servers…")}
              aria-label={tx("Filter MCP servers")}
            />
          </div>
        )}

        <div className={styles.list}>
          {showIde && (
            <>
              <div className={styles.groupLabel}>
                <T>IDE</T>
              </div>
              <div className={styles.row}>
                <div className={styles.rowInfo}>
                  <div className={styles.rowTitle}>
                    <span className={styles.name}>openidea</span>
                    {resolved.ide.overridden && (
                      <span className={clsx(styles.pill, styles.pillSession)}>
                        <T>Session</T>
                      </span>
                    )}
                  </div>
                  <span className={styles.sub}>
                    <T>Built-in IDE tools</T>
                  </span>
                </div>
                <div className={styles.rowControls}>
                  {resolved.ide.lockedReason === "ideDisabled" ? (
                    <button
                      type="button"
                      className={styles.inlineLink}
                      onClick={() => {
                        setOpen(false);
                        void executeAction("file.settings", IDE_MCP_SETTINGS_PAGE);
                      }}
                    >
                      <T>Enable in Settings</T>
                    </button>
                  ) : (
                    <>
                      <Toggle
                        checked={resolved.ide.enabled}
                        aria-label={tx("Enable openidea for this session")}
                        onChange={(on) => handleToggleItem(resolved.ide, on)}
                      />
                      <span className={clsx(styles.dot, resolved.ide.enabled && styles.dotOn)} aria-hidden />
                    </>
                  )}
                </div>
              </div>
            </>
          )}

          {filteredWorkspace.length > 0 && (
            <>
              <div className={styles.groupLabel}>
                <T>Project</T>
              </div>
              {filteredWorkspace.map((item) => (
                <SessionServerRow
                  key={`ws:${item.name}`}
                  item={item}
                  onToggle={(on) => handleToggleItem(item, on)}
                  onOpenSettings={() => {
                    setOpen(false);
                    void executeAction("file.settings", MCP_PAGE);
                  }}
                />
              ))}
            </>
          )}

          {filteredUser.length > 0 && (
            <>
              <div className={styles.groupLabel}>
                <T>Global</T>
              </div>
              {filteredUser.map((item) => (
                <SessionServerRow
                  key={`user:${item.name}`}
                  item={item}
                  onToggle={(on) => handleToggleItem(item, on)}
                  onOpenSettings={() => {
                    setOpen(false);
                    void executeAction("file.settings", MCP_PAGE);
                  }}
                />
              ))}
            </>
          )}

          {filteredNative.length > 0 && (
            <>
              <div className={styles.groupLabel}>
                <T>Agent Config</T>
              </div>
              {filteredNative.map((item) => {
                const key = `${item.sourceId}::${item.name}`;
                return (
                  <div key={key} className={styles.row}>
                    <div className={styles.rowInfo}>
                      <div className={styles.rowTitle}>
                        <span className={styles.name}>{item.name}</span>
                        <span className={styles.pill}>{item.server.transport.toUpperCase()}</span>
                        {item.overridden && (
                          <span className={clsx(styles.pill, styles.pillSession)}>
                            <T>Session</T>
                          </span>
                        )}
                      </div>
                      <span className={styles.sub} title={item.sourcePath}>
                        {formatMessage(
                          tx(item.enabled ? "Active via {source}" : "Disabled for this session ({source})"),
                          { source: item.sourceLabel },
                        )}
                      </span>
                    </div>
                    <div className={styles.rowControls}>
                      {backend.importSelected && (
                        <button
                          type="button"
                          disabled={importingKey === key}
                          className={styles.inlineLink}
                          title={tx("Import into Global settings to toggle per session and share across agents")}
                          onClick={() => void handleImportNative(item)}
                        >
                          <T>Import</T>
                        </button>
                      )}
                      <Toggle
                        checked={item.enabled}
                        aria-label={formatMessage(tx("Enable {name} for this session"), { name: item.name })}
                        onChange={(on) => handleToggleItem(item, on)}
                      />
                      <span className={clsx(styles.dot, item.enabled && styles.dotOn)} aria-hidden />
                    </div>
                  </div>
                );
              })}
            </>
          )}

          {!showIde && filteredWorkspace.length === 0 && filteredUser.length === 0 && filteredNative.length === 0 && (
            <div className={styles.empty}>
              <T>No matching MCP servers.</T>
            </div>
          )}
        </div>

        <div className={styles.footer}>
          {busy ? <T>Changes apply on the next message.</T> : <T>Toggles here apply to this session only.</T>}
        </div>
      </Popup>
    </>
  );
}

function SessionServerRow({
  item,
  onToggle,
  onOpenSettings,
}: {
  item: SessionMcpItem;
  onToggle: (enabled: boolean) => void;
  onOpenSettings: () => void;
}) {
  const tx = useTx();
  const srv = item.server!;
  const sub =
    srv.transport === "stdio"
      ? [srv.command, ...srv.args].filter(Boolean).join(" ")
      : (srv.url ?? srv.transport.toUpperCase());

  return (
    <div className={styles.row}>
      <div className={styles.rowInfo}>
        <div className={styles.rowTitle}>
          <span className={styles.name}>{item.name}</span>
          <span className={styles.pill}>{srv.transport.toUpperCase()}</span>
          {item.shadowsGlobal && (
            <span className={styles.pill}>
              <T>Overrides Global</T>
            </span>
          )}
          {item.overridden && (
            <span className={clsx(styles.pill, styles.pillSession)}>
              <T>Session</T>
            </span>
          )}
        </div>
        {sub && (
          <span className={styles.sub} title={sub}>
            {sub}
          </span>
        )}
      </div>

      <div className={styles.rowControls}>
        {item.lockedReason === "unapproved" ? (
          <button type="button" className={styles.inlineLink} onClick={onOpenSettings}>
            <T>Approve…</T>
          </button>
        ) : (
          <>
            <Toggle
              checked={item.enabled}
              aria-label={formatMessage(tx("Enable {name} for this session"), { name: item.name })}
              onChange={onToggle}
            />
            <span className={clsx(styles.dot, item.enabled && styles.dotOn)} aria-hidden />
          </>
        )}
      </div>
    </div>
  );
}
