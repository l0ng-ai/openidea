/**
 * "rust-analyzer is not installed — Install": when a language server reports
 * `missing` and we know how to install it, offer a one-click install that
 * restarts the server when done. Uses the same notification key as the
 * generic code-insight notice so it replaces it.
 */
import { executeAction } from "@/platform/actions";
import { onIdeEvent } from "@/platform/ipc";
import { notifications } from "@/workbench/contributions";
import { installTool, refreshTools, SETTINGS_PAGE_ID, toolByName, useTools } from "./store";
import { tx } from "@/platform/i18n";

export const missingKey = (name: string) => `lsp-missing-${name}`;

export async function promptInstall(name: string, sticky = true): Promise<boolean> {
  if (!useTools.getState().loaded) await refreshTools();
  const tool = toolByName(name);
  if (!tool || !tool.canInstall || tool.status !== "missing") return false;
  // An installed alternative (typescript-language-server for vtsls) already serves these files.
  const served = useTools
    .getState()
    .tools.some(
      (t) =>
        t.name !== name &&
        t.kind === tool.kind &&
        t.status !== "missing" &&
        t.languages.some((l) => tool.languages.includes(l)),
    );
  if (tool.kind !== "formatter" && served) return false;
  const key = missingKey(name);
  const langs = tool.languages.length ? tool.languages.join(", ") : "these files";
  notifications().notify({
    group: "tools",
    level: "warning",
    title: tx`${tool.displayName} is not installed`,
    body:
      tool.kind === "formatter"
        ? tx`Reformat Code needs ${tool.displayName}. Install it via ${tool.installMethod}?`
        : tx`Code insight for ${langs} needs ${tool.command}. Install it via ${tool.installMethod}?`,
    key,
    sticky,
    actions: [
      { label: "Install", run: () => void installTool(name, { notificationKey: key }) },
      { label: "Language Servers…", run: () => void executeAction("file.settings", SETTINGS_PAGE_ID) },
    ],
  });
  return true;
}

export function installMissingServerPrompts(): () => void {
  const prompted = new Set<string>();
  return onIdeEvent("languageServer", (e) => {
    if (e.status !== "missing" || prompted.has(e.name)) return;
    prompted.add(e.name);
    // Async on purpose: lands after the synchronous generic notice and replaces it.
    void promptInstall(e.name).catch(() => {});
  });
}
