/**
 * Vim mode settings (Settings › Editor › Vim): on/off and the handler of each
 * shortcut conflict. IDE-level, kept in localStorage and picked up by every
 * window through `storage` events, like IdeaVim's application-level settings.
 */
import { create } from "zustand";

export type Handler = "vim" | "ide";

export interface VimSettings {
  enabled: boolean;
  /** Per-keystroke handler overrides (`Ctrl+R` → `ide`); missing keys use the default. */
  handlers: Record<string, Handler>;
}

export const VIM_SETTINGS_KEY = "openidea.vim.v1";

export const DEFAULT_VIM_SETTINGS: VimSettings = { enabled: false, handlers: {} };

/** Settings as stored, validated: unknown values fall back to defaults. */
export function parseVimSettings(raw: string | null | undefined): VimSettings {
  if (!raw) return DEFAULT_VIM_SETTINGS;
  try {
    const v = JSON.parse(raw) as Partial<VimSettings> | null;
    const handlers: Record<string, Handler> = {};
    if (v?.handlers && typeof v.handlers === "object")
      for (const [k, h] of Object.entries(v.handlers)) if (h === "vim" || h === "ide") handlers[k] = h;
    return { enabled: v?.enabled === true, handlers };
  } catch {
    return DEFAULT_VIM_SETTINGS;
  }
}

function load(): VimSettings {
  try {
    return parseVimSettings(globalThis.localStorage?.getItem(VIM_SETTINGS_KEY));
  } catch {
    return DEFAULT_VIM_SETTINGS;
  }
}

export const useVimSettings = create<VimSettings>(() => load());

export function updateVimSettings(patch: Partial<VimSettings>) {
  useVimSettings.setState(patch);
  try {
    globalThis.localStorage?.setItem(VIM_SETTINGS_KEY, JSON.stringify(useVimSettings.getState()));
  } catch {
    // Storage unavailable: the setting lasts for this session.
  }
}

export function setVimEnabled(enabled: boolean) {
  if (useVimSettings.getState().enabled !== enabled) updateVimSettings({ enabled });
}

/** Picks up changes saved by another window (the Settings window). */
export function syncVimSettingsFromStorage(): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === VIM_SETTINGS_KEY) useVimSettings.setState(load(), true);
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
