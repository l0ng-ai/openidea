import { create } from "zustand";

interface DialogState {
  open: boolean;
  /** Called with the plugin id after an import from the dialog. */
  onImported: ((id: string) => void) | null;
}

export const useIntellijThemesDialog = create<DialogState>(() => ({ open: false, onImported: null }));

/** Shows the themes of the JetBrains IDEs on this machine to pick one to import. */
export function showInstalledIntellijThemes(onImported?: (id: string) => void): void {
  useIntellijThemesDialog.setState({ open: true, onImported: onImported ?? null });
}

export function closeInstalledIntellijThemes(): void {
  useIntellijThemesDialog.setState({ open: false, onImported: null });
}
