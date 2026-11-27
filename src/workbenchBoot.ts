import { activateFeatures } from "./features";
import { setLocale } from "./platform/i18n";
import { isTauri } from "./platform/ipc";
import { installKeyboardDispatcher } from "./platform/keymap";
import { loadSettings, useProject } from "./platform/project";
import { mountWindowRoot } from "./windowBoot";
import { activateWorkbench } from "./workbench/activate";
import { installFullscreenEscapeGuard } from "./workbench/fullscreenEscape";
import { Workbench } from "./workbench/Workbench";

export async function bootWorkbenchWindow(): Promise<void> {
  if (isTauri()) {
    try {
      await loadSettings();
      await setLocale(useProject.getState().settings?.appearance?.locale);
    } catch (error) {
      console.warn("cannot load startup settings", error);
    }
  }
  // Before the features' and the dispatcher's key handlers: it wraps the Escape they see.
  installFullscreenEscapeGuard();
  activateWorkbench();
  // `vite build --mode perf` is a production bundle for the performance harness (`perf/`).
  const perfBuild = import.meta.env.MODE === "perf";
  if ((import.meta.env.DEV || perfBuild) && !isTauri()) {
    const { registerDevSamples } = await import("./workbench/devSamples");
    registerDevSamples();
  }
  if (import.meta.env.DEV || perfBuild) {
    const { installPerfProbe } = await import("./workbench/perfProbe");
    installPerfProbe();
  }
  // Order matters: features (e.g. the terminal) install capture-phase key handlers
  // that must run before the global dispatcher.
  activateFeatures();
  installKeyboardDispatcher();
  mountWindowRoot(Workbench, { prefetchLazy: true });
}
