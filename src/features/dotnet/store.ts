import { create } from "zustand";
import { executeAction } from "@/platform/actions";
import {
  dotnet,
  dotnetWorkspace,
  evaluateProject,
  dotnetTestArgs,
  jsonOutput,
  type DotnetWorkspace,
} from "@/platform/dotnet";
import { dirname, useProject } from "@/platform/project";
import type { RunConfig } from "@/platform/ipc";
import { tx } from "@/platform/i18n";

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
export function resetDotnet() {
  generation++;
  controller?.abort();
  useDotnet.setState(initial);
}
export const selectedProject = () =>
  useDotnet.getState().model.projects.find((p) => p.path === useDotnet.getState().selected);

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
  return task(async (signal) => {
    const model = await dotnetWorkspace(root, signal);
    const old = useDotnet.getState();
    const project = model.projects.find((p) => p.path === old.selected) ?? model.projects[0];
    return {
      model,
      selected: project?.path ?? "",
      configuration: "Debug",
      framework: project?.frameworks[0] ?? "",
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

export function buildDotnet(operation: "build" | "restore" | "clean") {
  const p = selectedProject();
  if (!p) return;
  const { framework, configuration } = useDotnet.getState();
  return task(async (signal) => {
    const output = await dotnet(
      [
        operation,
        p.path,
        ...(operation === "restore"
          ? [`-p:Configuration=${configuration}`]
          : ["--configuration", configuration, ...(framework ? ["--framework", framework] : [])]),
      ],
      dirname(p.path),
      signal,
    );
    const project = await evaluateProject(p.path, configuration, framework, signal);
    const model = useDotnet.getState().model;
    return {
      output,
      model: { ...model, projects: model.projects.map((item) => (item.path === p.path ? project : item)) },
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
export function discoverTests() {
  const p = selectedProject();
  if (!p) return;
  const s = useDotnet.getState();
  return task(async (signal) => {
    const output = await dotnet(
      dotnetTestArgs(p, s.framework, ["--list-tests"], s.configuration),
      dirname(p.path),
      signal,
    );
    return { output, tests: discoveredTests(output) };
  });
}
export function runTests(test?: string) {
  const p = selectedProject();
  if (!p) return;
  const s = useDotnet.getState();
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
      framework: s.framework,
      configuration: s.configuration,
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
