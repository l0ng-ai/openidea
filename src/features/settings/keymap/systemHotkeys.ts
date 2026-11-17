/**
 * Warns when another Windows app grabbed one of our Alt shortcuts (e.g.
 * NVIDIA's overlay swallowing `Alt+Shift+R`, so Rename never reaches the IDE).
 *
 * At startup the backend probes each single-stroke Alt binding with
 * `RegisterHotKey`: success means it is free (released immediately), refusal
 * means another app owns it. One aggregated notification opens Keymap, where
 * the conflicting shortcuts can be reassigned.
 */
import { tx } from "@/platform/i18n";
import { call, commands, isTauri } from "@/platform/ipc";
import {
  effectiveBindings,
  formatBinding,
  isMouseBinding,
  normalizeBinding,
  parseDoubleModifier,
} from "@/platform/keymap";
import { isPageSwipe } from "@/platform/pageSwipe";
import { usePlatform } from "@/platform/platformInfo";
import { notifications } from "@/workbench/contributions";
import { openSettings } from "../model/staging";

export const SYSTEM_HOTKEY_KEY = "keymap.systemHotkeys";

/**
 * The effective bindings worth probing: single-stroke Alt shortcuts (chords,
 * double-modifier gestures, mouse buttons and swipe gestures have no
 * `RegisterHotKey` equivalent; Meta combos are not stolen this way).
 */
export function systemHotkeyCandidates(bindings: Array<[string, string]>): string[] {
  const out = new Set<string>();
  for (const [binding] of bindings) {
    if (binding.includes(" ")) continue;
    if (parseDoubleModifier(binding) || isMouseBinding(binding) || isPageSwipe(binding)) continue;
    const parts = normalizeBinding(binding).split("+");
    const mods = parts.slice(0, -1);
    if (!mods.includes("Alt") || mods.includes("Meta")) continue;
    out.add(parts.join("+"));
  }
  return [...out];
}

let probed = false;

/** Probes once per session (Windows desktop only) and warns about grabs. */
export async function maybeWarnSystemHotkeys(): Promise<void> {
  if (probed) return;
  probed = true;
  try {
    if (!isTauri() || usePlatform.getState().os !== "windows") return;
    const candidates = systemHotkeyCandidates(effectiveBindings());
    if (!candidates.length) return;
    const grabbed = await call(commands.systemProbeHotkeys(candidates));
    if (!grabbed.length) return;
    const shortcuts = grabbed.map((b) => formatBinding(b)).join(", ");
    notifications().notify({
      level: "warning",
      key: SYSTEM_HOTKEY_KEY,
      title: "Some shortcuts are already used by another app",
      body: tx`These shortcuts never reach the IDE: ${shortcuts}. Open Keymap to reassign them.`,
      actions: [{ label: "Open Keymap", run: () => openSettings("keymap") }],
    });
  } catch (e) {
    console.warn("cannot probe system hotkeys", e);
  }
}

/** Tests only: resets the once-per-session guard. */
export function _resetSystemHotkeyProbeForTests(): void {
  probed = false;
}
