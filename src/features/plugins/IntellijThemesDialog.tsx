/**
 * Import Theme from IntelliJ IDE: the theme plugins installed in the JetBrains
 * IDEs on this machine, each under its plugin's heading, the plugin of the
 * theme in use first. Importing a theme brings every theme of its plugin, as
 * installing the plugin in IntelliJ does, and applies the chosen one
 * (`importIntellijTheme`). A file can be chosen instead.
 */
import { useEffect, useState } from "react";
import clsx from "clsx";
import type { InstalledIntellijTheme } from "@/bindings";
import { tx } from "@/platform/i18n";
import { Badge, Dialog, List, Spinner, T } from "@/ui";
import { pluginsBackend } from "./backend";
import { closeInstalledIntellijThemes, importIntellijTheme, useIntellijThemesDialog } from "./intellijImport";
import { errorText } from "./store";
import styles from "./PluginsPage.module.css";

type Row =
  | { kind: "plugin"; key: string; plugin: string; ide: string; count: number; first: boolean }
  | { kind: "theme"; key: string; theme: InstalledIntellijTheme };

/** A heading per plugin (of an IDE) with its themes under it, in the order found (the one in use first). */
function themeRows(themes: readonly InstalledIntellijTheme[]): Row[] {
  const plugins = new Map<string, InstalledIntellijTheme[]>();
  for (const t of themes) {
    const key = `${t.ide}\n${t.path}`;
    plugins.set(key, [...(plugins.get(key) ?? []), t]);
  }
  return [...plugins].flatMap(([key, list], i): Row[] => [
    { kind: "plugin", key, plugin: list[0]!.plugin, ide: list[0]!.ide, count: list.length, first: i === 0 },
    ...list.map((theme): Row => ({ kind: "theme", key: `${key}\n${theme.themeId}`, theme })),
  ]);
}

function IntellijThemesDialog() {
  const [themes, setThemes] = useState<InstalledIntellijTheme[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The first theme, under the first heading.
  const [active, setActive] = useState(1);
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

  const run = (theme?: InstalledIntellijTheme) => {
    const { onImported } = useIntellijThemesDialog.getState();
    closeInstalledIntellijThemes();
    void importIntellijTheme(theme?.path, theme?.themeId).then((id) => id && onImported?.(id));
  };
  const rows = themeRows(themes ?? []);
  const row = rows[active];
  const chosen = row?.kind === "theme" ? row.theme : undefined;

  return (
    <Dialog
      open
      title="Import Theme from IntelliJ IDE"
      width={640}
      onClose={closeInstalledIntellijThemes}
      buttons={[
        { label: "Choose File…", role: "extra", onClick: () => run() },
        { label: "Cancel", role: "cancel" },
        { label: "Import", role: "default", disabled: !chosen, onClick: () => chosen && run(chosen) },
      ]}
    >
      <div className={styles.intellijThemes}>
        <p className={styles.muted}>
          <T>
            Theme plugins installed in the JetBrains IDEs on this computer. Importing a theme brings every theme of its
            plugin and applies the chosen one. Colours without an OpenIDEA counterpart keep the default theme colours.
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
            isSection={(r) => r.kind === "plugin"}
            activeIndex={chosen ? active : -1}
            onActiveChange={setActive}
            rowHeight={28}
            sectionHeight={30}
            className={styles.intellijThemesList}
            aria-label={tx("IntelliJ themes")}
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
            renderSection={(r) =>
              r.kind === "plugin" && (
                <div className={clsx(styles.intellijPlugin, !r.first && styles.intellijPluginNext)}>
                  <span className={styles.intellijPluginName}>{r.plugin}</span>
                  <span>{r.count === 1 ? tx("1 theme") : tx`${r.count} themes`}</span>
                  <span className={styles.intellijPluginIde}>{r.ide}</span>
                </div>
              )
            }
            renderItem={(r) =>
              r.kind === "theme" && (
                <div className={styles.intellijTheme}>
                  <span className={styles.itemMain}>{r.theme.themeName}</span>
                  {r.theme.active && <Badge tone="accent">{tx("In use")}</Badge>}
                  <span className={styles.muted}>{r.theme.dark ? tx("Dark") : tx("Light")}</span>
                </div>
              )
            }
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
