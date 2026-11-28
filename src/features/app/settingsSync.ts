/**
 * Settings › Settings Sync › Sync Now: sends the IDE state kept in localStorage along with the
 * sync and writes back what the merge changed.
 */
import { executeAction, type Action } from "@/platform/actions";
import { call, commands, isTauri, type SettingsSyncMode } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { tx } from "@/platform/i18n";
import { notifications } from "@/workbench/contributions";
import { ask } from "@/workbench/messages";
import { exportedStorage, isExported } from "./projectActions";

/** localStorage keys by sync category; everything else exported with the settings is `ui`. */
const TEMPLATES = ["openidea.liveTemplates.", "openidea.fileTemplates.", "openidea.postfix."];
const MACROS = "openidea.macros.";

function storageCategory(key: string): "templates" | "macros" | "ui" {
  if (TEMPLATES.some((p) => key.startsWith(p))) return "templates";
  return key.startsWith(MACROS) ? "macros" : "ui";
}

/** The entries of each category; project-scoped ones (`…:<path>`) stay on this machine. */
export function syncedStorage(storage: Record<string, string> = exportedStorage()) {
  const out: Record<"templates" | "macros" | "ui", Record<string, string>> = { templates: {}, macros: {}, ui: {} };
  for (const [key, value] of Object.entries(storage)) if (!key.includes(":")) out[storageCategory(key)][key] = value;
  return out;
}

/** Replaces the entries of the categories the sync changed. */
export function writeSyncedStorage(changed: Partial<Record<string, Record<string, string>>>, storage: Storage) {
  for (const key of Object.keys(exportedStorage(storage)))
    if (!key.includes(":") && changed[storageCategory(key)]) storage.removeItem(key);
  for (const entries of Object.values(changed))
    for (const [key, value] of Object.entries(entries ?? {}))
      if (isExported(key) && !key.includes(":"))
        try {
          storage.setItem(key, value);
        } catch {
          /* storage full */
        }
}

async function chooseMode(): Promise<SettingsSyncMode | null> {
  const { button } = await ask({
    title: tx("Settings Sync"),
    body: tx("The repository already holds settings. What should happen to the settings on this computer?"),
    buttons: [
      { id: "merge", label: tx("Merge"), primary: true },
      { id: "replaceLocal", label: tx("Use the Repository's") },
      { id: "replaceRemote", label: tx("Use This Computer's") },
    ],
  });
  return button === "merge" || button === "replaceLocal" || button === "replaceRemote" ? button : null;
}

let running = false;

async function syncSettingsNow() {
  if (running) return;
  running = true;
  try {
    let mode: SettingsSyncMode | null = null;
    let outcome = await call(commands.settingsSyncNow(syncedStorage(), mode));
    if (outcome.result.needsChoice) {
      mode = await chooseMode();
      if (!mode) return;
      outcome = await call(commands.settingsSyncNow(syncedStorage(), mode));
    }
    const { result, settings } = outcome;
    if (settings) useProject.setState({ settings });
    const storageChanged = Object.keys(result.storage).length > 0;
    if (storageChanged) writeSyncedStorage(result.storage, localStorage);
    const settingsList = result.overwritten.join(", ");
    const notes = [
      settingsList && tx`Changed on both computers, kept this computer's value: ${settingsList}`,
      storageChanged && tx("Restart to apply synced templates, macros, layouts and view options."),
    ].filter(Boolean);
    notifications().notify({
      level: "info",
      title: "Settings synced",
      body: notes.length ? notes.join(" ") : undefined,
      key: "app.settingsSync",
      sticky: storageChanged,
      actions: storageChanged ? [{ label: tx("Restart"), run: () => void executeAction("app.restart") }] : undefined,
    });
  } catch (e) {
    notifications().notify({
      level: "error",
      title: "Cannot sync settings",
      body: e instanceof Error ? e.message : String(e),
      key: "app.settingsSync",
    });
  } finally {
    running = false;
  }
}

export function settingsSyncActions(): Action[] {
  return [
    {
      id: "file.syncSettings",
      title: "Sync Settings Now",
      category: "File",
      keywords: ["settings sync", "settings repository", "gist", "manage ide settings"],
      run: () =>
        isTauri()
          ? syncSettingsNow()
          : notifications().notify({ level: "warning", title: "This needs the desktop app" }),
    },
  ];
}
