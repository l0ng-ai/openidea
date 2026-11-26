/**
 * Run Anything completion for `npx` / `pnpm exec` / `bunx` / `yarn` lines: the
 * executables installed in `node_modules/.bin` (the current file's package
 * first, its direct dependencies' before the rest), run through the package
 * manager in the package folder like npm script entries. Reads the disk only.
 */
import { executeAction } from "@/platform/actions";
import { formatArgs, parseArgs } from "@/platform/commandLine";
import { call, commands, type RunConfig } from "@/platform/ipc";
import { usePlatform } from "@/platform/platformInfo";
import { useProject } from "@/platform/project";
import { maybeEditorService, type RunAnythingItem, type RunAnythingProvider } from "@/workbench/contributions";
import { useRun } from "./store";

interface Runner {
  prefix: string;
  command: string;
  args: string[];
}

const RUNNERS: Record<string, Runner> = {
  npx: { prefix: "npx", command: "npx", args: [] },
  pnpm: { prefix: "pnpm exec", command: "pnpm", args: ["exec"] },
  bunx: { prefix: "bunx", command: "bunx", args: [] },
  yarn: { prefix: "yarn", command: "yarn", args: [] },
};

/** `npx prisma migrate dev` → the runner, the executable typed so far and the rest. */
export function parseExecLine(line: string): { runner: Runner; name: string; rest: string } | null {
  const m = /^(npx|pnpm\s+exec|bunx|yarn)(?:\s+(\S+))?(?:\s+([\s\S]*))?$/.exec(line.trim());
  if (!m) return null;
  return { runner: RUNNERS[m[1]!.split(/\s/)[0]!]!, name: m[2] ?? "", rest: (m[3] ?? "").trim() };
}

export interface PackageBins {
  /** Relative to the project root, `""` for the root package. */
  dir: string;
  label: string;
  /** Installed executables; `from` is the direct dependency that provides one. */
  bins: { name: string; from?: string }[];
}

