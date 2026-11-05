/**
 * Settings › Plugins › Import IntelliJ Theme: an IntelliJ theme plugin (a
 * Marketplace `.jar` / `.zip`, a plugin folder of an installed IDE) or a
 * `.theme.json` becomes an OpenIDEA theme plugin — read by the host, converted
 * here (`intellijTheme.ts`), installed through the usual install page — and
 * its theme is applied.
 */
import { create } from "zustand";
import { pluginThemeRef } from "@/platform/themes";
import { notifications } from "@/workbench/contributions";
import { setTheme } from "@/workbench/theme";
import { pluginsBackend } from "./backend";
import { intellijThemePackage, type ThemePackage } from "./intellijTheme";
import { errorText, installFromDisk } from "./store";

/**
 * Imports the IntelliJ theme plugin at `path` (asks for a file without one)
 * and applies its theme `themeId` (an IntelliJ theme id), or its first.
 * Returns the installed plugin's id.
 */
export async function importIntellijTheme(path?: string, themeId?: string): Promise<string | null> {
  const backend = pluginsBackend();
  let pkg: ThemePackage;
  let dir: string;
  try {
    const picked = path ?? (await backend.pickIntellijTheme());
    if (!picked) return null;
    pkg = intellijThemePackage(await backend.readIntellijTheme(picked));
    dir = await backend.stagePackage(pkg.id, pkg.files);
  } catch (e) {
    notifications().notify({
      group: "plugins",
      level: "error",
      title: "Could not import the IntelliJ theme",
      body: errorText(e),
    });
    return null;
  }
  const id = await installFromDisk(dir);
  if (!id) return null;
  const theme = pkg.themes.find((t) => t.sourceId === themeId) ?? pkg.themes[0];
  if (theme) await setTheme(pluginThemeRef(id, theme.id));
  return id;
}

interface DialogState {
  open: boolean;
  /** Called with the plugin id after an import from the dialog. */
  onImported: ((id: string) => void) | null;
}

export const useIntellijThemesDialog = create<DialogState>(() => ({ open: false, onImported: null }));

/** Shows the themes of the JetBrains IDEs on this machine to pick one to import. */
export function showInstalledIntellijThemes(onImported?: (id: string) => void): void {
  useIntellijThemesDialog.setState({ open: true, onImported: onImported ?? null });
}

export function closeInstalledIntellijThemes(): void {
  useIntellijThemesDialog.setState({ open: false, onImported: null });
}
