/**
 * "Rerun Failed Tests": derives a run configuration that runs only the failed
 * tests of a previous run, using each framework's own filter syntax.
 */
import { selectPluginTests } from "@/workbench/contributions";
import { phpunitArgs, phpunitFilter } from "./phpunit";
import type { RunConfig } from "@/platform/ipc";
import { formatArgs, parseArgs } from "../configs";
import { appendScriptArgs } from "../scriptArgs";
import { djangoTestsOf } from "../djangoTypes";
import { goTestParts, withoutGoSelection } from "../goArguments";
import { frameworkFor } from "./index";
import { dotnetFilter } from "./dotnet";
import { nodeStatus, type TestNode, type TestResults } from "./results";

/** Paths of failed tests: failed leaves, plus failed suites without any failed children reported. */
export function failedTestPaths(results: Pick<TestResults, "roots">): string[][] {
  const out: string[][] = [];
  const visit = (n: TestNode) => {
    if (n.children.length === 0) {
      if (n.own === "failed") out.push(n.path);
      return;
    }
    const failedChildren = n.children.filter((c) => nodeStatus(c) === "failed");
    if (failedChildren.length === 0) {
      if (n.own === "failed") out.push(n.path);
      return;
    }
    failedChildren.forEach(visit);
  };
  results.roots.forEach(visit);
  return out;
}

export const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const unique = <T>(xs: T[]) => [...new Set(xs)];

/** Splits `args` at the first `--` (args for the test binary / runner). */
function splitDashDash(args: string[]): { before: string[]; after: string[] | null } {
  const i = args.indexOf("--");
  return i < 0 ? { before: args, after: null } : { before: args.slice(0, i), after: args.slice(i + 1) };
}

/** Removes `flag value` / `flag=value` pairs. */
function dropFlag(args: string[], flags: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (flags.includes(a)) {
      i++;
      continue;
    }
    if (flags.some((f) => a.startsWith(f + "="))) continue;
    out.push(a);
  }
  return out;
}

function cargoArgs(base: string[], paths: string[][]): string[] | null {
  // Paths are [suite (src/lib.rs, tests/x.rs or a nextest binary id), ...module::name parts].
  const names = unique(
    paths.filter((p) => !p[0]?.startsWith("Doc-tests ")).map((p) => (p.length > 1 ? p.slice(1) : p).join("::")),
  );
  if (!names.length) return null;
  const { before, after } = splitDashDash(base);
  const rest = (after ?? []).filter((a) => a !== "--exact");
  return [...before, "--", ...rest, ...names, "--exact"];
}

function dotnetArgs(base: string[], filter: string): string[] {
  const { before, after } = splitDashDash(base);
  return [...dropFlag(before, ["--filter"]), "--filter", filter, ...(after ? ["--", ...after] : [])];
}

function jsArgs(config: RunConfig, paths: string[][]): string[] | null {
  const base = config.args;
  const files = unique(paths.map((p) => p[0]!).filter(Boolean));
  const names = unique(paths.filter((p) => p.length > 1).map((p) => p.slice(1).join(" ")));
  if (!files.length) return null;
  const { before, after } = splitDashDash(base);
  const flags = ["-t", "--testNamePattern"];
  const args = after === null ? dropFlag(before, flags) : [...before, "--", ...dropFlag(after, flags)];
  const filter = names.length ? ["-t", `^(?:${names.map(escapeRegExp).join("|")})$`] : [];
  return appendScriptArgs(config.command, args, [...files, ...filter]);
}

function pytestArgs(base: string[], paths: string[][]): string[] | null {
  const ids = unique(paths.map((p) => p.join("::")));
  if (!ids.length) return null;
  // Drop explicit test paths / -k expressions of the original run; keep options and `-m pytest` prefixes.
  const kept = dropFlag(base, ["-k"]).filter((a) => !/\.py(::|$)/.test(a) && !/^tests?\/?$/.test(a));
  return [...kept, ...ids];
}

function goArgs(base: string[], paths: string[][], file?: string): string[] | null {
  const pkgs = unique(paths.map((p) => p[0]!).filter(Boolean));
  if (pkgs.length !== 1) return null;
  const parts = goTestParts(base);
  const targets = file ? [file] : pkgs.includes("command-line-arguments") ? parts.targets : pkgs;
  if (paths.some((path) => path.length === 1)) return ["test", ...parts.flags, ...targets, ...parts.program];
  const pattern = (selected: string[][]) =>
    unique(
      selected.map((path) =>
        path
          .slice(1)
          .map((name) => `^${escapeRegExp(name)}$`)
          .join("/"),
      ),
    ).join("|");
  const benchmarks = paths.filter((path) => path[1]?.startsWith("Benchmark"));
  const tests = paths.filter((path) => !path[1]?.startsWith("Benchmark"));
  return [
    "test",
    ...withoutGoSelection(parts.flags),
    "-run",
    tests.length ? pattern(tests) : "^$",
    ...(benchmarks.length ? ["-bench", pattern(benchmarks)] : []),
    ...targets,
    ...withoutGoSelection(parts.program),
  ];
}

function jvmArgs(config: RunConfig, paths: string[][]): string[] | null {
  const tests = paths
    .filter((p) => p.length >= 2)
    .map((p) => ({ cls: p[0]!, method: p[p.length - 1]!.replace(/\(\)$/, "") }));
  const classes = unique(paths.filter((p) => p.length === 1).map((p) => p[0]!));
  if (!tests.length && !classes.length) return null;
  if (config.kind === "maven" || /\bmvnw?\b/.test(config.command)) {
    const byClass = new Map<string, string[]>();
    for (const t of tests) byClass.set(t.cls, [...(byClass.get(t.cls) ?? []), t.method]);
    const specs = [
      ...[...byClass].map(([cls, ms]) => `${cls}#${unique(ms).join("+")}`),
      ...classes.filter((c) => !byClass.has(c)),
    ];
    return [...config.args.filter((a) => !a.startsWith("-Dtest=")), `-Dtest=${specs.join(",")}`];
  }
  const filters = [...unique(tests.map((t) => `${t.cls}.${t.method}`)), ...classes];
  return [...dropFlag(config.args, ["--tests"]), ...filters.flatMap((f) => ["--tests", f])];
}

