/** Install / Uninstall the `openidea` shell command (macOS app bundle only). */
import type { Action } from "@/platform/actions";
import { t } from "@/platform/i18n";
import { call, commands, isCancelled } from "@/platform/ipc";
import { notifications } from "@/workbench/contributions";

const KEY = "app.cli";

function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

async function installCli(): Promise<void> {
  try {
    const link = await call(commands.appCliInstall());
    notifications().notify({ level: "info", title: t("app.cli.installed"), body: link, key: KEY });
  } catch (e) {
    if (!isCancelled(e))
      notifications().notify({ level: "error", title: t("app.cli.installFailed"), body: errorText(e), key: KEY });
  }
}

async function uninstallCli(): Promise<void> {
  try {
    const links = await call(commands.appCliUninstall());
    notifications().notify({
      level: "info",
      title: t(links.length ? "app.cli.uninstalled" : "app.cli.notInstalled"),
      body: links.join("\n") || undefined,
      key: KEY,
    });
  } catch (e) {
    if (!isCancelled(e))
      notifications().notify({ level: "error", title: t("app.cli.uninstallFailed"), body: errorText(e), key: KEY });
  }
}

export function cliActions(): Action[] {
  return [
    {
      id: "app.installCli",
      title: t("app.action.installCli"),
      category: t("app.category.tools"),
      keywords: ["cli", "shell", "terminal", "path", "command line", "launcher"],
      run: installCli,
    },
    {
      id: "app.uninstallCli",
      title: t("app.action.uninstallCli"),
      category: t("app.category.tools"),
      keywords: ["cli", "shell", "terminal", "path", "command line", "launcher"],
      run: uninstallCli,
    },
  ];
}
