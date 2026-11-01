/** Agents of the ACP Registry: listing, install / update / remove (`agent_registry_*`). */
import { Channel } from "@tauri-apps/api/core";
import type {
  AgentProvider,
  AgentRegistry,
  InstallEvent,
  RegistryAgent,
  RegistryDistribution,
  RequestId,
} from "@/bindings";
import { call, commands } from "@/platform/ipc";

export interface RegistryBackend {
  list(request: RequestId): Promise<AgentRegistry>;
  install(id: string, request: RequestId, onEvent: (e: InstallEvent) => void): Promise<void>;
  remove(id: string): Promise<void>;
  cancel(request: RequestId): void;
}

/** The built-in agents' launch commands: read, and override through an agent file. */
export interface CommandsBackend {
  providers(): Promise<AgentProvider[]>;
  set(id: string, command: string | null): Promise<void>;
}

export const tauriRegistry: RegistryBackend = {
  list: (request) => call(commands.agentRegistryList(request)),
  install: async (id, request, onEvent) => {
    const channel = new Channel<InstallEvent>();
    channel.onmessage = onEvent;
    await call(commands.agentRegistryInstall(id, request, channel));
  },
  remove: async (id) => {
    await call(commands.agentRegistryRemove(id));
  },
  cancel: (request) => void commands.cancelRequest(request).catch(() => {}),
};

export const tauriCommands: CommandsBackend = {
  providers: () => call(commands.agentProviders()),
  set: async (id, command) => {
    await call(commands.agentSetCommand(id, command));
  },
};

export const DISTRIBUTION_LABEL: Record<RegistryDistribution, string> = {
  binary: "Binary",
  npx: "npm",
  uvx: "uv",
};

/** Every word of `query` occurs in the agent's name, id, description or authors. */
export function matchesQuery(agent: RegistryAgent, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = [agent.name, agent.id, agent.description, ...agent.authors].join(" ").toLowerCase();
  return words.every((w) => text.includes(w));
}

/** What the agent's row offers: install, or for an installed agent update and remove. */
export function rowActions(agent: RegistryAgent): { install: boolean; update: boolean; remove: boolean } {
  const installed = agent.installed != null;
  return {
    install: !installed && agent.distribution != null,
    update: installed && agent.update && agent.distribution != null,
    remove: installed,
  };
}

/** The registry list after `id` was installed at its current version, or removed. */
export function afterInstall(agents: RegistryAgent[], id: string): RegistryAgent[] {
  return agents.map((a) => (a.id === id ? { ...a, installed: a.version, update: false } : a));
}

export function afterRemove(agents: RegistryAgent[], id: string): RegistryAgent[] {
  return agents
    .map((a) => (a.id === id ? { ...a, installed: null, update: false } : a))
    .filter((a) => a.installed != null || a.distribution != null);
}

/**
 * Registry ids of agents from established vendors, most familiar first. The registry has
 * no popularity data and lists alphabetically, which puts small or unrelated projects on top.
 */
const FEATURED = [
  "amp-acp",
  "devin",
  "factory-droid",
  "junie",
  "cline",
  "kilo",
  "antigravity-acp",
  "grok-build",
  "qoder",
  "pi-acp",
  "poolside",
  "deepagents",
];

/** Installed agents first, then the featured ones in their order, then the rest by name. */
export function sortAgents(agents: RegistryAgent[]): RegistryAgent[] {
  const rank = (a: RegistryAgent) => {
    const featured = FEATURED.indexOf(a.id);
    return [a.installed != null ? 0 : 1, featured < 0 ? FEATURED.length : featured] as const;
  };
  return agents.slice().sort((a, b) => {
    const [ia, fa] = rank(a);
    const [ib, fb] = rank(b);
    return ia - ib || fa - fb || a.name.localeCompare(b.name);
  });
}
