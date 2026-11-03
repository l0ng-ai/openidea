/**
 * Applies Settings › Editor › Color Scheme (scheme + attribute overrides) as one
 * stylesheet, and Editor › Font › Typography Settings as the root's
 * `--fw-code` / `--fw-code-bold`. When the IDE theme turns light or dark, a chosen
 * scheme of the other kind is switched back to the theme's own.
 */
import { useProject } from "@/platform/project";
import { editorPrefs, fontWeightVars } from "@/platform/editorSettings";
import { schemeAfterThemeChange, schemeCss } from "@/platform/colorScheme";
import { call, commands, isTauri } from "@/platform/ipc";

export function installColorScheme(): () => void {
  if (typeof document === "undefined") return () => {};
  const el = document.createElement("style");
  el.id = "openidea-editor-color-scheme";
  document.head.appendChild(el);
  const root = document.documentElement;
  const apply = () => {
    const settings = useProject.getState().settings;
    const prefs = editorPrefs(settings);
    const css = schemeCss(settings?.editor?.colorScheme, prefs.colorOverrides, undefined, prefs.customSchemes);
    if (el.textContent !== css) el.textContent = css;
    for (const [name, value] of Object.entries(fontWeightVars(prefs.fontWeight, prefs.boldFontWeight)))
      if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
  };
  let kind = root.dataset.theme;
  const followTheme = () => {
    const next = root.dataset.theme;
    if (next === kind) return;
    const previous = kind;
    kind = next;
    const settings = useProject.getState().settings;
    if (!previous || !settings || (next !== "light" && next !== "dark")) return;
    const scheme = schemeAfterThemeChange(settings.editor?.colorScheme, next, editorPrefs(settings).customSchemes);
    if (scheme === null) return;
    if (!isTauri()) {
      useProject.setState({ settings: { ...settings, editor: { ...settings.editor, colorScheme: scheme } } });
      return;
    }
    call(commands.settingsSet("global", "editor.colorScheme", JSON.stringify(scheme))).then(
      (updated) => useProject.setState({ settings: updated }),
      (e) => console.warn("[color scheme] cannot follow the theme", e),
    );
  };
  apply();
  const unsubscribe = useProject.subscribe((s, prev) => {
    if (s.settings !== prev.settings) apply();
  });
  const observer =
    typeof MutationObserver !== "undefined"
      ? new MutationObserver(() => {
          apply();
          followTheme();
        })
      : null;
  observer?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-contrast", "data-color-theme", "data-plugin-theme"],
  });
  return () => {
    unsubscribe();
    observer?.disconnect();
    el.remove();
    root.style.removeProperty("--fw-code");
    root.style.removeProperty("--fw-code-bold");
  };
}
