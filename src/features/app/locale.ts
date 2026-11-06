/** Keeps the UI locale in sync with `appearance.locale`; re-registers localised contributions. */
import { registerActions, type Action } from "@/platform/actions";
import { LOCALES, setLocale, useI18n } from "@/platform/i18n";
import { commands, isTauri, type Settings } from "@/platform/ipc";
import { useProject } from "@/platform/project";

export function localeSetting(settings: Settings | null | undefined): string | undefined {
  return settings?.appearance?.locale;
}

export function installLocaleSync(): () => void {
  let current: string | undefined;
  const apply = (settings: Settings | null | undefined) => {
    const value = localeSetting(settings);
    if (value === undefined || value === current) return;
    current = value;
    void setLocale(value).then((locale) => {
      if (isTauri()) void commands.pluginSetUiLocale(LOCALES[locale].tag).catch(() => {});
    });
  };
  const initial = useProject.getState().settings;
  if (initial) apply(initial);
  else if (isTauri()) void commands.settingsGet().then(apply, () => {});
  return useProject.subscribe((s, prev) => {
    if (s.settings !== prev.settings) apply(s.settings);
  });
}

/**
 * Registers actions whose titles come from `t()`, re-registering them when the
 * locale changes. Other features can copy this pattern.
 */
export function registerLocalizedActions(factory: () => Action[]): () => void {
  let dispose = registerActions(factory());
  const unsub = useI18n.subscribe((s, prev) => {
    if (s.messages === prev.messages) return;
    dispose();
    dispose = registerActions(factory());
  });
  return () => {
    unsub();
    dispose();
  };
}
