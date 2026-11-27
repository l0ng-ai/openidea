import { create } from "zustand";
import { executeAction } from "@/platform/actions";
import {
  dotnet,
  dotnetWorkspace,
  evaluateProject,
  dotnetTestArgs,
  jsonOutput,
  type DotnetProject,
  type DotnetWorkspace,
} from "@/platform/dotnet";
import { dirname, useProject } from "@/platform/project";
import type { RunConfig } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { maybeEditorService, projectViewSelection } from "@/workbench/contributions";
import { contextDotnetTarget, isDotnetProjectPath, isDotnetSolutionPath } from "./target";

export interface Package {
  id: string;
  version: string;
  latest?: string;
  transitive?: boolean;
}
interface State {
  model: DotnetWorkspace;
  selected: string;
  framework: string;
  configuration: string;
  busy: boolean;
  error: string;
  output: string;
  query: string;
  packages: Package[];
  found: Package[];
  tests: string[];
}
const initial: State = {
  model: { projects: [], solutions: [] },
  selected: "",
  framework: "",
  configuration: "Debug",
  busy: false,
  error: "",
  output: "",
  query: "",
  packages: [],
  found: [],
  tests: [],
};
export const useDotnet = create<State>(() => initial);
let controller: AbortController | undefined;
let generation = 0;
/** The workspace scan a context action starts when the model was never loaded; concurrent calls share it (#5635). */
let contextScan: Promise<unknown> | undefined;
export function resetDotnet() {
  generation++;
  controller?.abort();
  contextScan = undefined;
  useDotnet.setState(initial);
}
export const selectedProject = () =>
  useDotnet.getState().model.projects.find((p) => p.path === useDotnet.getState().selected);

/**
 * The .NET project or solution of the current context (#5635): an explicit file (the
 * Project view context menu), else the Project view's selected `.csproj` / `.sln`, else
 * the project of the active editor's file, else the solution — or, in a workspace with
 * no solution, the project selected in the NuGet window.
 */
async function contextTarget(arg?: unknown): Promise<string | null> {
  if (typeof arg === "string" && arg) return arg;
  const resolve = () => {
    return (
      contextDotnetTarget({
        selected: projectViewSelection(),
        editorFile: maybeEditorService()?.activePath() ?? null,
        model: useDotnet.getState().model,
      }) ??
      (useDotnet.getState().selected || null)
    );
  };
  // A selected `.csproj` / `.sln` resolves without the model. Otherwise a fresh
  // session may never have scanned the workspace yet (#5635): load it once
  // instead of silently doing nothing. A workspace without .NET stays a no-op
  // after that single scan, and a selected file never triggers one.
  const target = resolve();
  if (target) return target;
  const { model } = useDotnet.getState();
  if (model.projects.length || model.solutions.length || !useProject.getState().project?.root) return null;
  await ensureDotnetModel();
  return resolve();
}

/**
 * Loads the workspace model unless it is loaded: the NuGet window on mount and the context
 * actions share one scan (#5635), so opening the window while an action resolves its target
 * does not scan twice.
 */
export async function ensureDotnetModel(): Promise<void> {
  const { model } = useDotnet.getState();
  if (model.projects.length || model.solutions.length || !useProject.getState().project?.root) return;
  const scan = (contextScan ??= Promise.resolve(reloadDotnet()));
  try {
    await scan;
  } finally {
    // A failed scan must not disable the context actions for the rest of the
    // session (#5635): drop it so the next caller starts a new one. A scan
    // that completed finds the model loaded — or, in a workspace without
    // .NET, no error — and keeps its single-scan no-op.
    if (contextScan === scan) {
      const { model, error } = useDotnet.getState();
      if (error && !model.projects.length && !model.solutions.length) contextScan = undefined;
    }
  }
}

/** The context's target as an evaluated project: a solution has no single project, so the selected one stands in. */
async function contextProject(): Promise<DotnetProject | null> {
  const target = await contextTarget();
  const s = useDotnet.getState();
  const path = target && !isDotnetSolutionPath(target) ? target : s.selected;
  const known = s.model.projects.find((p) => p.path === path);
  if (known || !path) return known ?? null;
  return isDotnetProjectPath(path) ? evaluateProject(path, s.configuration, "") : null;
}

async function task(work: (signal: AbortSignal) => Promise<Partial<State>>) {
  controller?.abort();
  const current = ++generation;
  const abort = new AbortController();
  controller = abort;
  useDotnet.setState({ busy: true, error: "" });
  try {
    const patch = await work(abort.signal);
    if (current === generation && !abort.signal.aborted) useDotnet.setState(patch);
  } catch (e) {
    if (current === generation && !abort.signal.aborted) useDotnet.setState({ error: String(e) });
  } finally {
    if (current === generation) {
      controller = undefined;
      useDotnet.setState({ busy: false });
    }
  }
}
export function cancelDotnet() {
  controller?.abort();
}

