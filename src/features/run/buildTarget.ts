import type { GradleModel, RunConfig } from "@/platform/ipc";
import { cmakeBuildId } from "./cmake";
import { joinPath } from "./links";

export interface SelectedBuildTarget {
  /** CMake build configuration ID when the selected configuration builds through CMake. */
  cmake: string | null;
  /** Module directory or project file to build, or `null` for a whole-project build. */
  target: string | null;
  /** Selected configuration name for the toolbar hammer tooltip (`Build '<name>'`), or `null` for `Build Project`. */
  name: string | null;
}

const ROOT_MODULE = ".";

function resolvePath(raw: string, root: string | null): string | null {
  if (/^(?:[A-Za-z]:[\\/]|\/)/.test(raw)) return joinPath("/", raw);
  if (!root) return null;
  return raw ? joinPath(root, raw) : root;
}

/** Extracts a single directory selector from Maven `-pl` / `--projects` arguments. */
function mavenProjectListDir(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    let value: string | null = null;
    if (arg === "-pl" || arg === "--projects") {
      value = args[i + 1] ?? null;
    } else if (arg.startsWith("-pl=")) {
      value = arg.slice(4);
    } else if (arg.startsWith("--projects=")) {
      value = arg.slice(11);
    }
    if (!value) continue;
    const trimmed = value.trim();
    // Skip multi-module lists, exclusions (`!mod`), and artifactId selectors (`:artifact`).
    if (!trimmed || trimmed.includes(",") || trimmed.startsWith("!") || trimmed.startsWith(":")) return null;
    return trimmed;
  }
  return null;
}

/** Resolves a Gradle subproject directory from a qualified task like `:services:api:test`. */
function gradleTaskProjectDir(
  args: readonly string[],
  cwd: string | null,
  gradleModels: readonly GradleModel[],
): string | null {
  const normalizedCwd = (cwd ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  const scoped = gradleModels.filter((g) => g.dir.replace(/\\/g, "/").replace(/\/+$/, "") === normalizedCwd);
  const candidates = scoped.length ? scoped : gradleModels;
  for (const arg of args) {
    if (arg.startsWith("-")) continue;
    const match = /^(:[^:\s]+(?::[^:\s]+)*):[^:\s]+$/.exec(arg);
    if (!match) continue;
    const path = match[1]!;
    for (const model of candidates) {
      const project = model.projects.find((p) => p.path === path);
      if (project) return project.dir;
    }
  }
  return null;
}

function targetPathFor(config: RunConfig, root: string | null, gradleModels: readonly GradleModel[]): string | null {
  switch (config.kind) {
    case "application":
    case "spring-boot": {
      const raw = config.module ?? config.cwd;
      return raw != null ? resolvePath(raw, root) : null;
    }
    case "junit": {
      const paramModule = config.params?.module;
      const raw = config.module ?? (paramModule ? (paramModule === ROOT_MODULE ? "" : paramModule) : config.cwd);
      return raw != null ? resolvePath(raw, root) : null;
    }
    case "tomcat": {
      const raw = config.module ?? config.cwd;
      return raw != null ? resolvePath(raw, root) : null;
    }
    case "maven": {
      if (config.module != null) return resolvePath(config.module, root);
      const base = config.cwd ?? "";
      const pl = mavenProjectListDir(config.args);
      if (pl) {
        const basePath = resolvePath(base, root);
        return basePath ? joinPath(basePath, pl) : null;
      }
      return resolvePath(base, root);
    }
    case "gradle": {
      if (config.module != null) return resolvePath(config.module, root);
      const taskDir = gradleTaskProjectDir(config.args, config.cwd, gradleModels);
      if (taskDir != null) return resolvePath(taskDir, root);
      return resolvePath(config.cwd ?? "", root);
    }
    case "dotnet":
    case "dotnet-test": {
      const project = config.params?.project?.trim();
      const raw = project || config.module || config.cwd || "";
      return resolvePath(raw, root);
    }
    case "cargo": {
      return resolvePath(config.module ?? config.cwd ?? "", root);
    }
    case "go": {
      return resolvePath(config.module ?? config.params?.module ?? config.cwd ?? "", root);
    }
    default:
      return null;
  }
}

/**
 * Resolves what the main toolbar hammer builds for the currently selected run configuration:
 * a CMake target, the selected configuration's module/project directory, or a fallback project build.
 */
export function selectedBuildTarget(
  selected: RunConfig | undefined,
  configs: readonly RunConfig[],
  projectRoot: string | null,
  gradleModels: readonly GradleModel[] = [],
): SelectedBuildTarget {
  if (!selected) {
    const fallbackCmake = configs.find((c) => c.kind === "cmake" && c.args[0] === "--build");
    return { cmake: cmakeBuildId(fallbackCmake, configs), target: null, name: null };
  }
  const cmake = cmakeBuildId(selected, configs);
  if (cmake) return { cmake, target: null, name: selected.name };
  const target = targetPathFor(selected, projectRoot, gradleModels);
  if (target) return { cmake: null, target, name: selected.name };
  return { cmake: null, target: null, name: null };
}
