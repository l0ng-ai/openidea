/**
 * Tree model and run configurations of the sbt tool window (pure): each build's root
 * project with its Tasks, the build's sbt run configurations and its other projects.
 */
import type { RunConfig, SbtBuild, SbtProject } from "@/platform/ipc";
import { normalizeDir } from "./model";

/** The tasks listed for every project. */
export const SBT_TASKS = ["compile", "test", "run", "clean", "package", "doc", "update", "publishLocal"];

export type SbtNode =
  | { kind: "project"; key: string; build: SbtBuild; project: SbtProject }
  | { kind: "tasks"; key: string; build: SbtBuild; project: SbtProject }
  | { kind: "task"; key: string; build: SbtBuild; project: SbtProject; task: string }
  | { kind: "runConfigs"; key: string; configs: RunConfig[] }
  | { kind: "runConfig"; key: string; config: RunConfig };

const projectKey = (build: SbtBuild, project: SbtProject) => `sbt:${JSON.stringify([build.dir, project.id])}`;

export function sbtRoots(builds: readonly SbtBuild[]): SbtNode[] {
  return builds.flatMap((build) => {
    const root = build.projects.find((p) => p.root);
    return root ? [{ kind: "project" as const, key: projectKey(build, root), build, project: root }] : [];
  });
}

/** The sbt run configurations started in `build`'s folder. */
export function sbtRunConfigs(build: SbtBuild, configs: readonly RunConfig[]): RunConfig[] {
  return configs.filter((c) => c.kind === "sbt" && normalizeDir(c.cwd) === normalizeDir(build.dir));
}

export function sbtChildren(node: SbtNode, configs: readonly RunConfig[]): SbtNode[] | undefined {
  switch (node.kind) {
    case "project": {
      const { build, project } = node;
      const key = projectKey(build, project);
      const out: SbtNode[] = [{ kind: "tasks", key: `${key}:tasks`, build, project }];
      if (!project.root) return out;
      const runs = sbtRunConfigs(build, configs);
      if (runs.length) out.push({ kind: "runConfigs", key: `${key}:runs`, configs: runs });
      for (const p of build.projects)
        if (!p.root) out.push({ kind: "project", key: projectKey(build, p), build, project: p });
      return out;
    }
    case "tasks":
      return SBT_TASKS.map((task) => ({ ...node, kind: "task", key: `${node.key}:${task}`, task }));
    case "runConfigs":
      return node.configs.map((config) => ({ kind: "runConfig", key: `${node.key}:${config.id}`, config }));
    default:
      return undefined;
  }
}

/** The command line argument running `task` in `project`: unscoped on the root project. */
export function sbtTaskArg(project: SbtProject, task: string): string {
  return project.root ? task : `${project.id}/${task}`;
}

/** A configuration running `tasks` of `project` in one sbt invocation. */
export function sbtTaskConfig(build: SbtBuild, project: SbtProject, tasks: readonly string[]): RunConfig {
  return {
    id: `sbt:task:${JSON.stringify([build.dir, project.id])}:${tasks.join(" ")}`,
    name: `${project.id} [${tasks.join(",")}]`,
    kind: "sbt",
    command: build.command,
    args: tasks.map((t) => sbtTaskArg(project, t)),
    cwd: build.dir || null,
    env: {},
    detected: false,
    isTest: tasks.some((t) => t === "test"),
    debugAdapter: null,
  };
}

/** The configuration selected nodes start: tasks of one project together, or a saved configuration. */
export function sbtNodeConfig(nodes: readonly SbtNode[]): RunConfig | null {
  const first = nodes[0];
  if (first?.kind === "runConfig") return first.config;
  if (first?.kind !== "task") return null;
  const same = nodes.filter(
    (n): n is Extract<SbtNode, { kind: "task" }> =>
      n.kind === "task" && n.build.dir === first.build.dir && n.project.id === first.project.id,
  );
  return sbtTaskConfig(
    first.build,
    first.project,
    same.map((n) => n.task),
  );
}

export function sbtLabel(node: SbtNode): string {
  switch (node.kind) {
    case "project":
      return node.project.id;
    case "tasks":
      return "Tasks";
    case "task":
      return node.task;
    case "runConfigs":
      return "Run Configurations";
    case "runConfig":
      return node.config.name;
  }
}

export function sbtIcon(node: SbtNode): string {
  switch (node.kind) {
    case "project":
      return "file-scala";
    case "tasks":
    case "runConfigs":
      return "folder";
    case "task":
    case "runConfig":
      return "build-task";
  }
}