export function reloadDotnet() {
  const root = useProject.getState().project?.root;
  if (!root) return;
  const old = useDotnet.getState();
  return task(async (signal) => {
    const model = await dotnetWorkspace(root, signal);
    let project = model.projects.find((p) => p.path === old.selected) ?? model.projects[0];
    const sameProject = project?.path === old.selected;
    const configurations = project?.configurations ?? [];
    const defaultConfiguration = configurations.includes(initial.configuration)
      ? initial.configuration
      : (configurations[0] ?? initial.configuration);
    const configuration =
      sameProject && configurations.includes(old.configuration) ? old.configuration : defaultConfiguration;

    // The workspace scan evaluates Debug and the first framework for each project.
    if (project && configuration !== initial.configuration)
      project = await evaluateProject(project.path, configuration, "", signal);
    const framework =
      sameProject && project?.frameworks.includes(old.framework) ? old.framework : (project?.frameworks[0] ?? "");
    if (project && framework && framework !== project.frameworks[0])
      project = await evaluateProject(project.path, configuration, framework, signal);

    return {
      model: { ...model, projects: model.projects.map((item) => (item.path === project?.path ? project : item)) },
      selected: project?.path ?? "",
      configuration,
      framework,
      packages: [],
      found: [],
      tests: [],
    };
  });
}
export function selectDotnet(path: string, configuration?: string, framework?: string) {
  const state = useDotnet.getState();
  return task(async (signal) => {
    const project = await evaluateProject(path, configuration ?? state.configuration, framework ?? "", signal);
    return {
      selected: path,
      configuration: configuration ?? state.configuration,
      framework: framework ?? project.frameworks[0] ?? "",
      model: {
        ...state.model,
        projects: state.model.projects.some((p) => p.path === path)
          ? state.model.projects.map((p) => (p.path === path ? project : p))
          : [...state.model.projects, project],
        errors: state.model.errors?.filter((error) => !error.startsWith(`${path}:`)),
      },
      packages: [],
      found: [],
      tests: [],
    };
  });
}

export async function buildDotnet(operation: "build" | "restore" | "clean", arg?: unknown) {
  const target = await contextTarget(arg);
  if (!target) return;
  // A solution builds as a whole: `dotnet` takes the `.sln` directly, there is no
  // project to re-evaluate afterwards.
  if (isDotnetSolutionPath(target)) {
    const { configuration } = useDotnet.getState();
    return task(async (signal) => ({
      output: await dotnet(
        [
          operation,
          target,
          ...(operation === "restore" ? [`-p:Configuration=${configuration}`] : ["--configuration", configuration]),
        ],
        dirname(target),
        signal,
      ),
    }));
  }
  const selected = selectedProject();
  const { framework, configuration } = useDotnet.getState();
  // The selected project keeps its chosen configuration and framework; another
  // project builds with its own defaults.
  if (selected?.path !== target)
    return task(async (signal) => {
      const output = await dotnet([operation, target, "--configuration", "Debug"], dirname(target), signal);
      const model = useDotnet.getState().model;
      if (!model.projects.some((p) => p.path === target)) return { output };
      const project = await evaluateProject(target, "Debug", "", signal);
      return {
        output,
        model: { ...model, projects: model.projects.map((item) => (item.path === target ? project : item)) },
      };
    });
  return task(async (signal) => {
    const output = await dotnet(
      [
        operation,
        target,
        ...(operation === "restore"
          ? [`-p:Configuration=${configuration}`]
          : ["--configuration", configuration, ...(framework ? ["--framework", framework] : [])]),
      ],
      dirname(target),
      signal,
    );
    const project = await evaluateProject(target, configuration, framework, signal);
    const model = useDotnet.getState().model;
    return {
      output,
      model: { ...model, projects: model.projects.map((item) => (item.path === target ? project : item)) },
    };
  });
}

