/**
 * Plugin configurations whose debugger attaches to a process the run starts (plugin API 1.9
 * `attach-child`, e.g. an Azure Functions worker started by `func start`): Debug runs the
 * configuration as Run does, waits for that process and attaches the debugger to it.
 */
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { call, commands, type RunConfig } from "@/platform/ipc";
import { notifications } from "@/workbench/contributions";
import { startRun, type RunSession } from "./store";

export function attachesToChild(config: RunConfig): boolean {
  return config.kind === "plugin" && !!config.params?.debugAttach;
}

/** Starts the run, then attaches; resolves with the run's session once it started (null when it didn't). */
export async function debugAttachingToChild(
  config: RunConfig,
  options: { show?: boolean; prepared?: boolean; onExit?: (code: number | null, stopped: boolean) => void } = {},
): Promise<RunSession | null> {
  const session = await startRun(config, undefined, undefined, options);
  const runId = session?.runId ?? null;
  if (runId === null) return session;
  void call(commands.pluginDebugAttachTarget(config.id, runId)).then(
    (attachable) =>
      executeAction("debug.attach", { attachable, process: runId, runConfig: config, show: options.show }),
    (e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      notifications().notify({
        group: "run",
        level: "warning",
        title: tx("Cannot attach the debugger"),
        body: tx`'${config.name}' keeps running without the debugger: ${message}`,
      });
    },
  );
  return session;
}
