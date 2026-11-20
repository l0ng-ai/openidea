/**
 * The in-page Settings dialog and its built-in pages load when the dialog first
 * opens: on the desktop Settings use their own window by default, so the main
 * window rarely needs them.
 */
import { lazyComponent } from "@/ui";
import { DEFAULT_PAGE, splitPageTarget, useSettingsDialog } from "../model/staging";

let registry: Promise<typeof import("../pages/registry")> | null = null;
let pages: Promise<() => void> | null = null;

/** Pre-fetches the built-in page registry chunk without registering pages yet. */
export function preloadBuiltinRegistry(): Promise<unknown> {
  return (registry ??= import("../pages/registry"));
}

/** Registers the built-in pages once and preloads `pageId`'s body; resolves with their disposer. */
export async function loadBuiltinPages(opts: { pageId?: string; updates?: boolean } = {}): Promise<() => void> {
  const mod = await (registry ??= import("../pages/registry"));
  const dispose = await (pages ??= Promise.resolve(mod.registerBuiltinPages({ updates: opts.updates })));
  const target = opts.pageId ? splitPageTarget(opts.pageId).pageId : DEFAULT_PAGE;
  const preload = mod.preloadBuiltinPage(target);
  if (preload) await preload;
  return dispose;
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