interface PackageJson {
  id: string;
  resolvedVersion?: string;
  requestedVersion?: string;
  latestVersion?: string;
}
interface PackagesJson {
  projects?: Array<{ frameworks?: Array<{ topLevelPackages?: PackageJson[]; transitivePackages?: PackageJson[] }> }>;
}
export function packageList(data: PackagesJson): Package[] {
  const result = new Map<string, Package>();
  for (const p of data.projects ?? [])
    for (const f of p.frameworks ?? []) {
      for (const [key, transitive] of [
        ["topLevelPackages", false],
        ["transitivePackages", true],
      ] as const)
        for (const pkg of f[key] ?? [])
          result.set(`${pkg.id}:${pkg.resolvedVersion}`, {
            id: pkg.id,
            version: pkg.resolvedVersion ?? pkg.requestedVersion ?? "",
            latest: pkg.latestVersion,
            transitive: transitive && result.get(`${pkg.id}:${pkg.resolvedVersion}`)?.transitive !== false,
          });
    }
  return [...result.values()];
}
export function listPackages() {
  const p = selectedProject();
  if (!p) return;
  return task(async (signal) => ({
    packages: packageList(
      jsonOutput(
        await dotnet(["list", p.path, "package", "--include-transitive", "--format", "json"], dirname(p.path), signal),
      ),
    ),
  }));
}
export function searchPackages(query: string, exact = false) {
  const p = selectedProject();
  if (!p || !query.trim()) return;
  return task(async (signal) => {
    const result = jsonOutput<{
      problems?: Array<{ text?: string }>;
      searchResult?: Array<{ packages?: Array<{ id: string; latestVersion?: string; version?: string }> }>;
    }>(
      await dotnet(
        ["package", "search", query.trim(), "--format", "json", "--take", "30", ...(exact ? ["--exact-match"] : [])],
        dirname(p.path),
        signal,
      ),
    );
    const found = (result.searchResult ?? []).flatMap((source) =>
      (source.packages ?? []).map((pkg) => ({ id: pkg.id, version: pkg.latestVersion ?? pkg.version ?? "" })),
    );
    if (result.problems?.length) throw new Error(JSON.stringify(result.problems));
    if (exact) found.reverse();
    return { found };
  });
}
export function changePackage(id: string, version: string | null) {
  const p = selectedProject();
  if (!p || !id) return;
  return task(async (signal) => {
    if (id === "Microsoft.Testing.Extensions.TrxReport" && version === "") {
      await dotnet(["restore", p.path], dirname(p.path), signal);
      const restored = await evaluateProject(
        p.path,
        useDotnet.getState().configuration,
        useDotnet.getState().framework,
        signal,
      );
      if (!restored.platformVersion)
        throw new Error(tx("Microsoft.Testing.Platform was not found in the restored project."));
      version = restored.platformVersion;
    }
    const output = await dotnet(
      version === null
        ? ["remove", p.path, "package", id]
        : ["add", p.path, "package", id, ...(version ? ["--version", version] : [])],
      dirname(p.path),
      signal,
    );
    if (version === null) await dotnet(["restore", p.path], dirname(p.path), signal);
    const project = await evaluateProject(
      p.path,
      useDotnet.getState().configuration,
      useDotnet.getState().framework,
      signal,
    );
    const packages = packageList(
      jsonOutput(
        await dotnet(["list", p.path, "package", "--include-transitive", "--format", "json"], dirname(p.path), signal),
      ),
    );
    return {
      output,
      packages,
      model: {
        ...useDotnet.getState().model,
        projects: useDotnet.getState().model.projects.map((x) => (x.path === p.path ? project : x)),
      },
    };
  });
}
export function discoveredTests(output: string): string[] {
  const lines = output.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "").split(/\r?\n/);
  const tests = new Set<string>();
  let listing = false;
  for (const line of lines) {
    if (/following Tests are available|Discovered tests:|Discovered \d+ tests? in assembly/i.test(line)) {
      listing = true;
      continue;
    }
    if (!listing) continue;
    const name = line.trim();
    if (
      !name ||
      /^(?:Process finished|Tests succeeded:|Tests failed:|Test run summary:|Discovered \d+ tests?\.|Total:)/.test(name)
    ) {
      listing = false;
      continue;
    }
    if (!/^(?:at |\[|.*\.dll\b)/.test(name)) tests.add(name);
  }
  return [...tests];
}
export async function discoverTests() {
  const p = await contextProject();
  if (!p) return;
  const s = useDotnet.getState();
  const own = p.path === s.selected;
  const framework = own ? s.framework : "";
  const configuration = own ? s.configuration : "Debug";
  return task(async (signal) => {
    const output = await dotnet(dotnetTestArgs(p, framework, ["--list-tests"], configuration), dirname(p.path), signal);
    return { output, tests: discoveredTests(output) };
  });
}
export async function runTests(test?: string) {
  const p = await contextProject();
  if (!p) return;
  const s = useDotnet.getState();
  const own = p.path === s.selected;
  const framework = own ? s.framework : "";
  const configuration = own ? s.configuration : "Debug";
  const method = test?.replace(/\(.*$/, "").trim();
  const config: RunConfig = {
    id: `dotnet:${p.path}:tests`,
    name: test ?? p.name,
    kind: "dotnet-test",
    command: "dotnet",
    args: [],
    cwd: dirname(p.path),
    env: {},
    detected: true,
    isTest: true,
    debugAdapter: null,
    params: {
      project: p.path,
      framework,
      configuration,
      runner: p.runner,
      adapter: p.adapter,
      programArgs: "",
      ...(method ? { testMethods: JSON.stringify([method]) } : {}),
    },
  };
  return executeAction("run.runConfig", config);
}
export function installTrx() {
  return changePackage("Microsoft.Testing.Extensions.TrxReport", "");
}
