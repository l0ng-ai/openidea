/**
 * Settings › Settings Sync › Sync Now: sends the IDE state kept in localStorage along with the
 * sync and writes back what the merge changed.
 */
import { executeAction, type Action } from "@/platform/actions";
import { call, commands, isTauri, onIdeEvent, type SettingsSyncMode } from "@/platform/ipc";
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

type Entries = Partial<Record<string, Record<string, string>>>;

/**
 * Replaces the entries of the categories the sync changed, except those changed here since
 * `sent` was read for the sync: the next sync takes those.
 */
export function writeSyncedStorage(changed: Entries, sent: Entries, storage: Storage) {
  const untouched = (key: string) => storage.getItem(key) === (sent[storageCategory(key)]?.[key] ?? null);
  for (const key of Object.keys(exportedStorage(storage)))
    if (
      !key.includes(":") &&
      changed[storageCategory(key)] &&
      !(key in changed[storageCategory(key)]!) &&
      untouched(key)
    )
      storage.removeItem(key);
  for (const entries of Object.values(changed))
    for (const [key, value] of Object.entries(entries ?? {}))
      if (isExported(key) && !key.includes(":") && untouched(key))
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
/** A change came in while a sync ran: sync again after it. */
let changedWhileRunning = false;

const syncNowAction = () => ({ label: tx("Sync Now"), run: () => void executeAction("file.syncSettings") });

/** Sync Now, or an automatic sync: that one never asks and stays quiet when nothing changed. */
async function syncSettings({ auto }: { auto: boolean }) {
  if (running) return;
  running = true;
  try {
    let mode: SettingsSyncMode | null = null;
    let sent = syncedStorage();
    // Only Sync Now may ask for credentials; automatic syncs use saved ones.
    let outcome = await call(commands.settingsSyncNow(sent, mode, !auto));
    if (outcome.result.needsChoice) {
      if (auto) {
        notifications().notify({
          level: "info",
          title: "Settings Sync is waiting for you",
          body: tx("The repository already holds settings. Sync Now to choose what happens to this computer's."),
          key: "app.settingsSync",
          sticky: true,
          actions: [syncNowAction()],
        });
        return;
      }
      mode = await chooseMode();
      if (!mode) return;
      sent = syncedStorage();
      outcome = await call(commands.settingsSyncNow(sent, mode, true));
    }
    const { result, settings } = outcome;
    if (settings) useProject.setState({ settings });
    const storageChanged = Object.keys(result.storage).length > 0;
    if (storageChanged) writeSyncedStorage(result.storage, sent, localStorage);
    if (auto && !settings && !storageChanged && !result.overwritten.length) return;
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
      level: auto ? "warning" : "error",
      title: "Cannot sync settings",
      body: e instanceof Error ? e.message : String(e),
      key: "app.settingsSync",
      actions: auto ? [syncNowAction()] : undefined,
    });
  } finally {
    running = false;
    if (changedWhileRunning) {
      changedWhileRunning = false;
      void autoSync(CHANGE_WINDOW, true);
    }
  }
}

const LAST_AUTO_SYNC = "openidea.settingsSync.lastAuto";
/** Startup syncs of windows opened within this time of each other run once. */
const STARTUP_WINDOW = 60_000;
/** Every window hears a settings change; one of them syncs. */
const CHANGE_WINDOW = 5_000;
const CHANGE_DELAY = 30_000;

/** Whether this window runs the automatic sync, claiming it from the other windows if so. */
export function claimAutoSync(within: number, now = Date.now(), storage: Storage = localStorage): boolean {
  const last = Number(storage.getItem(LAST_AUTO_SYNC) ?? 0);
  // A time ahead of now (the clock went back) has expired too.
  if (last <= now && now - last < within) return false;
  storage.setItem(LAST_AUTO_SYNC, String(now));
  return true;
}

const autoSyncOn = () => {
  const sync = useProject.getState().settings?.settingsSync;
  return !!sync?.auto && !!sync.repository?.trim();
};

/**
 * An automatic sync, unless another window just ran one. After a change (`changedOnly`) it
 * first asks, without the network, whether anything that syncs changed.
 */
async function autoSync(within: number, changedOnly: boolean) {
  if (!autoSyncOn()) return;
  if (running) {
    changedWhileRunning ||= changedOnly;
    return;
  }
  if (changedOnly && !(await call(commands.settingsSyncHasLocalChanges(syncedStorage())).catch(() => true))) return;
  if (running) {
    changedWhileRunning ||= changedOnly;
    return;
  }
  if (claimAutoSync(within)) await syncSettings({ auto: true });
}

/** Syncs on startup and after the settings change, while Sync automatically is on. */
export function installAutoSync(): () => void {
  if (!isTauri()) return () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  const startup = () => {
    if (started || !useProject.getState().settings) return;
    started = true;
    void autoSync(STARTUP_WINDOW, false);
  };
  const unsubscribe = useProject.subscribe(startup);
  startup();
  const off = onIdeEvent("settingsChanged", () => {
    clearTimeout(timer);
    timer = setTimeout(() => void autoSync(CHANGE_WINDOW, true), CHANGE_DELAY);
  });
  return () => {
    unsubscribe();
    off();
    clearTimeout(timer);
  };
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
          ? syncSettings({ auto: false })
          : notifications().notify({ level: "warning", title: "This needs the desktop app" }),
    },
  ];
}
