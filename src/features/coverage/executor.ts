/**
 * The "Run with Coverage" executor: the backend rewrites the configuration for
 * the runtime's coverage tool; after the run the report becomes a suite.
 */
import { executeAction } from "@/platform/actions";
import { call, commands, isTauri, type InstallCommand, type RunConfig } from "@/platform/ipc";
import {
  notifications,
  toolWindowService,
  type ExecutorLaunch,
  type RunExecutorContribution,
} from "@/workbench/contributions";
import { coverageSupports, formatPercent } from "./model";
import { addSuite } from "./store";
import { tx } from "@/platform/i18n";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A one-off configuration that runs an install command in the Run tool window. */
export function installConfig(tool: string, install: InstallCommand): RunConfig {
  return {
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
}

/** "<tool> is not installed" with an Install button running the install command. */
export function notifyMissingTool(
  group: string,
  missing: { tool: string; message: string; install: InstallCommand | null; homepage?: string | null },
) {
  const { tool, install } = missing;
  const line = install ? [install.command, ...install.args].join(" ") : null;
  const actions = [];
  if (install)
    actions.push({ label: "Install", run: () => void executeAction("run.runConfig", installConfig(tool, install)) });
  if (missing.homepage) {
    const url = missing.homepage;
    actions.push({
      label: "Download…",
      run: () => void import("@tauri-apps/plugin-opener").then((o) => o.openUrl(url)).catch(() => undefined),
    });
  }
  notifications().notify({
    group,
    level: "warning",
    key: `${group}-missing-${tool}`,
    title: `${tool} is not installed`,
    body: line
      ? tx`${missing.message} Install it with: ${line}`
      : missing.homepage
        ? `${missing.message} ${missing.homepage}`
        : missing.message,
    sticky: true,
    actions,
  });
}

async function prepare(config: RunConfig): Promise<ExecutorLaunch | null> {
  if (!isTauri()) {
    notifications().notify({ group: "run", level: "warning", title: "Coverage needs the desktop app" });
    return null;
  }
  const plan = await call(commands.coveragePrepare(config));
  if (plan.status === "unsupported") {
    notifications().notify({
      group: "run",
      level: "info",
      key: "coverage-unsupported",
      title: `Cannot run '${config.name}' with coverage`,
      body: plan.reason,
    });
    return null;
  }
  if (plan.status === "missingTool") {
    notifyMissingTool("run", plan);
    return null;
  }
  const report = plan.report;
  return {
    launch: plan.launch,
    finished: ({ stopped }) => {
      if (stopped) return;
      void (async () => {
        try {
          const data = await call(commands.coverageCollect(report));
          const suite = addSuite(config.name, data);
          const totals = data.files.reduce((a, f) => [a[0]! + f.linesCovered, a[1]! + f.linesTotal], [0, 0]);
          try {
            toolWindowService().show("coverage");
          } catch {
            /* no workbench (tests) */
          }
          notifications().notify({
            group: "run",
            level: "info",
            key: "coverage-done",
            title: `Coverage of '${suite.name}': ${formatPercent(totals[0]!, totals[1]!)} lines`,
          });
        } catch (e) {
          notifications().notify({
            group: "run",
            level: "error",
            key: "coverage-done",
            title: `No coverage data for '${config.name}'`,
            body: errorText(e),
          });
        }
      })();
    },
  };
}

export const coverageExecutor: RunExecutorContribution = {
  id: "coverage",
  label: (name) => tx`Run '${name}' with Coverage`,
  icon: "run-coverage",
  action: "run.coverage",
  order: 10,
  supports: coverageSupports,
  prepare,
};
