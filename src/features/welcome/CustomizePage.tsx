/**
 * Welcome › Customize (IntelliJ's quick settings): colour theme, accent, IDE
 * font size, keymap and startup behaviour, written straight to the global
 * settings keys the Settings dialog edits.
 */
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { executeAction } from "@/platform/actions";
import { call, commands, isTauri } from "@/platform/ipc";
import { defaultPreset, PRESET_TITLES } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import { Checkbox, Select, type SelectOption, T } from "@/ui";
import { notifications } from "@/workbench/contributions";
import { ACCENT_PRESETS, DEFAULT_ACCENT, themeSelectOptions, useThemeChoices } from "@/workbench/theme";
import { reopenEnabled, setReopenPreference, useSession } from "./session";
import styles from "./Welcome.module.css";
import { isThemeChoiceId, type ThemeChoiceId } from "@/platform/themes";
import { tx } from "@/platform/i18n";

type Theme = ThemeChoiceId;

const DEFAULT_UI_FONT_SIZE = 13;
const DEFAULT_UI_FONT = "Inter";
export const UI_FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 17, 18];

/** Writes one global settings key and publishes the new effective settings. */
export async function setGlobalSetting(key: string, value: unknown): Promise<void> {
  if (!isTauri()) return;
  try {
    useProject.setState({ settings: await call(commands.settingsSet("global", key, JSON.stringify(value))) });
  } catch (e) {
    notifications().notify({
      level: "error",
      title: "Cannot save setting",
      body: e instanceof Error ? e.message : String(e),
      key: `welcome.setting:${key}`,
    });
  }
}

interface AppearanceView {
  theme: Theme;
  syncWithOs: boolean;
  accent: string;
  fontSize: number;
  keymap: string;
}

/** The values Customize shows, from (possibly partial / legacy) settings. */
export function customizeView(settings: ReturnType<typeof useProject.getState>["settings"]): AppearanceView {
  const a = (settings?.appearance ?? {}) as Record<string, unknown>;
  const theme = isThemeChoiceId(a.theme) ? a.theme : "light";
  const custom = a.useCustomFont === true;
  const size = typeof a.uiFontSize === "number" ? a.uiFontSize : DEFAULT_UI_FONT_SIZE;
  return {
    theme,
    syncWithOs: a.syncWithOs === true || a.theme === "system",
    accent: typeof a.accent === "string" ? a.accent.toLowerCase() : DEFAULT_ACCENT,
    fontSize: custom ? size : DEFAULT_UI_FONT_SIZE,
    keymap: typeof settings?.keymap === "string" && settings.keymap ? settings.keymap : defaultPreset(),
  };
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <div className={styles.fieldControl}>{children}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.section} aria-label={title}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      {children}
    </section>
  );
}

export function CustomizePage() {
  const settings = useProject((s) => s.settings);
  const pref = useSession((s) => s.reopenPref);
  const v = customizeView(settings);
  // Optimistic value while a write is in flight (and the only value outside Tauri).
  const [pending, setPending] = useState<Partial<AppearanceView & { reopen: boolean }>>({});
  const shown = { ...v, reopen: reopenEnabled(settings, pref), ...pending };

  const update = <K extends keyof typeof shown>(field: K, value: (typeof shown)[K], write: () => Promise<void>) => {
    setPending((p) => ({ ...p, [field]: value }));
    void write().finally(() =>
      setPending((p) => {
        const { [field]: _, ...rest } = p;
        return rest;
      }),
    );
  };

  const themes = useThemeChoices();
  const keymaps = useMemo<SelectOption[]>(() => {
    const custom = (settings?.customKeymaps ?? {}) as Record<string, { name?: string }>;
    const list: SelectOption[] = Object.entries(PRESET_TITLES).map(([value, label]) => ({ value, label }));
    for (const [id, k] of Object.entries(custom)) list.push({ value: id, label: k?.name || id });
    if (!list.some((o) => o.value === shown.keymap)) list.push({ value: shown.keymap, label: shown.keymap });
    return list;
  }, [settings?.customKeymaps, shown.keymap]);

  return (
    <div className={styles.customize}>
      <Section title="Color theme">
        <Field label="Theme">
          <Select<Theme>
            value={shown.theme}
            options={themeSelectOptions(themes, shown.theme)}
            disabled={shown.syncWithOs}
            aria-label="Color theme"
            onChange={(t) => update("theme", t, () => setGlobalSetting("appearance.theme", t))}
          />
          <Checkbox
            checked={shown.syncWithOs}
            label="Sync with OS"
            onChange={(on) =>
              update("syncWithOs", on, async () => {
                await setGlobalSetting("appearance.syncWithOs", on);
                // Legacy "system" theme: make the explicit choice concrete.
                if (!on && settings?.appearance?.theme === "system")
                  await setGlobalSetting("appearance.theme", "light");
              })
            }
          />
        </Field>
        <Field label="Accent color">
          <div className={styles.swatches} role="radiogroup" aria-label={tx("Accent color")}>
            {ACCENT_PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                role="radio"
                aria-checked={shown.accent === p.value}
                aria-label={p.label}
                title={p.label}
                className={styles.swatch}
                style={{ "--swatch": p.value } as CSSProperties}
                onClick={() => update("accent", p.value, () => setGlobalSetting("appearance.accent", p.value))}
              />
            ))}
          </div>
        </Field>
      </Section>

      <Section title="Accessibility">
        <Field label="IDE font">
          <Select
            value={String(shown.fontSize)}
            options={UI_FONT_SIZES.map((n) => ({ value: String(n), label: String(n) }))}
            aria-label="IDE font size"
            onChange={(raw) => {
              const n = Number(raw);
              update("fontSize", n, async () => {
                // The size only applies with "Use custom font" (Settings › Appearance).
                await setGlobalSetting("appearance.uiFontSize", n);
                const family = settings?.appearance?.uiFontFamily;
                const keepFamily =
                  settings?.appearance?.useCustomFont === true && !!family && family !== DEFAULT_UI_FONT;
                await setGlobalSetting("appearance.useCustomFont", n !== DEFAULT_UI_FONT_SIZE || keepFamily);
              });
            }}
          />
        </Field>
      </Section>

      <Section title="Keymap">
        <Field label="Keymap">
          <Select
            value={shown.keymap}
            options={keymaps}
            aria-label="Keymap"
            onChange={(k) => update("keymap", k, () => setGlobalSetting("keymap", k))}
          />
          <button type="button" className={styles.link} onClick={() => void executeAction("settings.keymap")}>
            <T>Configure…</T>
          </button>
        </Field>
      </Section>

      <Section title="Startup">
        <Checkbox
          checked={shown.reopen}
          label="Reopen last project on startup"
          onChange={(on) =>
            update("reopen", on, async () => {
              setReopenPreference(on);
              await setGlobalSetting("general.reopenLastProject", on);
            })
          }
        />
      </Section>

      <button type="button" className={styles.link} onClick={() => void executeAction("file.settings")}>
        <T>All settings…</T>
      </button>
    </div>
  );
}
