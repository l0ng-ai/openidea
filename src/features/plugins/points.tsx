/**
 * Client side of the first-party UI extension points: how each validated
 * declaration is projected onto the workbench, and how its items appear on
 * the plugin details page. One `defineUiPoint` per contribution type.
 */
import type { PluginInfo, ThemeDef } from "@/bindings";
import { registerAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { Button, Kbd, T } from "@/ui";
import { addIconTheme, iconThemeKey, selectIconTheme, useIconThemes } from "./iconThemes";
import { defineUiPoint, type UiItem } from "./projection";
import { SecretsDetails, type SecretDecl } from "./secrets";
import { defineViewUiPoints } from "./uiPoints";
import { isLive, runPluginCommand, selectPluginTheme, usePlugins } from "./store";
import styles from "./PluginsPage.module.css";

export const pluginActionId = (pluginId: string, commandId: string) => `plugin.${pluginId}.${commandId}`;

interface CommandDecl {
  id: string;
  title: string;
  category?: string | null;
  when?: string | null;
}

function CommandsDetails({ plugin, items }: { plugin: PluginInfo; items: UiItem<CommandDecl>[] }) {
  const runnable = plugin.status === "active" || plugin.status === "inactive";
  return (
    <ul className={styles.items}>
      {items.map(({ decl: c }) => {
        const actionId = pluginActionId(plugin.id, c.id);
        return (
          <li key={c.id} className={styles.item}>
            <span className={styles.itemMain}>{c.title}</span>
            <Kbd action={actionId} />
            <span className={styles.mono} title={tx("Action id (bind it in Keymap)")}>
              {actionId}
            </span>
            <Button
              size="small"
              variant="ghost"
              icon="run"
              disabled={!runnable}
              onClick={() => void runPluginCommand(plugin.id, c.id)}
              aria-label={tx`Run ${c.title}`}
            >
              <T>Run</T>
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

function ThemesDetails({ plugin, items }: { plugin: PluginInfo; items: UiItem<ThemeDef>[] }) {
  const activeTheme = usePlugins((s) => s.activeTheme);
  const live = isLive(plugin.status);
  return (
    <ul className={styles.items}>
      {items.map(({ decl: t }) => {
        const isActive = activeTheme?.pluginId === plugin.id && activeTheme.theme.id === t.id;
        return (
          <li key={t.id} className={styles.item}>
            <span className={styles.itemMain}>{t.name}</span>
            <span className={styles.muted}>{t.kind === "dark" ? tx("Dark") : tx("Light")}</span>
            {isActive ? (
              <Button size="small" variant="secondary" onClick={() => void selectPluginTheme(null, null)}>
                <T>Use Default Theme</T>
              </Button>
            ) : (
              <Button
                size="small"
                variant="ghost"
                disabled={!live}
                onClick={() => void selectPluginTheme(plugin.id, t.id)}
                aria-label={tx`Apply theme ${t.name}`}
              >
                <T>Apply</T>
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

interface IconThemeDecl {
  id: string;
  label: string;
  icons: number;
}

function IconThemesDetails({ plugin, items }: { plugin: PluginInfo; items: UiItem<IconThemeDecl>[] }) {
  const selected = useIconThemes((s) => s.selected);
  return (
    <ul className={styles.items}>
      {items.map(({ decl: t }) => {
        const key = iconThemeKey(plugin.id, t.id);
        return (
          <li key={t.id} className={styles.item}>
            <span className={styles.itemMain}>{t.label}</span>
            <span className={styles.muted}>{tx`${t.icons} icons`}</span>
            {selected === key ? (
              <Button size="small" variant="secondary" onClick={() => selectIconTheme(null)}>
                <T>Use Default Icons</T>
              </Button>
            ) : (
              <Button
                size="small"
                variant="ghost"
                onClick={() => selectIconTheme(key)}
                aria-label={tx`Apply icon theme ${t.label}`}
              >
                <T>Apply</T>
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Registers the client side of every first-party UI point. */
export function defineBuiltinUiPoints(): () => void {
  const disposers = [
    defineUiPoint<CommandDecl>("commands", {
      title: "Commands",
      project: ({ pluginId, decl }, { plugin }) =>
        registerAction({
          id: pluginActionId(pluginId, decl.id),
          title: decl.title,
          category: decl.category ?? plugin.name,
          icon: "package",
          when: decl.when ?? undefined,
          keywords: ["plugin", plugin.name, pluginId],
          description: tx`From plugin ${plugin.name}`,
          run: async ({ arg }) => {
            await runPluginCommand(pluginId, decl.id, typeof arg === "string" ? arg : null);
          },
        }),
      Details: CommandsDetails,
    }),
    // Applied through `activeTheme` (the backend owns the selection); listed here.
    defineUiPoint<ThemeDef>("themes", { title: "Themes", Details: ThemesDetails }),
    defineUiPoint<IconThemeDecl>("iconThemes", {
      title: "File Icon Themes",
      project: ({ pluginId, decl }) => addIconTheme({ pluginId, id: decl.id, label: decl.label }),
      Details: IconThemesDetails,
    }),
    // Stored by the backend; listed here with a field per secret.
    defineUiPoint<SecretDecl>("secrets", { title: "Secrets", Details: SecretsDetails }),
    defineViewUiPoints(),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