type PackageJson = Record<string, unknown>;

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Executable names a package declares (`bin` as a string is named after the package). */
export function declaredBins(dep: string, pkg: PackageJson): string[] {
  if (typeof pkg.bin === "string") return [dep.replace(/^@[^/]+\//, "")];
  return Object.keys(record(pkg.bin));
}

export function directDependencies(pkg: PackageJson): string[] {
  const names = ["dependencies", "devDependencies", "optionalDependencies"].flatMap((k) => Object.keys(record(pkg[k])));
  return [...new Set(names)];
}

/** `.bin` entry names without the Windows shims' extensions (`eslint.cmd`, `eslint.ps1`). */
export function binEntryNames(names: readonly string[]): string[] {
  return [...new Set(names.map((n) => n.replace(/\.(?:cmd|ps1|exe|bat)$/i, "")))];
}

const slash = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
const join = (root: string, rel: string) => (rel ? `${root}/${rel}` : root);

/** `a/b` → `["a/b", "a", ""]`. */
export function ancestorDirs(rel: string): string[] {
  const out = [rel];
  for (let d = rel; d;) {
    d = d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "";
    out.push(d);
  }
  return out;
}

async function readJson(path: string): Promise<PackageJson | null> {
  try {
    const v: unknown = JSON.parse(await call(commands.fsReadText(path)));
    return v && typeof v === "object" ? (v as PackageJson) : null;
  } catch {
    return null;
  }
}

async function readBinDir(dir: string): Promise<string[]> {
  const entries = await call(commands.fsReadDir(`${dir}/node_modules/.bin`)).catch(() => []);
  return binEntryNames(entries.filter((e) => e.kind !== "dir").map((e) => e.name));
}

/** The first non-null result, in order (all looked up at once). */
async function firstOf<T>(lookups: Promise<T | null>[]): Promise<T | null> {
  return (await Promise.all(lookups)).find((v) => v !== null) ?? null;
}

async function loadPackage(root: string, dir: string): Promise<PackageBins | null> {
  const pkg = await readJson(`${join(root, dir)}/package.json`);
  if (!pkg) return null;
  // Like `npm exec`: every `node_modules/.bin` from the package up to the project root.
  const chain = ancestorDirs(dir).map((d) => join(root, d));
  const installed = binEntryNames((await Promise.all(chain.map(readBinDir))).flat());
  const owners = new Map<string, string>();
  await Promise.all(
    directDependencies(pkg).map(async (dep) => {
      const manifest = await firstOf(chain.map((d) => readJson(`${d}/node_modules/${dep}/package.json`)));
      for (const bin of manifest ? declaredBins(dep, manifest) : []) if (!owners.has(bin)) owners.set(bin, dep);
    }),
  );
  const bins = installed
    .map((name) => ({ name, from: owners.get(name) }))
    .sort((a, b) => Number(!a.from) - Number(!b.from) || a.name.localeCompare(b.name));
  const label = typeof pkg.name === "string" && pkg.name ? pkg.name : dir || (root.split("/").pop() ?? "");
  return { dir, label, bins };
}

// ponytail: workspaces with more packages list the first ones only; index members lazily if that bites.
const MAX_PACKAGES = 20;

/** The packages to offer: the current file's (nearest `package.json`), the root, then members with scripts. */
export async function loadPackages(
  root: string,
  file: string | null,
  configs: readonly RunConfig[],
): Promise<PackageBins[]> {
  const base = slash(root);
  const path = file ? slash(file) : "";
  const fileDir = path.startsWith(`${base}/`)
    ? path
        .slice(base.length + 1)
        .split("/")
        .slice(0, -1)
        .join("/")
    : "";
  const candidates = ancestorDirs(fileDir);
  const present = await Promise.all(
    candidates.map((d) =>
      call(commands.fsReadText(`${join(base, d)}/package.json`)).then(
        () => true,
        () => false,
      ),
    ),
  );
  const current = candidates.find((_, i) => present[i]);
  const members = configs
    .filter((c) => c.kind === "npm" && c.detected)
    .map((c) => slash((c.cwd ?? "").replace(/^\.\/?/, "")));
  const dirs = [...new Set([...(current === undefined ? [] : [current]), "", ...members])].slice(0, MAX_PACKAGES);
  return (await Promise.all(dirs.map((d) => loadPackage(base, d)))).filter((p): p is PackageBins => !!p);
}

export function execConfig(runner: Runner, name: string, args: readonly string[], pkg: PackageBins): RunConfig {
  const line = `${runner.prefix} ${formatArgs([name, ...args])}`;
  return {
    id: `runAnything:exec:${pkg.dir}:${line}`,
    name: pkg.dir ? `${pkg.label}: ${line}` : line,
    kind: "npm",
    command: runner.command,
    args: [...runner.args, name, ...args],
    cwd: pkg.dir || null,
    env: {},
    detected: false,
    isTest: false,
    debugAdapter: "js-debug",
  };
}

/** Items for `query`: the current package's executables first, prefix matches first within a package. */
export function execItems(query: string, packages: readonly PackageBins[]): RunAnythingItem[] {
  const parsed = parseExecLine(query);
  if (!parsed || parsed.rest) return [];
  const { runner, name: typed } = parsed;
  const word = typed.toLowerCase();
  return packages.flatMap((pkg) =>
    pkg.bins
      .filter((b) => b.name.toLowerCase().includes(word))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(word)) - Number(!b.name.toLowerCase().startsWith(word)))
      .map((b): RunAnythingItem => {
        const label = `${runner.prefix} ${b.name}`;
        const detail = [b.from !== b.name && b.from, packages.length > 1 && pkg.label].filter(Boolean).join(" · ");
        return {
          key: `${pkg.dir}:${b.name}`,
          label,
          detail: detail || undefined,
          icon: "file-npm",
          completion: `${label} `,
          run: () => void executeAction("run.runConfig", execConfig(runner, b.name, [], pkg)),
        };
      }),
  );
}

let cache: { key: string; promise: Promise<PackageBins[]>; value?: PackageBins[] } | null = null;
const listeners = new Set<() => void>();

function packages(): Promise<PackageBins[]> {
  const root = useProject.getState().project?.root ?? "";
  const file = maybeEditorService()?.activePath() ?? null;
  const key = `${root}\n${file ?? ""}`;
  if (cache?.key !== key) {
    const entry: NonNullable<typeof cache> = {
      key,
      promise: root ? loadPackages(root, file, useRun.getState().configs).catch(() => []) : Promise.resolve([]),
    };
    cache = entry;
    void entry.promise.then((value) => {
      entry.value = value;
      if (cache === entry) listeners.forEach((l) => l());
    });
  }
  return cache.promise;
}

export const packageBinsRunAnything: RunAnythingProvider = {
  id: "run.packageBins",
  group: "Package Executables",
  order: 15,
  items(query) {
    if (!parseExecLine(query)) return [];
    void packages();
    return execItems(query, cache?.value ?? []);
  },
  async execute(line) {
    const parsed = parseExecLine(line);
    // Shell syntax (pipes, `&&`, variables) stays with the shell.
    if (!parsed?.name || /[|&;<>$`]/.test(line)) return false;
    const pkg = (await packages()).find((p) => p.bins.some((b) => b.name === parsed.name));
    if (!pkg) return false;
    const args = parseArgs(parsed.rest, usePlatform.getState().os === "windows");
    await executeAction("run.runConfig", execConfig(parsed.runner, parsed.name, args, pkg));
    return true;
  },
  watch(onChange) {
    // A new popup reads the disk again: packages may have been installed since.
    cache = null;
    listeners.add(onChange);
    return () => listeners.delete(onChange);
  },
};
