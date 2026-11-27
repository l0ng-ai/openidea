import { create } from "zustand";

/** The action whose shortcut the Assign Shortcut dialog is editing. */
export const useAssignShortcut = create<{ actionId: string | null }>(() => ({ actionId: null }));

export function showAssignShortcut(actionId: string) {
  useAssignShortcut.setState({ actionId });
}
