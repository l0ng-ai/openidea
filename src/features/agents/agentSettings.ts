/** Settings › Agents, with the defaults filled in. */
import { useMemo } from "react";
import type { AgentSettings } from "@/bindings";
import { useProject } from "@/platform/project";

export type ResolvedAgentSettings = Required<AgentSettings>;

export const AGENT_SETTINGS_DEFAULTS: ResolvedAgentSettings = {
  showContextUsage: true,
  showWorkTime: true,
  showUsageLimits: true,
  showCost: false,
  foldTurns: true,
  smoothText: true,
  thinking: "auto",
  toolCalls: "grouped",
  expandToolOutput: false,
  sendWith: "enter",
  whileRunning: "queue",
  defaults: {},
  mcpServers: {},
};

export function resolveAgentSettings(s: AgentSettings | null | undefined): ResolvedAgentSettings {
  const set = Object.fromEntries(Object.entries(s ?? {}).filter(([, v]) => v !== undefined && v !== null));
  return { ...AGENT_SETTINGS_DEFAULTS, ...set };
}

export function useAgentSettings(): ResolvedAgentSettings {
  const s = useProject((p) => p.settings?.agents);
  return useMemo(() => resolveAgentSettings(s), [s]);
}
