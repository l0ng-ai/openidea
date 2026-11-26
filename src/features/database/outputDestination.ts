import { useProject } from "@/platform/project";
import { showServiceView, toolWindowService } from "@/workbench/contributions";

export const DB_OUTPUT_WINDOW = "databaseOutput";
export const RESULTS_VIEW = "dbResults";

export function outputDestination(settings: unknown = useProject.getState().settings): "databaseOutput" | "services" {
  return (settings as { database?: { outputDestination?: unknown } } | null)?.database?.outputDestination === "services"
    ? "services"
    : "databaseOutput";
}

export function revealDatabaseResults() {
  if (outputDestination() === "services") showServiceView(RESULTS_VIEW, false);
  else toolWindowService().show(DB_OUTPUT_WINDOW, false);
}
