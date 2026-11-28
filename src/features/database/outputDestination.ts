import { useProject } from "@/platform/project";
import { showServiceView, toolWindowService } from "@/workbench/contributions";

export const DB_OUTPUT_WINDOW = "databaseOutput";
export const RESULTS_VIEW = "dbResults";

export function outputDestination(settings: unknown = useProject.getState().settings): "databaseOutput" | "services" {
  return (settings as { database?: { outputDestination?: unknown } } | null)?.database?.outputDestination === "services"
    ? "services"
    : "databaseOutput";
}

const outputRevealListeners = new Set<(path: string) => void>();

export function onOutputReveal(listener: (path: string) => void) {
  outputRevealListeners.add(listener);
  return () => {
    outputRevealListeners.delete(listener);
  };
}

export function revealDatabaseResults(path?: string) {
  if (outputDestination() === "services") {
    showServiceView(RESULTS_VIEW, false);
  } else {
    if (path !== undefined) for (const listener of outputRevealListeners) listener(path);
    toolWindowService().show(DB_OUTPUT_WINDOW, false);
  }
}
