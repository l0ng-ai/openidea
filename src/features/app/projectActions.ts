/**
 * File menu actions around the project and the IDE settings: New Project…,
 * Rename Project…, Manage IDE Settings › Export / Import Settings… and Power
 * Save Mode (with its editor banner).
 */
import { executeAction, type Action } from "@/platform/actions";
import { isPowerSaveMode } from "@/platform/editorSettings";
import { call, commands, isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { notifications, registerEditorBanner } from "@/workbench/contributions";
import { promptInput } from "@/workbench/inputDialogs";
import { importJetBrainsSettings } from "./jetbrainsSettings";
import { showNewProject } from "./NewProject";
import { tx } from "@/platform/i18n";

/** localStorage prefixes of IDE-level state exported with the settings (templates, macros, layouts). */
export const EXPORTED_STORAGE = [
  "openidea.liveTemplates.",
  "openidea.fileTemplates.",
  "openidea.postfix.",
  "openidea.macros.",
  "openidea.toolWindowLayouts.",
];

/** IDE-level preferences kept in localStorage, exported with the settings as well. */
const EXPORTED_KEYS = new Set([
  "openidea.projectTree.options",
  "openidea.todo.v1",
  "openidea.vim.v1",
  "openidea.vcs.diffOptions",
  "openidea.vcs.diffPreview",
  "openidea.vcs.branchesPopup.options",
  "openidea.merge.autoApplyNonConflicting",
  "openidea.markdown.defaultMode",
  "openidea.imageViewer.chessboard",
  "openidea.welcome.reopenLastProject",
]);

const isExported = (key: string) => EXPORTED_KEYS.has(key) || EXPORTED_STORAGE.some((p) => key.startsWith(p));

export function exportedStorage(
  storage: Pick<Storage, "length" | "key" | "getItem"> = localStorage,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key || !isExported(key)) continue;
    const value = storage.getItem(key);
    if (value !== null) out[key] = value;
  }
  return out;
}

function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

async function exportSettings() {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    title: "Export Settings",
    defaultPath: "openidea-settings.json",
    filters: [{ name: "OpenIDEA settings", extensions: ["json"] }],
  });
  if (!path) return;
  try {
    await call(commands.settingsExport(path, exportedStorage()));
    notifications().notify({ level: "info", title: "Settings exported", body: path, key: "app.settingsExport" });
  } catch (e) {
    notifications().notify({
      level: "error",
      title: "Cannot export settings",
      body: errorText(e),
      key: "app.settingsExport",
    });
  }
}

async function importSettings() {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    title: "Import Settings",
    multiple: false,
    filters: [{ name: "OpenIDEA or JetBrains settings", extensions: ["json", "zip"] }],
  });
  const path = Array.isArray(picked) ? picked[0] : picked;
  if (!path) return;
  try {
    if (/\.zip$/i.test(path)) return await importJetBrainsSettings(path);
    const result = await call(commands.settingsImport(path));
    for (const [key, value] of Object.entries(result.storage))
      if (isExported(key))
        try {
          localStorage.setItem(key, value);
        } catch {
          /* storage full */
        }
    useProject.setState({ settings: result.settings });
    notifications().notify({
      level: "info",
      title: "Settings imported",
      body: "Restart to apply imported templates, macros, layouts and view options.",
      key: "app.settingsImport",
      sticky: true,
      actions: [{ label: "Restart", run: () => void executeAction("app.restart") }],
    });
  } catch (e) {
    notifications().notify({
      level: "error",
      title: "Cannot import settings",
      body: errorText(e),
      key: "app.settingsImport",
    });
  }
}

async function renameProject() {
  const project = useProject.getState().project;
  if (!project) return;
  const folder = project.root.slice(project.root.replace(/[\\/]+$/, "").search(/[^\\/]*$/));
  const name = await promptInput({
    title: "Rename Project",
    label: "New project name:",
    initial: project.name,
    okLabel: "Rename",
    validate: () => null,
    hint: tx`Leave empty to use the folder name (${folder}).`,
  });
  if (name === null) return;
  try {
    const info = await call(commands.projectRename(name));
    useProject.setState((s) => ({ project: s.project && { ...s.project, name: info.name }, settings: info.settings }));
    void commands.menuRefresh();
  } catch (e) {
    notifications().notify({ level: "error", title: "Cannot rename project", body: errorText(e) });
  }
}

async function togglePowerSave() {
  const on = !isPowerSaveMode();
  try {
    useProject.setState({
      settings: await call(commands.settingsSet("global", "general.powerSaveMode", JSON.stringify(on))),
    });
  } catch (e) {
    notifications().notify({ level: "error", title: "Cannot change Power Save Mode", body: errorText(e) });
  }
}

const desktop = (run: () => Promise<void>) => () => {
  if (isTauri()) return run();
  notifications().notify({ level: "warning", title: "This needs the desktop app" });
};

export function projectActions(): Action[] {
  return [
    {
      id: "file.newProject",
      title: "New Project…",
      category: "File",
      icon: "folder-open",
      keywords: ["create project", "empty project", "git init"],
      run: desktop(async () => showNewProject()),
    },
    {
      id: "file.renameProject",
      title: "Rename Project…",
      category: "File",
      keywords: ["project name"],
      when: "projectOpen",
      run: desktop(renameProject),
    },
    {
      id: "file.exportSettings",
      title: "Export Settings…",
      category: "File",
      keywords: ["backup settings", "keymap", "templates", "manage ide settings"],
      run: desktop(exportSettings),
    },
    {
      id: "file.importSettings",
      title: "Import Settings…",
      category: "File",
      keywords: ["restore settings", "keymap", "templates", "manage ide settings"],
      run: desktop(importSettings),
    },
    {
      id: "file.togglePowerSave",
      title: "Power Save Mode",
      category: "File",
      keywords: ["battery", "performance", "code insight"],
      toggled: () => isPowerSaveMode(),
      run: togglePowerSave,
    },
  ];
}

/** The banner above every editor while Power Save Mode is on. */
export function registerPowerSaveBanner(): () => void {
  return registerEditorBanner({
    id: "app.powerSave",
    order: 0,
    useBanner: () => {
      const on = useProject((s) => isPowerSaveMode(s.settings));
      return on
        ? {
            text: "Power save mode is on: completion and documentation popups and usage highlighting are off.",
            actions: [{ label: "Turn Off", run: () => void togglePowerSave() }],
          }
        : null;
    },
  });
}
