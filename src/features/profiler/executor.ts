/** The "Profile" executor: runs a configuration under a sampling profiler, then opens the snapshot. */
import { executeAction } from "@/platform/actions";
import { call, commands, isTauri, type ProfilerInstall, type RunConfig } from "@/platform/ipc";
import {
  notifications,
  toolWindowService,
  type ExecutorLaunch,
  type RunExecutorContribution,
} from "@/workbench/contributions";
import { profilerSupports } from "./model";
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

async function prepare(config: RunConfig): Promise<ExecutorLaunch | null> {
  if (!isTauri()) {
    notifications().notify({ group: "run", level: "warning", title: "Profiling needs the desktop app" });
    return null;
  }
  const plan = await call(commands.profilerPrepare(config, "cpu"));
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
  return {
    launch: plan.launch,
    // A stopped program still leaves samples behind (py-spy, perf); Node.js writes them on exit.
    finished: () => {
      void (async () => {
        try {
          const profile = await call(commands.profilerCollect(spec));
          addSnapshot(config.name, profile);
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
  };
}

export const profilerExecutor: RunExecutorContribution = {
  id: "profiler",
  label: (name) => `Profile '${name}'`,
  icon: "profile",
  action: "run.profile",
  order: 20,
  supports: (config) => profilerSupports(config),
  prepare,
};
