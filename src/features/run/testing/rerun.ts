/**
 * "Rerun Failed Tests": derives a run configuration that runs only the failed
 * tests of a previous run, using each framework's own filter syntax.
 */
import type { RunConfig } from "@/platform/ipc";
import { formatArgs } from "../configs";
import { goTestParts, withoutGoSelection } from "../goArguments";
import { frameworkFor } from "./index";
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

function jsArgs(config: RunConfig, paths: string[][]): string[] | null {
  const base = config.args;
  const files = unique(paths.map((p) => p[0]!).filter(Boolean));
  const names = unique(paths.filter((p) => p.length > 1).map((p) => p.slice(1).join(" ")));
  if (!files.length) return null;
  const { before, after } = splitDashDash(base);
  const rest = dropFlag(after ?? [], ["-t", "--testNamePattern"]);
  const filter = names.length ? ["-t", `^(?:${names.map(escapeRegExp).join("|")})$`] : [];
  // npm/pnpm/yarn/bun pass everything after `--` to the script; deno/npx take them directly.
  const needsDashDash = after !== null || /(^|\/)(npm|pnpm|yarn|bun)$/.test(config.command);
  return needsDashDash ? [...before, "--", ...rest, ...files, ...filter] : [...before, ...files, ...filter];
}

function pytestArgs(base: string[], paths: string[][]): string[] | null {
  const ids = unique(paths.map((p) => p.join("::")));
  if (!ids.length) return null;
  // Drop explicit test paths / -k expressions of the original run; keep options and `-m pytest` prefixes.
  const kept = dropFlag(base, ["-k"]).filter((a) => !/\.py(::|$)/.test(a) && !/^tests?\/?$/.test(a));
  return [...kept, ...ids];
}

function goArgs(base: string[], paths: string[][]): string[] | null {
  const pkgs = unique(paths.map((p) => p[0]!).filter(Boolean));
  if (!pkgs.length) return null;
  const tests = paths.filter((p) => p.length > 1);
  const parts = goTestParts(base);
  const top = unique(tests.map((p) => p[1]!));
  const pattern =
    tests.length === 1 && tests[0]!.length > 2
      ? tests[0]!
          .slice(1)
          .map((name) => `^${escapeRegExp(name)}$`)
          .join("/")
      : `^(${top.map(escapeRegExp).join("|")})$`;
  const run = top.length ? ["-run", pattern] : [];
  // A file-scoped run is reported under this synthetic import path; keep its file targets.
  const targets = pkgs.includes("command-line-arguments") ? parts.targets : pkgs;
  return ["test", ...withoutGoSelection(parts.flags), ...run, ...targets, ...parts.program];
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
export function rerunFailedConfig(config: RunConfig, paths: string[][]): RunConfig | null {
  const baseName = config.name.replace(/^Failed: /, "");
  return testsConfig(config, paths, `Failed: ${baseName}`);
}

/** Config running only the tests at `paths` (test tree paths), named `name`; null when unsupported. */
export function testsConfig(config: RunConfig, paths: string[][], name: string): RunConfig | null {
  if (!paths.length) return null;
  let args: string[] | null;
  switch (frameworkFor(config)) {
    case "cargo":
      args = cargoArgs(config.args, paths);
      break;
    case "js":
      args = jsArgs(config, paths);
      break;
    case "pytest":
      args = pytestArgs(config.args, paths);
      break;
    case "go":
      args = goArgs(config.args, paths);
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
                  pattern: args[args.indexOf("-run") + 1] ?? "",
                  toolArgs: formatArgs(withoutGoSelection(goTestParts(args).flags)),
                }
              : { module: config.params.module ?? "", useTags: config.params.useTags ?? "false" },
        }
      : {}),
  };
}
