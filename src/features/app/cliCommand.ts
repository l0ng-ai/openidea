/** Install / Uninstall the `openidea` shell command. */
import type { Action } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { call, commands, isCancelled } from "@/platform/ipc";
import { notifications } from "@/workbench/contributions";

const KEY = "app.cli";

function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

async function installCli(): Promise<void> {
  try {
    const result = await call(commands.appCliInstall());
    const hint = result.pathDirectory
      ? tx`Add ${result.pathDirectory} to the beginning of PATH, then open a new terminal.`
      : tx("Open a new terminal to use the openidea command.");
    notifications().notify({
      level: "info",
      title: tx("The openidea command is installed"),
      body: `${result.path}\n${hint}`,
      key: KEY,
    });
  } catch (e) {
    if (!isCancelled(e))
      notifications().notify({
        level: "error",
        title: tx("Cannot install the openidea command"),
        body: errorText(e),
        key: KEY,
      });
  }
}

async function uninstallCli(): Promise<void> {
  try {
    const links = await call(commands.appCliUninstall());
    notifications().notify({
      level: "info",
      title: tx(links.length ? "The openidea command is uninstalled" : "The openidea command is not installed"),
      body: links.join("\n") || undefined,
      key: KEY,
    });
  } catch (e) {
    if (!isCancelled(e))
      notifications().notify({
        level: "error",
        title: tx("Cannot uninstall the openidea command"),
        body: errorText(e),
        key: KEY,
      });
  }
}

export function cliActions(): Action[] {
  return [
    {
      id: "app.installCli",
      title: tx("Install 'openidea' Command"),
      category: tx("Tools"),
      keywords: ["cli", "shell", "terminal", "path", "command line", "launcher"],
      run: installCli,
    },
    {
      id: "app.uninstallCli",
      title: tx("Uninstall 'openidea' Command"),
      category: tx("Tools"),
      keywords: ["cli", "shell", "terminal", "path", "command line", "launcher"],
      run: uninstallCli,
    },
  ];
}
