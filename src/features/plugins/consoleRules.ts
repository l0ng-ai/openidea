import type { ConsoleRule } from "@/bindings";
import { commands, isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { setConsoleRules, useConsoleRules } from "@/workbench/contributions";

const versions = new Map<string, number>();

/** Replaces a plugin's console highlight rules (`consoleRulesChanged`). */
export function setPluginConsoleRules(plugin: string, rules: readonly ConsoleRule[]) {
  versions.set(plugin, (versions.get(plugin) ?? 0) + 1);
  setConsoleRules(plugin, rules);
}

/** Catches up with rules set before this window opened, and again when it opens another project. */
export function startPluginConsoleRules(): () => void {
  let disposed = false;
  let revision = 0;
  const load = () => {
    const at = ++revision;
    const before = new Map(versions);
    if (isTauri())
      void Promise.resolve(commands.pluginConsoleRules())
        .then((all) => {
          if (disposed || at !== revision) return;
          // An event that arrived meanwhile is newer than the snapshot.
          const current = (plugin: string) => versions.get(plugin) === before.get(plugin);
          for (const plugin of useConsoleRules.getState().providers.keys())
            if (!all[plugin] && current(plugin)) setConsoleRules(plugin, []);
          for (const [plugin, rules] of Object.entries(all)) if (current(plugin)) setConsoleRules(plugin, rules);
        })
        .catch(() => {});
  };
  const offProject = useProject.subscribe((s, prev) => {
    if (s.project?.root !== prev.project?.root) load();
  });
  load();
  return () => {
    disposed = true;
    offProject();
    for (const plugin of useConsoleRules.getState().providers.keys()) setConsoleRules(plugin, []);
    versions.clear();
  };
}
