import { resolveLocale } from "@/platform/i18n";
import type { UpdateSource } from "@/platform/ipc";
import { useProject } from "@/platform/project";

/** System Settings > Updates > Update source; `auto` picks the CNB mirror for the Chinese UI. */
export function updateSource(): UpdateSource {
  const { settings } = useProject.getState();
  const chosen = settings?.general?.updateSource;
  if (chosen === "github" || chosen === "cnb") return chosen;
  return resolveLocale(settings?.appearance?.locale) === "zh" ? "cnb" : "github";
}
