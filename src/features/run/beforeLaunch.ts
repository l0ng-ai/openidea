/**
 * Before launch tasks (IDEA's "Before launch" list): run in order before a
 * configuration starts; the first failure aborts the launch.
 */
import { dotnetBuildConfig } from "./dotnetTypes";
import { executeAction, getAction } from "@/platform/actions";
import { getContext } from "@/platform/context";
import { tx, txTemplate } from "@/platform/i18n";
import type { BeforeLaunchTask, RunConfig } from "@/platform/ipc";
import { workflowSettings } from "@/platform/workflowSettings";
import { notifications, toolWindowService, useContributions } from "@/workbench/contributions";
import { externalToolConfig } from "./externalTools";
import { startRun, useRun } from "./store";

export const BUILD_ACTION = "build.buildProject";
const BUILD_STATUS = "build.lastStatus";

export type BeforeLaunchKind = "run" | "build" | "tool" | "command" | "toolWindow" | "dotnetBuild";

export const TASK_LABELS: Record<BeforeLaunchKind, string> = {
  run: "Run Another Configuration",
  build: "Build Project",
  dotnetBuild: "Build .NET project",
  tool: "Run External Tool",
  command: "Run Shell Command",
  toolWindow: "Activate Tool Window",
};

/** One line for the task list, e.g. `Run 'migrate'`. */
export function taskLabel(task: BeforeLaunchTask, configs: readonly RunConfig[] = useRun.getState().configs): string {
  const target = task.target ?? "";
  switch (task.kind) {
    case "run":
      return `Run '${configs.find((c) => c.id === target)?.name ?? target}'`;
    case "build":
      return "Build Project";
    case "dotnetBuild":
      return "Build .NET project";
    case "tool":
      return `External tool '${workflowSettings().externalTools.find((t) => t.id === target)?.name ?? target}'`;
    case "command":
      return target ? `Run '${target}'` : "Run shell command";
    case "toolWindow":
      return `Activate '${useContributions.getState().toolWindows.get(target)?.title ?? target}' tool window`;
    default:
      return task.kind;
  }
}

/** Runs `config` to completion: true when it exited with code 0. */
async function runToEnd(config: RunConfig, chain: readonly string[]): Promise<boolean> {
  let done!: (ok: boolean) => void;
  const exited = new Promise<boolean>((resolve) => (done = resolve));
  const session = await startRun(config, undefined, undefined, {
    chain,
    onExit: (code, stopped) => done(code === 0 && !stopped),
  });
  if (!session || session.status === "failed") return false;
  return exited;
}

async function runTask(task: BeforeLaunchTask, config: RunConfig, chain: readonly string[]): Promise<string | null> {
  const target = task.target ?? "";
  switch (task.kind) {
    case "dotnetBuild":
      return (await runToEnd(dotnetBuildConfig(config), chain)) ? null : "Build failed";
    case "build": {
      if (!getAction(BUILD_ACTION)) return "Building is not available";
      if (!(await executeAction(BUILD_ACTION, { activate: false }))) return "A build is already running";
      return getContext()[BUILD_STATUS] === "success" ? null : "Build failed";
    }
    case "run": {
      if (chain.includes(target)) return "The before launch tasks run in a cycle";
      const other = useRun.getState().configs.find((c) => c.id === target);
      if (!other) return `Configuration '${target}' no longer exists`;
      return (await runToEnd(other, chain)) ? null : `'${other.name}' failed`;
    }
    case "tool": {
      const tool = workflowSettings().externalTools.find((t) => t.id === target);
      if (!tool) return `External tool '${target}' no longer exists`;
      const run = await externalToolConfig(tool);
      if (!run) return `'${tool.name}' was not run`;
      return (await runToEnd({ ...run, id: `${run.id}:before:${config.id}` }, chain)) ? null : `'${tool.name}' failed`;
    }
    case "command": {
      if (!target.trim()) return "No command";
      const run: RunConfig = {
        id: `before-launch:${config.id}:${target}`,
        name: target,
        kind: "shell",
        command: target,
        args: [],
        cwd: config.cwd,
        env: {},
        detected: true,
        isTest: false,
        debugAdapter: null,
      };
      return (await runToEnd(run, chain)) ? null : `'${target}' failed`;
    }
    case "toolWindow": {
      if (!useContributions.getState().toolWindows.has(target)) return `Tool window '${target}' is not available`;
      toolWindowService().show(target, true);
      return null;
    }
    default:
      return `Unknown before launch task '${task.kind}'`;
  }
}

/** The installed runner: every task in order; a failure is reported and aborts. */
export async function runBeforeLaunch(config: RunConfig, chain: readonly string[]): Promise<boolean> {
  for (const task of config.beforeLaunch ?? []) {
    let error: string | null;
    try {
      error = await runTask(task, config, chain);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    if (error) {
      notifications().notify({
        group: "run",
        level: "error",
        title: `'${config.name}' was not started`,
        body: `${tx("Before launch")}: ${txTemplate(taskLabel(task))}: ${txTemplate(error)}`,
        key: `run-before-launch-${config.id}`,
      });
      return false;
    }
  }
  return true;
}
