/**
 * "kotlin-lsp has expired — Update": JetBrains preview builds stop starting once their date
 * passes, and the backend then stops restarting them. Offer the latest release instead.
 * A managed copy comes before `PATH` (Homebrew), so installing it also replaces one found there.
 */
import { executeAction } from "@/platform/actions";
import { onIdeEvent } from "@/platform/ipc";
import { notifications } from "@/workbench/contributions";
import { tx } from "@/platform/i18n";
import { installTool, refreshTools, SETTINGS_PAGE_ID, toolByName } from "./store";

export const isExpiredBuild = (message: string | null) => !!message && /This build of .+ has expired/.test(message);

export async function promptUpdateExpired(name: string) {
  await refreshTools();
  const tool = toolByName(name);
  const display = tool?.displayName ?? name;
  const key = `lsp-expired-${name}`;
  const installable = tool?.canInstall && (tool.status === "installed" || tool.status === "onPath");
  notifications().notify({
    group: "lsp",
    level: "warning",
    title: tx`${display} has expired`,
    body: !installable
      ? tx`This build of ${display} no longer starts. Choose a newer build in Language Servers.`
      : tool.status === "installed"
        ? tx`This build of ${display} no longer starts. Update it to the latest release?`
        : tx`This build of ${display} no longer starts. Install the latest release for the IDE? It is used instead of ${tool.path ?? tool.command}.`,
    key,
    sticky: true,
    actions: [
      ...(installable
        ? [
            {
              label: tool.status === "installed" ? "Update" : "Install Latest",
              run: () => void installTool(name, { notificationKey: key }),
            },
          ]
        : []),
      { label: "Language Servers…", run: () => void executeAction("file.settings", SETTINGS_PAGE_ID) },
    ],
  });
}

export function installExpiredServerPrompts(): () => void {
  return onIdeEvent("languageServer", (e) => {
    if (e.status === "crashed" && isExpiredBuild(e.message)) void promptUpdateExpired(e.name);
  });
}
