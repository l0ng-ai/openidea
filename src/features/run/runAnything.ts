/** Run Anything entries for run configurations (npm scripts, cargo targets, user configurations…). */
import { executeAction } from "@/platform/actions";
import type { RunConfig } from "@/platform/ipc";
import type { RunAnythingItem, RunAnythingProvider } from "@/workbench/contributions";
import { useRun } from "./store";

const KIND_ICON: Record<string, string> = { npm: "file-npm", maven: "file-maven", gradle: "file-gradle" };

function item(c: RunConfig): RunAnythingItem {
  return {
    key: c.id,
    label: c.name,
    detail: c.kind,
    icon: KIND_ICON[c.kind] ?? "run",
    run: () => void executeAction("run.runConfig", c.id),
  };
}

/** Configurations whose name contains every word of `query`, best (prefix) matches first. */
export function matchingConfigs(configs: readonly RunConfig[], query: string): RunConfig[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const q = query.trim().toLowerCase();
  return configs
    .filter((c) => words.every((w) => c.name.toLowerCase().includes(w)))
    .sort((a, b) => Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)));
}

export const runConfigsRunAnything: RunAnythingProvider = {
  id: "run.configs",
  group: "Run Configurations",
  order: 10,
  items: (query) => matchingConfigs(useRun.getState().configs, query).map(item),
  // A configuration's name is no shell command: the terminal leaves it to the shell, as IDEA does.
  accepts: (line, terminal) => !terminal && useRun.getState().configs.some((c) => c.name === line.trim()),
  execute(line, terminal) {
    const config = !terminal && useRun.getState().configs.find((c) => c.name === line.trim());
    if (!config) return false;
    void executeAction("run.runConfig", config.id);
    return true;
  },
};
