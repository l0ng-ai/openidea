import { activateFeatures } from "./features";
import { isTauri } from "./platform/ipc";
import { installKeyboardDispatcher } from "./platform/keymap";
import { mountWindowRoot } from "./windowBoot";
import { activateWorkbench } from "./workbench/activate";
import { installFullscreenEscapeGuard } from "./workbench/fullscreenEscape";
import { Workbench } from "./workbench/Workbench";

export async function bootWorkbenchWindow(): Promise<void> {
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
