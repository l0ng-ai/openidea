/**
 * Applies settings that no other feature owns: keymap preset + overrides,
 * the Appearance options (UI font, zoom, compact mode… see
 * `appearanceRuntime`) and the document language. (Theme / accent are applied
 * by the workbench, editor options by the editor.) Runs on startup and
 * whenever `useProject.settings` changes.
 *
 * Settings written by any window (e.g. the Settings window) reach every window
 * through `settingsChanged`, which re-reads the effective settings.
 */
import { isTauri, onIdeEvent } from "@/platform/ipc";
import { applyKeymapSettings } from "@/platform/keymap";
import { loadSettings, useProject } from "@/platform/project";
import { applyAppearanceOptions, installAltDragGuard, installIdleSave } from "./appearanceRuntime";
import { validateSettings } from "./model/schema";

export function applyRuntimeSettings(raw: unknown, root: HTMLElement = document.documentElement): void {
  const s = validateSettings(raw);
  applyKeymapSettings(s.keymap, s.keymapOverrides, s.customKeymaps);

  applyAppearanceOptions(s, root);

  root.lang = s.appearance.locale === "zh" ? "zh-CN" : "en";
}

/** Subscribes to settings changes; returns the unsubscribe function. */
export function trackRuntimeSettings(): () => void {
  let last: unknown = undefined;
  const run = (settings: unknown) => {
    if (!settings || settings === last) return;
    last = settings;
    try {
      applyRuntimeSettings(settings);
    } catch (e) {
      console.error("applying settings failed", e);
    }
  };
  run(useProject.getState().settings);
  let cache: { raw: unknown; valid: ReturnType<typeof validateSettings> } | null = null;
  const current = () => {
    const raw = useProject.getState().settings;
    if (cache?.raw !== raw) cache = { raw, valid: validateSettings(raw) };
    return cache.valid;
  };
  let reload: ReturnType<typeof setTimeout> | undefined;
  const unsubs = [
    useProject.subscribe((s) => run(s.settings)),
    // One Apply writes several keys: re-read once.
    onIdeEvent("settingsChanged", () => {
      clearTimeout(reload);
      reload = setTimeout(() => void loadSettings().catch((e) => console.warn("cannot reload settings", e)), 30);
    }),
    () => clearTimeout(reload),
    installAltDragGuard(() => current().appearance.dndWithAltOnly),
    installIdleSave(() => ({ enabled: current().general.saveOnIdle, seconds: current().general.idleSeconds })),
  ];
  // Without a project nothing loads the global settings; do it so theme / keymap apply on the welcome screen.
  if (isTauri() && !useProject.getState().settings) {
    loadSettings().catch((e) => console.warn("cannot load settings", e));
  }
  return () => unsubs.forEach((u) => u());
}
