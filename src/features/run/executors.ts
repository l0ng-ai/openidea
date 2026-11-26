/**
 * Run executors contributed by other features (Run with Coverage, Profile):
 * the executor plans what to launch, the run shows in the Run tool window like
 * any other, and the executor hears when the process exits.
 */
import type { RunConfig } from "@/platform/ipc";
import { executeAction } from "@/platform/actions";
import { notifications, useRunExecutors, type ExecutorLaunch } from "@/workbench/contributions";
import { containerExecutorBlocked } from "./remote";
import { prepareLaunch, startRun } from "./store";

export async function runWithExecutor(config: RunConfig, executorId: string): Promise<void> {
  const executor = useRunExecutors.getState().executors.get(executorId);
  if (!executor) return;
  if (!executor.checksTarget && containerExecutorBlocked(config)) return;
  // Debug runs the before-launch tasks itself.
  if (!executor.debug && !(await prepareLaunch(config))) return;
  let plan: ExecutorLaunch | null;
  try {
    plan = await executor.prepare(config);
  } catch (e) {
    notifications().notify({
      group: "run",
      level: "error",
      title: `Cannot run '${config.name}'`,
      body: e instanceof Error ? e.message : String(e),
      userInitiated: true,
    });
    return;
  }
  if (!plan) return;
  const { launch, finished, beforeStop } = plan;
  if (executor.debug) {
    await executeAction("run.debugConfig", launch);
    return;
  }
  await startRun(config, undefined, undefined, {
    launch,
    onExit: (exitCode, stopped) => finished({ exitCode, stopped }),
    beforeStop,
  });
}
