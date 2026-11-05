import { tx } from "@/platform/i18n";
import { call, commands, isTauri } from "@/platform/ipc";
import { loadSettings } from "@/platform/project";
import { confirmChecked } from "./messages";

/**
 * IDEA's question before closing a Run or Debug tab whose process still runs (asked while
 * `run.confirmTerminate` is on). Resolves true for Terminate.
 */
export async function confirmTerminate(name: string): Promise<boolean> {
  const answer = await confirmChecked({
    title: tx`Process '${name}' Is Running`,
    message: tx`Do you want to terminate the process '${name}'?`,
    ok: "Terminate",
    checkbox: "Do not ask again",
  });
  if (answer?.checked && isTauri()) {
    try {
      await call(commands.settingsSet("global", "run.confirmTerminate", "false"));
      await loadSettings();
    } catch {
      /* keep asking */
    }
  }
  return answer !== null;
}
