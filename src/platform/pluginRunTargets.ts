/** Host-owned registrations shared by plugins, Run and Settings. */
import { create } from "zustand";
import { useMemo } from "react";
import type { RegisteredRunTarget } from "@/bindings";
import { DEFAULT_RUN_TARGET, type RunTargetValid } from "./remoteSettings";
import { useWorkflowSettings, workflowSettings } from "./workflowSettings";

export const usePluginRunTargets = create<{ targets: RegisteredRunTarget[] }>(() => ({ targets: [] }));
export type RuntimeRunTarget = Omit<RunTargetValid, "kind"> & { kind: RunTargetValid["kind"] | "plugin" };
const converted = (targets: RegisteredRunTarget[]): RuntimeRunTarget[] =>
  targets.map((t) => ({
    ...DEFAULT_RUN_TARGET,
    kind: "plugin",
    id: t.id,
    name: `${t.target.name} (${t.pluginName})`,
  }));
export function runTargets(): RuntimeRunTarget[] {
  return [...workflowSettings().runTargets, ...converted(usePluginRunTargets.getState().targets)];
}
export function useRunTargets(): RuntimeRunTarget[] {
  const saved = useWorkflowSettings((s) => s.runTargets);
  const plugins = usePluginRunTargets((s) => s.targets);
  return useMemo(() => [...saved, ...converted(plugins)], [saved, plugins]);
}
