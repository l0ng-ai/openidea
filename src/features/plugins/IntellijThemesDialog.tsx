/**
 * Import Theme from JetBrains IDE: the theme plugins installed in the JetBrains
 * IDEs (and Android Studio) on this machine, one row per plugin of each IDE, the
 * plugins of the themes in use first. Importing installs the plugin with all its
 * themes, as installing it in the IDE does (`importIntellijTheme`); which theme
 * to use stays a choice in Settings › Appearance. A file can be chosen instead.
 */
import { useEffect, useState } from "react";
import type { InstalledIntellijTheme } from "@/bindings";
import { tx } from "@/platform/i18n";
import { Badge, Dialog, List, Spinner, T } from "@/ui";
import { pluginsBackend } from "./backend";
import { closeInstalledIntellijThemes, importIntellijTheme, useIntellijThemesDialog } from "./intellijImport";
import { errorText } from "./store";
import styles from "./PluginsPage.module.css";

interface PluginRow {
  key: string;
  plugin: string;
  ide: string;
  path: string;
  themes: InstalledIntellijTheme[];
}

/** A row per plugin (of an IDE), in the order found (the one in use first). */
function pluginRows(themes: readonly InstalledIntellijTheme[]): PluginRow[] {
  const plugins = new Map<string, PluginRow>();
  for (const t of themes) {
    const key = `${t.ide}\n${t.path}`;
    const row = plugins.get(key) ?? { key, plugin: t.plugin, ide: t.ide, path: t.path, themes: [] };
    plugins.set(key, row);
    row.themes.push(t);
  }
  return [...plugins.values()];
}

function IntellijThemesDialog() {
  const [themes, setThemes] = useState<InstalledIntellijTheme[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  useEffect(() => {
    let live = true;
    pluginsBackend()
      .installedIntellijThemes()
      .then(
        (found) => live && setThemes(found),
        (e: unknown) => {
          if (!live) return;
          setError(errorText(e));
          setThemes([]);
        },
      );
    return () => {
      live = false;
    };
  }, []);

  const run = (path?: string) => {
    const { onImported } = useIntellijThemesDialog.getState();
    closeInstalledIntellijThemes();
    void importIntellijTheme(path).then((id) => id && onImported?.(id));
  };
  const rows = pluginRows(themes ?? []);
  const chosen = rows[active];

  return (
    <Dialog
      open
      title="Import Theme from JetBrains IDE"
      width={640}
      onClose={closeInstalledIntellijThemes}
      buttons={[
        { label: "Choose File…", role: "extra", onClick: () => run() },
        { label: "Cancel", role: "cancel" },
        { label: "Import", role: "default", disabled: !chosen, onClick: () => chosen && run(chosen.path) },
      ]}
    >
      <div className={styles.intellijThemes}>
        <p className={styles.muted}>
          <T>
            Theme plugins installed in the JetBrains IDEs on this computer. Importing one installs it with all its
            themes; choose the theme to use in Settings › Appearance. Colours without an OpenIDEA counterpart keep the
            default theme colours.
          </T>
        </p>
        {themes === null ? (
          <div className={styles.intellijThemesStatus}>
            <Spinner size={14} label="Looking for IntelliJ themes" />
            <T>Looking for IntelliJ themes…</T>
          </div>
        ) : (
          <List
            items={rows}
            getKey={(r) => r.key}
            activeIndex={chosen ? active : -1}
            onActiveChange={setActive}
            rowHeight={44}
            className={styles.intellijThemesList}
            aria-label={tx("IntelliJ theme plugins")}
            empty={
              <div className={styles.intellijThemesStatus} role="note">
                {error ?? (
                  <T>
                    No theme plugins found in JetBrains IDEs on this computer. Choose a theme plugin downloaded from the
                    JetBrains Marketplace (.jar or .zip) or a .theme.json file instead.
                  </T>
                )}
              </div>
            }
            renderItem={(r) => {
              const count = r.themes.length;
              return (
                <div className={styles.intellijPlugin}>
                  <div className={styles.intellijPluginHead}>
                    <span className={styles.itemMain}>{r.plugin}</span>
                    {r.themes.some((t) => t.active) && <Badge tone="accent">{tx("In use")}</Badge>}
                    <span className={styles.intellijPluginIde}>
                      {count === 1 ? tx("1 theme") : tx`${count} themes`} · {r.ide}
                    </span>
                  </div>
                  <span className={styles.intellijPluginThemes}>{r.themes.map((t) => t.themeName).join(", ")}</span>
                </div>
              );
            }}
          />
        )}
      </div>
    </Dialog>
  );
}

/** Overlay of the dialog while `showInstalledIntellijThemes` has it open. */
export function IntellijThemesDialogHost() {
  const open = useIntellijThemesDialog((s) => s.open);
  return open ? <IntellijThemesDialog /> : null;
}
