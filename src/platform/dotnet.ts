import { Channel } from "@tauri-apps/api/core";
import { call, commands, ideEventsReady, onIdeEvent, type OutputChunk, type RunConfig, type RunId } from "./ipc";
import { dirname, useProject } from "./project";
import { tx } from "./i18n";

export type DotnetRunner = "vstest" | "mtp" | "mtp-legacy";
export interface DotnetProject {
  path: string;
  name: string;
  frameworks: string[];
  configurations: string[];
  references: string[];
  packages: Array<{ id: string; version: string }>;
  test: boolean;
  runner: DotnetRunner;
  adapter: string;
  trx: boolean;
  platformVersion?: string;
}
export interface DotnetSolution {
  path: string;
  projects: string[];
}
export interface DotnetWorkspace {
  projects: DotnetProject[];
  solutions: DotnetSolution[];
  errors?: string[];
}

export function dotnetConfig(args: string[], cwd: string): RunConfig {
  return {
    id: `dotnet-task:${crypto.randomUUID()}`,
    name: `dotnet ${args[0]}`,
    kind: "shell",
    command: "dotnet",
    args,
    cwd,
    env: { DOTNET_CLI_UI_LANGUAGE: "en" },
    detected: true,
    isTest: false,
    debugAdapter: null,
    emulateTerminal: false,
  };
}

/** Uses the same trusted, remote-aware process host and cancellation as the Run window. */
export async function dotnet(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  await ideEventsReady();
  let id: RunId | undefined;
  let output = "";
  let overflow = false;
  const exits = new Map<RunId, number | null>();
  let finish!: (code: number | null) => void;
  const exited = new Promise<number | null>((resolve) => {
    finish = resolve;
  });
  const off = onIdeEvent("runExited", (event) => {
    if (id === undefined) exits.set(event.run, event.code);
    else if (event.run === id) finish(event.code);
  });
  const stop = () => {
    if (id !== undefined) void call(commands.runStop(id)).catch(() => {});
  };
  const channel = new Channel<OutputChunk>();
  channel.onmessage = (chunk) => {
    if (output.length + chunk.text.length > 8_000_000) {
      overflow = true;
      stop();
    } else output += chunk.text;
  };
  signal?.addEventListener("abort", stop);
  try {
    const info = await call(commands.runStart(dotnetConfig(args, cwd), channel, null));
    id = info.id;
    if (signal?.aborted || overflow) stop();
    if (exits.has(id)) finish(exits.get(id)!);
    const code = await exited;
    signal?.throwIfAborted();
    if (overflow) throw new Error(tx(".NET output exceeded the size limit"));
    if (code !== 0) throw new Error(output.trim() || tx`dotnet exited with code ${code}`);
    return output;
  } finally {
    off();
    signal?.removeEventListener("abort", stop);
  }
}

export function jsonOutput<T = Record<string, unknown>>(text: string): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return JSON.parse(text.slice(start, end + 1));
}

