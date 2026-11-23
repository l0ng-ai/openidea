/**
 * Per-session MCP picker for the New Task and Session composers: shows inherited IDE, Project,
 * Global, and Agent-Native CLI MCP servers, lets the user toggle servers for this session only,
 * reset session overrides, or jump to Settings › Agents › MCP Connections.
 */
import { useMemo, useState } from "react";
import type { McpExternalSource, McpServer } from "@/bindings";
import { formatMessage, useTx } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { T } from "@/ui";
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
import {
  PickerEmpty,
  PickerGroupLabel,
  PickerInlineLink,
  PickerPill,
  PickerRow,
  PickerSessionPill,
  PickerToggle,
  SessionPicker,
} from "./SessionPicker";

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

  const [importingKey, setImportingKey] = useState<string | null>(null);

  const resolved = useMemo(
    () => resolveSessionMcp(servers, sources, ideMcpEnabled, provider, overrides ?? {}),
    [servers, sources, ideMcpEnabled, provider, overrides],
  );

  const totalRows = 1 + resolved.workspace.length + resolved.user.length + resolved.nativeCli.length;

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
    <SessionPicker
      icon="plugin"
      brand="MCP"
      triggerTitles={{
        plain: tx("MCP servers ({active}/{total} active)"),
        withOverrides: tx("MCP servers ({active}/{total} active · {overrides} session overrides)"),
      }}
      triggerAriaLabel={tx("MCP servers")}
      popupTitle={tx("Session MCP Servers")}
      settingsTitle={tx("MCP Connections…")}
      settingsPage={MCP_PAGE}
      counts={{ active: resolved.activeCount, total: resolved.totalCount, overrides: resolved.overrideCount }}
      search={{ placeholder: tx("Filter MCP servers…"), ariaLabel: tx("Filter MCP servers"), shown: totalRows > 5 }}
      disabled={disabled}
      busy={busy}
      openRequest={openRequest}
      hideTrigger={hideTrigger}
      refresh={testData ? undefined : () => void refreshMcpCatalog()}
      onReset={() => onChange({})}
    >
      {(query, { openSettings }) => {
        const q = query.trim().toLowerCase();
        const matchesQuery = (name: string, detail?: string) =>
          !q || name.toLowerCase().includes(q) || (detail ?? "").toLowerCase().includes(q);
        const serverDetail = (i: SessionMcpItem) => i.server?.command ?? i.server?.url ?? undefined;

        const showIde = matchesQuery(resolved.ide.name, "openidea ide");
        const filteredWorkspace = resolved.workspace.filter((i) => matchesQuery(i.name, serverDetail(i)));
        const filteredUser = resolved.user.filter((i) => matchesQuery(i.name, serverDetail(i)));
        const filteredNative = resolved.nativeCli.filter((i) => matchesQuery(i.name, i.sourceLabel));

        return (
          <>
            {showIde && (
              <>
                <PickerGroupLabel>
                  <T>IDE</T>
                </PickerGroupLabel>
                <PickerRow
                  name="openidea"
                  pills={resolved.ide.overridden && <PickerSessionPill />}
                  sub={<T>Built-in IDE tools</T>}
                  controls={
                    resolved.ide.lockedReason === "ideDisabled" ? (
                      <PickerInlineLink onClick={() => openSettings(IDE_MCP_SETTINGS_PAGE)}>
                        <T>Enable in Settings</T>
                      </PickerInlineLink>
                    ) : (
                      <PickerToggle
                        enabled={resolved.ide.enabled}
                        ariaLabel={tx("Enable openidea for this session")}
                        onChange={(on) => handleToggleItem(resolved.ide, on)}
                      />
                    )
                  }
                />
              </>
            )}

            {filteredWorkspace.length > 0 && (
              <>
                <PickerGroupLabel>
                  <T>Project</T>
                </PickerGroupLabel>
                {filteredWorkspace.map((item) => (
                  <SessionServerRow
                    key={`ws:${item.name}`}
                    item={item}
                    onToggle={(on) => handleToggleItem(item, on)}
                    onOpenSettings={() => openSettings(MCP_PAGE)}
                  />
                ))}
              </>
            )}

            {filteredUser.length > 0 && (
              <>
                <PickerGroupLabel>
                  <T>Global</T>
                </PickerGroupLabel>
                {filteredUser.map((item) => (
                  <SessionServerRow
                    key={`user:${item.name}`}
                    item={item}
                    onToggle={(on) => handleToggleItem(item, on)}
                    onOpenSettings={() => openSettings(MCP_PAGE)}
                  />
                ))}
              </>
            )}

            {filteredNative.length > 0 && (
              <>
                <PickerGroupLabel>
                  <T>Agent Config</T>
                </PickerGroupLabel>
                {filteredNative.map((item) => {
                  const key = `${item.sourceId}::${item.name}`;
                  return (
                    <PickerRow
                      key={key}
                      name={item.name}
                      pills={
                        <>
                          <PickerPill>{item.server.transport.toUpperCase()}</PickerPill>
                          {item.overridden && <PickerSessionPill />}
                        </>
                      }
                      sub={formatMessage(
                        tx(item.enabled ? "Active via {source}" : "Disabled for this session ({source})"),
                        { source: item.sourceLabel },
                      )}
                      subTitle={item.sourcePath}
                      controls={
                        <>
                          {backend.importSelected && (
                            <PickerInlineLink
                              disabled={importingKey === key}
                              title={tx("Import into Global settings to toggle per session and share across agents")}
                              onClick={() => void handleImportNative(item)}
                            >
                              <T>Import</T>
                            </PickerInlineLink>
                          )}
                          <PickerToggle
                            enabled={item.enabled}
                            ariaLabel={formatMessage(tx("Enable {name} for this session"), { name: item.name })}
                            onChange={(on) => handleToggleItem(item, on)}
                          />
                        </>
                      }
                    />
                  );
                })}
              </>
            )}

            {!showIde && filteredWorkspace.length === 0 && filteredUser.length === 0 && filteredNative.length === 0 && (
              <PickerEmpty>
                <T>No matching MCP servers.</T>
              </PickerEmpty>
            )}
          </>
        );
      }}
    </SessionPicker>
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
    <PickerRow
      name={item.name}
      pills={
        <>
          <PickerPill>{srv.transport.toUpperCase()}</PickerPill>
          {item.shadowsGlobal && (
            <PickerPill>
              <T>Overrides Global</T>
            </PickerPill>
          )}
          {item.overridden && <PickerSessionPill />}
        </>
      }
      sub={sub || undefined}
      subTitle={sub}
      controls={
        item.lockedReason === "unapproved" ? (
          <PickerInlineLink onClick={onOpenSettings}>
            <T>Approve…</T>
          </PickerInlineLink>
        ) : (
          <PickerToggle
            enabled={item.enabled}
            ariaLabel={formatMessage(tx("Enable {name} for this session"), { name: item.name })}
            onChange={onToggle}
          />
        )
      }
    />
  );
}