/** Leaf test paths under the given nodes (a node without reported children stands for itself). */
export function leafTestPaths(nodes: readonly TestNode[]): string[][] {
  const out: string[][] = [];
  const seen = new Set<string>();
  const visit = (n: TestNode) => {
    if (n.children.length) return n.children.forEach(visit);
    const key = n.path.join("\u0000");
    if (seen.has(key)) return;
    seen.add(key);
    out.push(n.path);
  };
  nodes.forEach(visit);
  return out;
}

/** Config running only `paths` (failed test paths from the results tree), or null when unsupported. */
export function rerunFailedConfig(config: RunConfig, paths: string[][]): RunConfig | null | Promise<RunConfig | null> {
  const configs = rerunFailedConfigs(config, paths);
  const single = (configs: RunConfig[]) => (configs.length === 1 ? configs[0]! : null);
  return configs instanceof Promise ? configs.then(single) : single(configs);
}

export function rerunFailedConfigs(config: RunConfig, paths: string[][]): RunConfig[] | Promise<RunConfig[]> {
  const baseName = config.name.replace(/^Failed: /, "");
  return testsConfigs(config, paths, `Failed: ${baseName}`);
}

/** Go filters apply to every package in an invocation, so each package keeps its own selection. */
export function testsConfigs(config: RunConfig, paths: string[][], name: string): RunConfig[] | Promise<RunConfig[]> {
  if (!paths.length) return [];
  if (config.params?.framework === "plugin") {
    const selected = testsConfig(config, paths, name);
    const list = (config: RunConfig | null) => (config ? [config] : []);
    return selected instanceof Promise ? selected.then(list) : list(selected);
  }
  const groups = new Map<string, string[][]>();
  for (const path of paths) {
    const key = frameworkFor(config) === "go" ? (path[0] ?? "") : "";
    const group = groups.get(key) ?? [];
    group.push(path);
    groups.set(key, group);
  }
  return [...groups].flatMap(([pkg, selected]) => {
    const derived = builtinTestsConfig(config, selected, groups.size > 1 ? `${name} (${pkg})` : name);
    if (!derived) return [];
    return [{ ...derived, id: groups.size > 1 ? `context:tests:${config.id}:${pkg}` : derived.id }];
  });
}

/** Config running only the tests at `paths` (test tree paths), named `name`; null when unsupported. */
export function testsConfig(
  config: RunConfig,
  paths: string[][],
  name: string,
): RunConfig | null | Promise<RunConfig | null> {
  if (!paths.length) return null;
  if (config.params?.framework === "plugin") {
    return selectPluginTests(config.id, paths)
      .then((args) => (args === null ? null : { ...config, args, name, detected: true, env: { ...config.env } }))
      .catch(() => null);
  }
  return builtinTestsConfig(config, paths, name);
}

function builtinTestsConfig(config: RunConfig, paths: string[][], name: string): RunConfig | null {
  if (!paths.length) return null;
  let args: string[] | null;
  switch (frameworkFor(config)) {
    case "dotnet": {
      const filter = dotnetFilter(paths);
      if (!filter) return null;
      args = dotnetArgs(config.args, filter);
      if (config.kind === "dotnet-test") {
        return {
          ...config,
          args,
          name,
          detected: true,
          env: { ...config.env },
          params: {
            ...config.params,
            testMethods: JSON.stringify([...new Set(paths.map((p) => `${p[1]}.${p[2]}`))]),
            programArgs: formatArgs(dotnetArgs(parseArgs(config.params?.programArgs || ""), filter)),
          },
        };
      }
      break;
    }
    case "cargo":
      args = cargoArgs(config.args, paths);
      break;
    case "js":
      args = jsArgs(config, paths);
      break;
    case "pytest":
      args = pytestArgs(config.args, paths);
      break;
    case "unittest": {
      // Django: dotted labels (`polls.tests.QuestionTests.test_x`) in place of the run's own target.
      const tests = djangoTestsOf(config, unique(paths.map((p) => p.join("."))));
      if (!tests) return null;
      return { ...config, ...tests, name, detected: true, env: { ...config.env } };
    }
    case "phpunit":
      args = phpunitArgs(config.args, { filter: phpunitFilter(paths) });
      break;
    case "go":
      args = goArgs(config.args, paths, config.params?.scope === "file" ? config.params.target : undefined);
      break;
    case "jvm":
      args = jvmArgs(config, paths);
      break;
    default:
      args = null;
  }
  if (!args) return null;
  return {
    ...config,
    args,
    name,
    detected: true,
    env: { ...config.env },
    ...(frameworkFor(config) === "go" && config.params?.goKind
      ? {
          cwd: config.params.module || config.cwd,
          params:
            config.params.scope === "file"
              ? {
                  ...config.params,
                  pattern: args.includes("-run") ? args[args.indexOf("-run") + 1]! : "",
                  toolArgs: formatArgs(dropFlag(goTestParts(args).flags, ["-run", "-test.run"])),
                  programArgs: formatArgs(goTestParts(args).program.slice(1)),
                }
              : { module: config.params.module ?? "", useTags: config.params.useTags ?? "true" },
        }
      : {}),
  };
}
