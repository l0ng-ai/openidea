/**
 * Reload Environment: new terminals, runs, language servers and tools get the login
 * shell's current environment (on a remote host, the project's `devcontainer.json`
 * `remoteEnv`, and the project's direnv `.envrc`) without restarting the backend. What is
 * already running keeps its own.
 */
import type { DirenvStatus } from "@/bindings";
import { tx } from "@/platform/i18n";
import { call, commands, onIdeEvent, type EnvReloaded } from "@/platform/ipc";
import { notifications } from "@/workbench/contributions";

const KEY = "remote.reloadEnvironment";
/** Variable names listed in the notification before "and N more". */
const LISTED = 8;

/** The notification text for a reload result. */
export function reloadSummary(r: EnvReloaded): string {
  const names = r.changed.slice(0, LISTED).join(", ");
  const more = r.changed.length - LISTED;
  const changed =
    r.changed.length === 0
      ? tx("No variables changed.")
      : more > 0
        ? tx`Changed: ${names} and ${more} more.`
        : tx`Changed: ${names}.`;
  const keep = tx("Terminals and processes already running keep their old environment; new ones get the new one.");
  return [changed, keep].join(" ");
}

async function restartLanguageServers() {
  try {
    const servers = await call(commands.lspServers());
    await Promise.all(servers.map((s) => call(commands.lspRestart(s.id))));
  } catch (e) {
    notifications().notify({
      group: "lsp",
      level: "error",
      title: "Failed to restart language server",
      body: e instanceof Error ? e.message : String(e),
    });
  }
}

export async function reloadEnvironment() {
  let result: EnvReloaded;
  try {
    result = await call(commands.envReload());
  } catch (e) {
    notifications().notify({
      key: KEY,
      level: "error",
      title: "Could not reload the environment",
      body: e instanceof Error ? e.message : String(e),
    });
    return;
  }
  notifications().notify({
    key: KEY,
    level: "info",
    title: "Environment reloaded",
    body: reloadSummary(result),
    actions: result.changed.length
      ? [{ label: "Restart Language Servers", run: () => void restartLanguageServers() }]
      : [],
  });
}

const DIRENV_KEY = "remote.direnv";

/**
 * What the backend reports about the project's direnv environment: it couldn't load (direnv
 * missing, the `.envrc` not allowed, an error), or a file it is read from changed. The IDE
 * never runs `direnv allow` itself: approving the `.envrc` is the user's call.
 */
export function showDirenvStatus(status: DirenvStatus) {
  const reload = [{ label: "Reload Environment", run: () => void reloadEnvironment() }];
  const notify = notifications().notify;
  switch (status.kind) {
    case "notInstalled":
      notify({
        key: DIRENV_KEY,
        level: "info",
        title: "direnv is not installed",
        body: "This project has an .envrc. Install direnv so terminals, run configurations and language servers get its environment, then reload the environment.",
        actions: reload,
      });
      return;
    case "blocked":
      notify({
        key: DIRENV_KEY,
        level: "warning",
        title: "The project's .envrc is blocked",
        body: "direnv runs it only once you allow it. Review it, run direnv allow in the project folder, then reload the environment.",
        actions: reload,
      });
      return;
    case "failed":
      notify({
        key: DIRENV_KEY,
        level: "error",
        title: "Could not load the direnv environment",
        body: status.message,
        actions: reload,
      });
      return;
    case "changed": {
      const file = status.file;
      notify({
        key: DIRENV_KEY,
        level: "info",
        title: tx`${file} changed`,
        body: "Reload the environment so new terminals, runs and language servers get the project's direnv environment again.",
        actions: reload,
      });
      return;
    }
  }
}

export function installDirenvNotifications(): () => void {
  return onIdeEvent("direnv", (e) => showDirenvStatus(e.status));
}