function absolute(base: string, relative: string): string {
  const path = relative.replace(/\\/g, "/");
  if (/^(?:[A-Za-z]:\/|\/)/.test(path)) return path;
  const parts = base.replace(/\\/g, "/").split("/");
  for (const part of path.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

export function solutionPaths(text: string, xml: boolean, dir: string): string[] {
  const names = xml
    ? Array.from(new DOMParser().parseFromString(text, "application/xml").getElementsByTagName("Project")).map(
        (p) => p.getAttribute("Path") || "",
      )
    : Array.from(text.matchAll(/^Project\([^\r\n]+?=\s*"[^"]*",\s*"([^"]+)"/gm), (m) => m[1]!);
  return [...new Set(names.filter((p) => /\.(?:cs|fs|vb)proj$/i.test(p)).map((p) => absolute(dir, p)))];
}

export function globalRunner(text: string): DotnetRunner {
  const json = JSON.parse(
    text.replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|,\s*(?=[}\]])/g, (token) =>
      token.startsWith('"') ? token : "",
    ),
  );
  return json.test?.runner === "Microsoft.Testing.Platform" ? "mtp" : "vstest";
}

export async function runnerMode(dir: string): Promise<DotnetRunner> {
  for (let current = dir; current;) {
    try {
      return globalRunner(await call(commands.fsReadText(`${current}/global.json`)));
    } catch {
      /* No global.json at this level. */
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return "vstest";
}

export async function evaluateProject(
  path: string,
  configuration = "Debug",
  framework = "",
  signal?: AbortSignal,
): Promise<DotnetProject> {
  const data = jsonOutput<{ Properties: Record<string, string>; Items: Record<string, Array<Record<string, string>>> }>(
    await dotnet(
      [
        "msbuild",
        path,
        "-nologo",
        `-p:Configuration=${configuration}`,
        ...(framework ? [`-p:TargetFramework=${framework}`] : []),
        "-getProperty:MSBuildProjectName,TargetFramework,TargetFrameworks,Configurations,IsTestProject,IsTestingPlatformApplication,TestingPlatformDotnetTestSupport,EnableMSTestRunner,ProjectAssetsFile",
        "-getItem:ProjectReference,PackageReference",
      ],
      dirname(path),
      signal,
    ),
  );
  const p = data.Properties ?? {};
  if (!framework && p.TargetFrameworks)
    return evaluateProject(path, configuration, p.TargetFrameworks.split(";")[0], signal);
  const packages = (data.Items?.PackageReference ?? []).map((x) => ({
    id: String(x.Identity),
    version: String(x.Version ?? ""),
  }));
  const mode = await runnerMode(dirname(path));
  const mtp =
    [p.IsTestingPlatformApplication, p.TestingPlatformDotnetTestSupport, p.EnableMSTestRunner].includes("true") ||
    packages.some((x) => /xunit\.v3\.mtp/i.test(x.id));
  let trx = packages.some((x) => /^Microsoft.Testing.Extensions.TrxReport$/i.test(x.id));
  let platformVersion: string | undefined;
  if (p.ProjectAssetsFile) {
    try {
      const assets = JSON.parse(await call(commands.fsReadText(p.ProjectAssetsFile)));
      const libraries = Object.keys(assets.libraries ?? {});
      trx ||= libraries.some((key) => /^Microsoft.Testing.Extensions.TrxReport\//i.test(key));
      platformVersion = libraries.find((key) => /^Microsoft.Testing.Platform\//i.test(key))?.split("/")[1];
    } catch {
      /* Not restored yet. */
    }
  }
  return {
    path,
    name: p.MSBuildProjectName || path.split("/").at(-1) || path,
    frameworks: (p.TargetFrameworks || p.TargetFramework || "").split(";").filter(Boolean),
    configurations: (p.Configurations || "Debug;Release").split(";"),
    references: (data.Items?.ProjectReference ?? []).map((x) => absolute(dirname(path), x.Identity!)),
    packages,
    test:
      p.IsTestProject === "true" ||
      mtp ||
      (p.IsTestProject !== "false" &&
        packages.some((x) => /^(?:Microsoft.NET.Test.Sdk|MSTest|NUnit|xunit(?:\.v3(?:\.mtp-v[12])?)?)$/i.test(x.id))),
    runner: mode === "mtp" ? mode : mtp ? "mtp-legacy" : "vstest",
    adapter: packages.some((x) => /^xunit/i.test(x.id))
      ? "xunit"
      : packages.some((x) => /^nunit/i.test(x.id))
        ? "nunit"
        : "mstest",
    trx,
    platformVersion,
  };
}

export async function dotnetWorkspace(root: string, signal?: AbortSignal): Promise<DotnetWorkspace> {
  const paths = new Set<string>();
  const solutions: DotnetSolution[] = [];
  const queue = [root];
  while (queue.length) {
    signal?.throwIfAborted();
    const dir = queue.shift()!;
    for (const entry of await call(commands.fsReadDir(dir))) {
      if (
        entry.kind === "dir" &&
        !entry.excluded &&
        !/^(?:\.|bin$|obj$|node_modules$|target$|packages$)/.test(entry.name)
      )
        queue.push(entry.path);
      else if (/\.(?:cs|fs|vb)proj$/i.test(entry.name)) paths.add(entry.path);
      else if (/\.slnx?$/i.test(entry.name)) {
        const projects = solutionPaths(
          await call(commands.fsReadText(entry.path)),
          entry.name.endsWith(".slnx"),
          dirname(entry.path),
        );
        solutions.push({ path: entry.path, projects });
        projects.forEach((p) => paths.add(p));
      }
    }
  }
  const projects: DotnetProject[] = [];
  const errors: string[] = [];
  for (const path of paths) {
    try {
      const project = await evaluateProject(path, "Debug", "", signal);
      projects.push(project);
      project.references.forEach((reference) => paths.add(reference));
    } catch (e) {
      signal?.throwIfAborted();
      errors.push(`${path}: ${String(e)}`);
    }
  }
  return { projects, solutions, errors };
}

export function dotnetTestArgs(
  project: DotnetProject,
  framework: string,
  extra: string[] = [],
  configuration = "Debug",
): string[] {
  return [
    "test",
    ...(project.runner === "mtp" ? ["--project", project.path] : [project.path]),
    "--configuration",
    configuration,
    ...(framework ? ["--framework", framework] : []),
    ...(project.runner === "mtp-legacy"
      ? [
          "-p:TestingPlatformCaptureOutput=false",
          "-p:TestingPlatformDotnetTestSupport=true",
          ...(extra.length ? ["--"] : []),
        ]
      : []),
    ...extra,
  ];
}

export async function prepareDotnetTest(config: RunConfig): Promise<RunConfig> {
  const root = useProject.getState().project?.root;
  if (!root || !config.params?.project) return config;
  let project = await evaluateProject(
    absolute(root, config.params.project),
    config.params.configuration,
    config.params.framework,
  );
  if (project.runner !== "vstest" && !project.platformVersion) {
    await dotnet(["restore", project.path], dirname(project.path));
    project = await evaluateProject(project.path, config.params.configuration, config.params.framework);
  }
  return {
    ...config,
    params: { ...config.params, runner: project.runner, adapter: project.adapter, trx: String(project.trx) },
  };
}
