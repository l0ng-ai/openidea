/**
 * Before launch tasks (IDEA's "Before launch" list): run in order before a
 * configuration starts; the first failure aborts the launch.
 */
import { buildCMake, isCMakeBuild } from "./cmake";
import { dotnetBuildConfig } from "./dotnetTypes";
import { useProject } from "@/platform/project";
import { useBuildPresentation } from "@/platform/projectPresentation";
import { buildTask } from "./buildTask";
import { moduleTaskError } from "./configs";
import { tx, txTemplate } from "@/platform/i18n";
import type { BeforeLaunchTask, RunConfig } from "@/platform/ipc";
import { workflowSettings } from "@/platform/workflowSettings";
import { notifications, toolWindowService, useContributions } from "@/workbench/contributions";
import { externalToolConfig } from "./externalTools";
import { startRun, useRun } from "./store";

export const BUILD_ACTION = "build.buildProject";

export type BeforeLaunchKind =
  | "run"
  | "build"
  | "buildModule"
  | "buildArtifacts"
  | "tool"
  | "command"
  | "toolWindow"
  | "dotnetBuild";

export const TASK_LABELS: Record<BeforeLaunchKind, string> = {
  run: "Run Another Configuration",
  build: "Build Project",
  buildModule: "Build Module",
  buildArtifacts: "Build Artifacts",
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
      return configs.find((c) => c.id === target)?.name ?? "Build Project";
    case "buildModule":
      return target ? `Build Module '${target}'` : "Build Module";
    case "buildArtifacts":
      return "Build Artifacts";
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
async function runToEnd(config: RunConfig, chain: readonly string[], show?: boolean): Promise<boolean> {
  let done!: (ok: boolean) => void;
  const exited = new Promise<boolean>((resolve) => (done = resolve));
  const session = await startRun(config, undefined, undefined, {
    chain,
    show,
    onExit: (code, stopped) => done(code === 0 && !stopped),
  });
  if (!session || session.status === "failed") return false;
  return exited;
}

async function runTask(
  task: BeforeLaunchTask,
  config: RunConfig,
  chain: readonly string[],
  show?: boolean,
): Promise<string | null> {
  const target = task.target ?? "";
  switch (task.kind) {
    case "dotnetBuild":
      return (await runToEnd(dotnetBuildConfig(config), chain, show)) ? null : "Build failed";
    case "build": {
      if (target) return buildCMake(target, show === true);
      return buildTask(BUILD_ACTION, { activate: false });
    }
    case "buildModule": {
      const error = moduleTaskError(config, target);
      if (error) return error;
      const root = useProject.getState().project?.root;
      if (!root) return "Build did not start";
      const relative = target.startsWith(root + "/") ? target.slice(root.length + 1) : target;
      if (!useBuildPresentation.getState().modules.has(relative)) return `Module '${target}' no longer exists`;
      const path = /^(?:[A-Za-z]:[\\/]|\/)/.test(target) ? target : `${root}/${target}`;
      return buildTask("build.buildModule", { target: path, activate: false, wait: true });
    }
    case "buildArtifacts":
      return buildTask("build.buildArtifacts", { activate: false, wait: true });
    case "run": {
      if (chain.includes(target)) return "The before launch tasks run in a cycle";
      const other = useRun.getState().configs.find((c) => c.id === target);
      if (!other) return `Configuration '${target}' no longer exists`;
      if (isCMakeBuild(other)) return buildCMake(other.id, show === true);
      return (await runToEnd(other, chain, show)) ? null : `'${other.name}' failed`;
    }
    case "tool": {
      const tool = workflowSettings().externalTools.find((t) => t.id === target);
      if (!tool) return `External tool '${target}' no longer exists`;
      const run = await externalToolConfig(tool);
      if (!run) return `'${tool.name}' was not run`;
      return (await runToEnd({ ...run, id: `${run.id}:before:${config.id}` }, chain, show))
        ? null
        : `'${tool.name}' failed`;
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
      return (await runToEnd(run, chain, show)) ? null : `'${target}' failed`;
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
export async function runBeforeLaunch(config: RunConfig, chain: readonly string[], show?: boolean): Promise<boolean> {
  for (const task of config.beforeLaunch ?? []) {
    let error: string | null;
    try {
      error = await runTask(task, config, chain, show);
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
