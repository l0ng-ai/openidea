/**
 * Shared MCP server model, multi-level inheritance resolution (IDE -> Project -> Global -> Agent CLI),
 * and reactive cache for Settings › Agents › External MCP Servers and the Composer MCP picker.
 */
import { useEffect } from "react";
import { create } from "zustand";
import type {
  McpDiscoveredServer,
  McpExternalSource,
  McpImportSelection,
  McpProbeResult,
  McpScope,
  McpServer,
  McpServerInput,
} from "@/bindings";
import { call, commands, isTauri, onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";

export const BUILTIN_MCP_NAME = "openidea";
export const IDE_MCP_SETTINGS_PAGE = "agents.mcpServer";

export interface McpBackend {
  list(): Promise<McpServer[]>;
  save(input: McpServerInput): Promise<McpServer[]>;
  saveJson?(scope: McpScope, rawJson: string, fallbackName: string | null, agents: string[]): Promise<McpServer[]>;
  setEnabled(id: string, enabled: boolean): Promise<McpServer[]>;
  remove(id: string): Promise<McpServer[]>;
  importWorkspace(): Promise<McpServer[]>;
  discoverSources?(): Promise<McpExternalSource[]>;
  importSelected?(scope: McpScope, selections: McpImportSelection[], overwrite: boolean): Promise<McpServer[]>;
  testServer?(id: string): Promise<McpProbeResult>;
}

export const defaultMcpBackend: McpBackend = {
  list: () => (typeof commands.agentMcpList === "function" ? call(commands.agentMcpList()) : Promise.resolve([])),
  save: (input) => call(commands.agentMcpSave(input)),
  saveJson: (scope, rawJson, fallbackName, agents) =>
    call(commands.agentMcpSaveJson(scope, rawJson, fallbackName, agents)),
  setEnabled: (id, enabled) => call(commands.agentMcpSetEnabled(id, enabled)),
  remove: (id) => call(commands.agentMcpRemove(id)),
  importWorkspace: () => call(commands.agentMcpImport()),
  discoverSources: () =>
    typeof commands.agentMcpDiscoverSources === "function"
      ? call(commands.agentMcpDiscoverSources())
      : Promise.resolve([]),
  importSelected: (scope, selections, overwrite) => call(commands.agentMcpImportSelected(scope, selections, overwrite)),
  testServer: (id) => call(commands.agentMcpTest(id)),
};

export const normalizeProviderId = (id: string): string => (id.endsWith("-acp") ? id.slice(0, -4) : id);

export function matchesAgentProvider(agents: readonly string[] | undefined, provider: string): boolean {
  if (!agents || agents.length === 0) return true;
  const target = normalizeProviderId(provider);
  return agents.some((raw) => {
    const trimmed = raw.trim();
    return trimmed === provider || normalizeProviderId(trimmed) === target;
  });
}

export interface SessionMcpItem {
  name: string;
  level: "ide" | "workspace" | "user";
  server?: McpServer;
  /** Default state inherited from IDE / Project / Global settings for `provider`. */
  defaultEnabled: boolean;
  /** Effective state for this session after applying `overrides`. */
  enabled: boolean;
  /** True when `overrides` explicitly diverges from `defaultEnabled`. */
  overridden: boolean;
  /** True when a Project server shadows a Global server of the same name. */
  shadowsGlobal: boolean;
  /** Cannot be toggled in-session (e.g. IDE MCP server is off globally, or unapproved Project server). */
  lockedReason: "ideDisabled" | "unapproved" | null;
}

export interface NativeCliMcpItem {
  name: string;
  sourceId: string;
  sourceLabel: string;
  sourcePath: string;
  server: McpDiscoveredServer;
}

export interface ResolvedSessionMcp {
  ide: SessionMcpItem;
  workspace: SessionMcpItem[];
  user: SessionMcpItem[];
  nativeCli: NativeCliMcpItem[];
  activeCount: number;
  totalCount: number;
  overrideCount: number;
}

/**
 * Resolves the effective MCP servers for a session running `provider` across all levels:
 * 1. Built-in IDE MCP server (`openidea`)
 * 2. Project (`workspace` scope — overrides `user` servers with the same name)
 * 3. Global (`user` scope)
 * 4. Agent-native CLI config directories not yet imported into OpenIDEA (`~/.copilot/...`, `~/.claude.json`, etc.)
 */
export function resolveSessionMcp(
  servers: readonly McpServer[],
  sources: readonly McpExternalSource[],
  ideMcpEnabled: boolean,
  provider: string,
  overrides: Readonly<Record<string, boolean>> = {},
): ResolvedSessionMcp {
  const ideOverride = overrides[BUILTIN_MCP_NAME];
  const ideEffective = ideMcpEnabled ? (ideOverride ?? true) : false;
  const ide: SessionMcpItem = {
    name: BUILTIN_MCP_NAME,
    level: "ide",
    defaultEnabled: ideMcpEnabled,
    enabled: ideEffective,
    overridden: ideMcpEnabled && ideOverride !== undefined && ideOverride !== ideMcpEnabled,
    shadowsGlobal: false,
    lockedReason: ideMcpEnabled ? null : "ideDisabled",
  };

  const userNames = new Set(servers.filter((s) => s.scope === "user").map((s) => s.name));
  const seenNames = new Set<string>([BUILTIN_MCP_NAME]);
  const workspace: SessionMcpItem[] = [];
  const user: SessionMcpItem[] = [];

  for (const srv of servers.filter((s) => s.scope === "workspace")) {
    seenNames.add(srv.name);
    const unapproved = !!srv.unapproved;
    const defaultEnabled = !unapproved && srv.enabled && matchesAgentProvider(srv.agents, provider);
    const explicit = overrides[srv.name];
    const enabled = unapproved ? false : (explicit ?? defaultEnabled);
    workspace.push({
      name: srv.name,
      level: "workspace",
      server: srv,
      defaultEnabled,
      enabled,
      overridden: !unapproved && explicit !== undefined && explicit !== defaultEnabled,
      shadowsGlobal: userNames.has(srv.name),
      lockedReason: unapproved ? "unapproved" : null,
    });
  }

  for (const srv of servers.filter((s) => s.scope === "user")) {
    if (seenNames.has(srv.name)) continue;
    seenNames.add(srv.name);
    const defaultEnabled = srv.enabled && matchesAgentProvider(srv.agents, provider);
    const explicit = overrides[srv.name];
    const enabled = explicit ?? defaultEnabled;
    user.push({
      name: srv.name,
      level: "user",
      server: srv,
      defaultEnabled,
      enabled,
      overridden: explicit !== undefined && explicit !== defaultEnabled,
      shadowsGlobal: false,
      lockedReason: null,
    });
  }

  const normalizedProvider = normalizeProviderId(provider);
  const nativeCli: NativeCliMcpItem[] = [];
  for (const src of sources) {
    if (!src.nativeProvider || normalizeProviderId(src.nativeProvider) !== normalizedProvider) continue;
    for (const srv of src.servers) {
      if (seenNames.has(srv.name) || !srv.enabled) continue;
      seenNames.add(srv.name);
      nativeCli.push({
        name: srv.name,
        sourceId: src.id,
        sourceLabel: src.label,
        sourcePath: src.path,
        server: srv,
      });
    }
  }

  const controllable = [...(ideMcpEnabled ? [ide] : []), ...workspace.filter((i) => !i.lockedReason), ...user];
  const activeCount = controllable.filter((i) => i.enabled).length + nativeCli.length;
  const totalCount = controllable.length + nativeCli.length;
  const overrideCount = controllable.filter((i) => i.overridden).length;

  return { ide, workspace, user, nativeCli, activeCount, totalCount, overrideCount };
}

/** Computes the minimal `mcpOverrides` map after toggling `name` to `nextEnabled`. */
export function nextSessionOverrides(
  current: Readonly<Record<string, boolean>> | undefined,
  item: SessionMcpItem,
  nextEnabled: boolean,
): Record<string, boolean> {
  const next = { ...(current ?? {}) };
  if (nextEnabled === item.defaultEnabled) {
    delete next[item.name];
  } else {
    next[item.name] = nextEnabled;
  }
  return next;
}

/** Shared window-level cache of configured MCP servers and discovered external CLI configs. */
interface McpCatalogState {
  servers: McpServer[];
  sources: McpExternalSource[];
  loaded: boolean;
  probes: Record<string, McpProbeResult>;
  probing: Record<string, boolean>;
}

export const useMcpCatalog = create<McpCatalogState>(() => ({
  servers: [],
  sources: [],
  loaded: false,
  probes: {},
  probing: {},
}));

let listenerAttached = false;

export async function refreshMcpCatalog(): Promise<void> {
  if (!isTauri()) return;
  const [servers, sources] = await Promise.all([
    defaultMcpBackend.list().catch(() => null),
    defaultMcpBackend.discoverSources?.().catch(() => null) ?? Promise.resolve(null),
  ]);
  useMcpCatalog.setState((prev) => ({
    servers: servers ?? prev.servers,
    sources: sources ?? prev.sources,
    loaded: true,
  }));
}

export function useMcpCatalogSync(): void {
  const root = useProject((s) => s.project?.root);
  useEffect(() => {
    if (!isTauri()) return;
    void refreshMcpCatalog();
    const onFocus = () => void refreshMcpCatalog();
    window.addEventListener("focus", onFocus);
    if (!listenerAttached && typeof onIdeEvent === "function") {
      listenerAttached = true;
      onIdeEvent("settingsChanged", (e) => {
        if (!e.key || e.key.startsWith("agents.mcpServers") || e.key.startsWith("mcpServer")) {
          void refreshMcpCatalog();
        }
      });
    }
    return () => window.removeEventListener("focus", onFocus);
  }, [root]);
}
