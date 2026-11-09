/**
 * The in-page Settings dialog and its built-in pages load when the dialog first
 * opens: on the desktop Settings use their own window, so the main window rarely
 * needs them.
 */
import { lazyComponent } from "@/ui";
import { useSettingsDialog } from "../model/staging";

let pages: Promise<() => void> | null = null;

/** Registers the built-in pages once; resolves with their disposer. */
export function loadBuiltinPages(): Promise<() => void> {
  return (pages ??= import("../pages/registry").then((m) => m.registerBuiltinPages()));
}

/** Drops the pages registered by `loadBuiltinPages` (feature deactivation). */
export function unloadBuiltinPages() {
  const loaded = pages;
  pages = null;
  void loaded?.then((dispose) => dispose());
}

const Dialog = lazyComponent(() => import("./SettingsDialog").then((m) => m.SettingsDialog));
const ProjectStructure = lazyComponent(() =>
  import("../languages/ProjectStructurePage").then((m) => m.ProjectStructureDialog),
);

export function LazySettingsDialog() {
  const open = useSettingsDialog((s) => s.open);
  return open ? <Dialog /> : null;
}

export function LazyProjectStructureDialog() {
  const open = useSettingsDialog((s) => s.projectStructureOpen);
  return open ? <ProjectStructure /> : null;
}
