/**
 * IDEA's "Assign Shortcut" from Search Everywhere (⌥↵ on an action): the
 * Keymap page's keystroke dialog for one action, saved straight to the
 * active keymap (overrides of a bundled keymap, or the user keymap itself).
 */
import { useMemo } from "react";
import { useActions } from "@/platform/actions";
import { call, commands, isTauri } from "@/platform/ipc";
import type { Keymap } from "@/platform/keymap";
import { PRESETS } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import { validateSettings } from "../model/schema";
import {
  activeDraft,
  addBinding,
  removeConflicts,
  withCustomOverrides,
  type Conflict,
  type KeymapDraft,
} from "./model";
import { RecordShortcutDialog } from "./RecordShortcutDialog";

import { useAssignShortcut } from "./assignShortcutStore";
export { showAssignShortcut, useAssignShortcut } from "./assignShortcutStore";

interface KeymapSettings {
  keymap: string;
  keymapOverrides: Keymap;
  customKeymaps: ReturnType<typeof validateSettings>["customKeymaps"];
}

export function draftOf(s: KeymapSettings): KeymapDraft {
  return activeDraft(s.keymap, s.keymapOverrides, s.customKeymaps);
}

/** The settings key and value that add `binding` to `actionId` in the active keymap. */
export function assignedSetting(
  s: KeymapSettings,
  actionId: string,
  binding: string,
  conflicts: readonly Conflict[],
  removeOthers: boolean,
): { key: "keymapOverrides" | "customKeymaps"; value: unknown } {
  const draft = draftOf(s);
  const base = removeOthers ? { ...draft, overrides: removeConflicts(draft, conflicts) } : draft;
  const overrides = addBinding(base, actionId, binding);
  const custom = !PRESETS[s.keymap] && !!s.customKeymaps[s.keymap];
  return custom
    ? { key: "customKeymaps", value: withCustomOverrides(s.customKeymaps, s.keymap, overrides) }
    : { key: "keymapOverrides", value: overrides };
}

async function save(key: string, value: unknown) {
  if (!isTauri()) {
    const settings = useProject.getState().settings;
    useProject.setState({ settings: { ...(settings ?? {}), [key]: value } as typeof settings });
    return;
  }
  const settings = await call(commands.settingsSet("global", key, JSON.stringify(value)));
  useProject.setState({ settings });
}

export function AssignShortcutOverlay() {
  const actionId = useAssignShortcut((s) => s.actionId);
  const actionMap = useActions((s) => s.actions);
  const raw = useProject((s) => s.settings);
  const settings = useMemo(() => validateSettings(raw), [raw]);
  const actions = useMemo(() => [...actionMap.values()], [actionMap]);
  const action = actionId ? actionMap.get(actionId) : undefined;
  if (!action) return null;
  const close = () => useAssignShortcut.setState({ actionId: null });
  return (
    <RecordShortcutDialog
      action={action}
      actions={actions}
      draft={draftOf(settings)}
      onCancel={close}
      onSubmit={(binding, conflicts, remove) => {
        const { key, value } = assignedSetting(settings, action.id, binding, conflicts, remove);
        close();
        void save(key, value).catch((e) => console.error("cannot save the shortcut", e));
      }}
    />
  );
}
