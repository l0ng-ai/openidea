/**
 * Presentation Assistant: what to show for an action the user ran, its name and shortcut, and
 * optionally the shortcut in the other platform's keymap (macOS ⇄ Windows/Linux).
 */
import { getAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import {
  formatBinding,
  isMacHost,
  isMouseBinding,
  presetBindings,
  primaryKeyBinding,
  PRESETS,
  useKeymap,
} from "@/platform/keymap";

export interface PresentedAction {
  title: string;
  shortcut?: string;
  /** The shortcut in the other platform's keymap, with that platform's name. */
  alternate?: { keymap: string; shortcut: string };
}

/** The same keymap family on the other platform (`intellij-macos` ⇄ `intellij-windows`). */
export function alternatePreset(preset: string, mac: boolean): string {
  const swapped = mac ? preset.replace(/-macos$/, "-windows") : preset.replace(/-windows$/, "-macos");
  if (swapped !== preset && swapped in PRESETS) return swapped;
  return mac ? "intellij-windows" : "intellij-macos";
}

export function presentAction(id: string, alternateKeymap: boolean, mac = isMacHost()): PresentedAction | null {
  const action = getAction(id);
  // Hidden actions are internal steps (accepting a completion, focusing the editor), not commands.
  if (!action || action.hidden) return null;
  const title = action.verbatim ? action.title : tx(action.title);
  const binding = primaryKeyBinding(id);
  const presented: PresentedAction = { title, shortcut: binding ? formatBinding(binding, mac) : undefined };
  if (alternateKeymap) {
    const other = presetBindings(alternatePreset(useKeymap.getState().preset, mac), id).find((b) => !isMouseBinding(b));
    if (other) presented.alternate = { keymap: mac ? "Windows/Linux" : "macOS", shortcut: formatBinding(other, !mac) };
  }
  return presented;
}
