/** The "Profile" executor: runs a configuration under a sampling profiler, then opens the snapshot. */
import { executeAction } from "@/platform/actions";
import { call, commands, isTauri, type ProfileMode, type ProfilerInstall, type RunConfig } from "@/platform/ipc";
import {
  notifications,
  toolWindowService,
  type ExecutorLaunch,
  type RunExecutorContribution,
} from "@/workbench/contributions";
import { allocationProfilerSupports, profilerSupports } from "./model";
import { addSnapshot } from "./store";
import { tx } from "@/platform/i18n";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function notifyMissing(tool: string, message: string, install: ProfilerInstall | null, homepage: string | null) {
  const actions: Array<{ label: string; run: () => void }> = [];
  if (install) {
    const config: RunConfig = {
      id: `install:${tool}`,
      name: `Install ${tool}`,
      kind: "shell",
      command: install.command,
      args: install.args,
      cwd: install.cwd,
      env: {},
      detected: true,
      isTest: false,
      debugAdapter: null,
    };
    actions.push({ label: "Install", run: () => void executeAction("run.runConfig", config) });
  }
  if (homepage)
    actions.push({
      label: "Download…",
      run: () => void import("@tauri-apps/plugin-opener").then((o) => o.openUrl(homepage)).catch(() => undefined),
    });
  const line = install ? [install.command, ...install.args].join(" ") : null;
  notifications().notify({
    group: "run",
    level: "warning",
    key: `profiler-missing-${tool}`,
    title: `${tool} is not installed`,
    body: line ? tx`${message} Install it with: ${line}` : homepage ? `${message} ${homepage}` : message,
    sticky: true,
    actions,
  });
}

// Kept as plain literals: the profiler view translates them with `tx`, and the catalog test only counts literals.
export const LIVE_NOT_STOPPED =
  "The program ended by itself, so no garbage collection ran before the profile was written: objects that were already unreachable may show as live.";
export const LIVE_NOT_COLLECTED =
  "No garbage collection finished before the program stopped (the JVM's attach listener did not answer in time or was not reachable): objects that were already unreachable may show as live.";

async function prepare(config: RunConfig, mode: ProfileMode): Promise<ExecutorLaunch | null> {
  if (!isTauri()) {
    notifications().notify({ group: "run", level: "warning", title: "Profiling needs the desktop app" });
    return null;
  }
  const plan = await call(commands.profilerPrepare(config, mode));
  if (plan.status === "unsupported") {
    notifications().notify({
      group: "run",
      level: "info",
      key: "profiler-unsupported",
      title: `Cannot profile '${config.name}'`,
      body: plan.reason,
    });
    return null;
  }
  if (plan.status === "missingTool") {
    notifyMissing(plan.tool, plan.message, plan.install, plan.homepage);
    return null;
  }
  const spec = plan.spec;
  // JVMs that ran a GC before Stop; the store calls the hooks detached, so no `this`.
  let collected = 0;
  const liveNotice = (stopped: boolean) => (!stopped ? LIVE_NOT_STOPPED : collected === 0 ? LIVE_NOT_COLLECTED : null);
  return {
    launch: plan.launch,
    // A stopped program still leaves samples behind (py-spy, perf); Node.js writes them on exit.
    finished: ({ stopped }) => {
      void (async () => {
        try {
          const profile = await call(commands.profilerCollect(spec));
          addSnapshot(config.name, profile, mode === "liveObjects" ? liveNotice(stopped) : null);
          try {
            toolWindowService().show("profiler", true);
          } catch {
            /* no workbench (tests) */
          }
        } catch (e) {
          notifications().notify({
            group: "run",
            level: "error",
            key: "profiler-done",
            title: `No profile for '${config.name}'`,
            body: errorText(e),
          });
        }
      })();
    },
    // The profile lists the objects alive when the JVM exits, so collect first (a stopped program is not collected).
    beforeStop:
      mode === "liveObjects"
        ? async (runId) => {
            collected = await call(commands.profilerGcBeforeStop(runId)).catch(() => 0);
          }
        : undefined,
  };
}

const EXECUTORS: Record<
  ProfileMode,
  { id: string; suffix: string; action: string; order: number; supports: RunExecutorContribution["supports"] }
> = {
  cpu: { id: "profiler", suffix: "", action: "run.profile", order: 20, supports: (c) => profilerSupports(c) },
  allocations: {
    id: "profilerAllocations",
    suffix: " Allocations",
    action: "run.profileAllocations",
    order: 21,
    supports: allocationProfilerSupports,
  },
  liveObjects: {
    id: "profilerLiveObjects",
    suffix: " Live Objects",
    action: "run.profileLiveObjects",
    order: 22,
    supports: allocationProfilerSupports,
  },
};

export function profilerExecutor(mode: ProfileMode): RunExecutorContribution {
  const { id, suffix, action, order, supports } = EXECUTORS[mode];
  return {
    id,
    label: (name) => `Profile '${name}'${suffix}`,
    icon: "profile",
    action,
    order,
    supports,
    prepare: (config) => prepare(config, mode),
  };
}
