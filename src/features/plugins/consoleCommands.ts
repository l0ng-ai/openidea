/** Console commands: plugins declare them (`[[contributes.consoleCommands]]`),
 * the Run console renders a trigger and runs the plugin's command with the
 * selection as its argument — the plugin owns the behaviour. */
import { setConsoleCommands, type ConsoleCommand } from "@/workbench/contributions";
import { pluginsBackend } from "./backend";

/** One `[[contributes.consoleCommands]]` declaration, validated by the host. */
export interface ConsoleCommandDecl {
  command: string;
  label: string;
  selectionContains?: string;
  icon?: string;
}

const live = new Map<string, Map<string, ConsoleCommand>>();

function sync(pluginId: string) {
  setConsoleCommands(pluginId, [...(live.get(pluginId)?.values() ?? [])]);
}

/** Puts one declared console command in effect; the returned disposer removes it. */
export function addConsoleCommand(pluginId: string, decl: ConsoleCommandDecl): () => void {
  if (!live.has(pluginId)) live.set(pluginId, new Map());
  const key = decl.command;
  const command: ConsoleCommand = {
    command: decl.command,
    label: decl.label,
    icon: decl.icon,
    when: (selection) => (decl.selectionContains ? selection.includes(decl.selectionContains) : selection.length > 0),
    run: async (selection) => {
      await pluginsBackend()
        .runCommand(pluginId, decl.command, selection, null, [])
        .catch(() => {
          // The command's own notification covers the failure.
        });
    },
  };
  live.get(pluginId)!.set(key, command);
  sync(pluginId);
  return () => {
    live.get(pluginId)?.delete(key);
    sync(pluginId);
  };
}
