/**
 * Run Anything completion for `npx` / `pnpm exec` / `bunx` / `yarn` lines: the
 * executables installed in `node_modules/.bin` (the current file's package
 * first, its direct dependencies' before the rest), run through the package
 * manager in the package folder like npm script entries. Reads the disk only.
 */
import { executeAction } from "@/platform/actions";
import { formatArgs, parseArgs } from "@/platform/commandLine";
import { call, commands, onIdeEvent, type FileEntry, type RunConfig } from "@/platform/ipc";
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
  /** Yarn 2+: `yarn <bin>` runs only the package's direct dependencies' executables. */
  yarnBerry?: boolean;
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

/** `.bin` entry names without the Windows shims' extensions (`eslint.cmd`, `eslint.ps1`, Bun's `eslint.bunx`). */
export function binEntryNames(names: readonly string[]): string[] {
  return [...new Set(names.map((n) => n.replace(/\.(?:cmd|ps1|exe|bat|bunx)$/i, "")))];
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

// Disk reads shared by every load until something under `node_modules` or a `package.json` changes.
const reads = new Map<string, Promise<unknown>>();
function memo<T>(key: string, read: () => Promise<T>): Promise<T> {
  if (!reads.has(key)) reads.set(key, read());
  return reads.get(key) as Promise<T>;
}

/** Forgets what was read from disk (file changes; tests). */
export function clearPackageBinsCache() {
  reads.clear();
  cache = null;
}

const readJson = (path: string) =>
  memo(`json:${path}`, async (): Promise<PackageJson | null> => {
    try {
      const v: unknown = JSON.parse(await call(commands.fsReadText(path)));
      return v && typeof v === "object" ? (v as PackageJson) : null;
    } catch {
      return null;
    }
  });

const exists = (path: string) =>
  memo(`exists:${path}`, () =>
    call(commands.fsReadText(path)).then(
      () => true,
      () => false,
    ),
  );

const readDir = (path: string) =>
  memo(`dir:${path}`, () => call(commands.fsReadDir(path)).catch((): FileEntry[] => []));

async function readBinDir(dir: string): Promise<string[]> {
  const entries = await readDir(`${dir}/node_modules/.bin`);
  // Directories and dangling links (an uninstalled package's leftover) are not executables.
  const runnable = entries.filter((e) => e.kind === "file" || (e.kind === "symlink" && e.targetKind === "file"));
  return binEntryNames(runnable.map((e) => e.name));
}

/** Whether `dir/node_modules` has `dep` (`@scope/name` looked up in its scope folder). */
async function hasModule(dir: string, dep: string): Promise<boolean> {
  const slashAt = dep.indexOf("/");
  const folder = slashAt > 0 ? `${dir}/node_modules/${dep.slice(0, slashAt)}` : `${dir}/node_modules`;
  const name = slashAt > 0 ? dep.slice(slashAt + 1) : dep;
  return (await readDir(folder)).some((e) => e.name === name);
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
      // Only the nearest copy's manifest is read; listings tell where it is.
      const found = await Promise.all(chain.map((d) => hasModule(d, dep)));
      const home = chain.find((_, i) => found[i]);
      const manifest = home === undefined ? null : await readJson(`${home}/node_modules/${dep}/package.json`);
      for (const bin of manifest ? declaredBins(dep, manifest) : []) if (!owners.has(bin)) owners.set(bin, dep);
    }),
  );
  const bins = installed
    .map((name) => ({ name, from: owners.get(name) }))
    .sort((a, b) => Number(!a.from) - Number(!b.from) || a.name.localeCompare(b.name));
  const label = typeof pkg.name === "string" && pkg.name ? pkg.name : dir || (root.split("/").pop() ?? "");
  return { dir, label, bins };
}

/** Yarn 2+ in the project: a `.yarnrc.yml`, or `packageManager: yarn@2…` in the root `package.json`. */
async function isYarnBerry(root: string): Promise<boolean> {
  const pm = (await readJson(`${root}/package.json`))?.packageManager;
  if (typeof pm === "string" && pm.startsWith("yarn@")) return !pm.startsWith("yarn@1.");
  return exists(`${root}/.yarnrc.yml`);
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
  const present = await Promise.all(candidates.map((d) => exists(`${join(base, d)}/package.json`)));
  const current = candidates.find((_, i) => present[i]);
  const members = configs
    .filter((c) => c.kind === "npm" && c.detected)
    .map((c) => slash((c.cwd ?? "").replace(/^\.(?:\/|$)/, "")));
  const dirs = [...new Set([...(current === undefined ? [] : [current]), "", ...members])].slice(0, MAX_PACKAGES);
  const [yarnBerry, ...loaded] = await Promise.all([isYarnBerry(base), ...dirs.map((d) => loadPackage(base, d))]);
  return loaded.filter((p): p is PackageBins => !!p).map((p) => (yarnBerry ? { ...p, yarnBerry } : p));
}

/** What `runner` can run in `pkg`: Yarn 2+ refuses executables that aren't the package's direct dependencies'. */
export function runnableBins(runner: Runner, pkg: PackageBins): PackageBins["bins"] {
  return runner.command === "yarn" && pkg.yarnBerry ? pkg.bins.filter((b) => b.from) : pkg.bins;
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
    runnableBins(runner, pkg)
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

/** Characters a shell expands or interprets; quotes and backslashes are split by `parseArgs`. */
export const SHELL_SYNTAX = /[|&;<>$`*?~{}()[\]%!#\n]/;

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
  accepts(line) {
    const parsed = parseExecLine(line);
    if (!parsed?.name || SHELL_SYNTAX.test(line)) return false;
    void packages();
    return !!cache?.value?.some((p) => runnableBins(parsed.runner, p).some((b) => b.name === parsed.name));
  },
  async execute(line) {
    const parsed = parseExecLine(line);
    // Shell syntax (pipes, `&&`, variables, globs, `~`, braces, `%VAR%`…) stays with the shell.
    if (!parsed?.name || SHELL_SYNTAX.test(line)) return false;
    const pkg = (await packages()).find((p) => runnableBins(parsed.runner, p).some((b) => b.name === parsed.name));
    if (!pkg) return false;
    const args = parseArgs(parsed.rest, usePlatform.getState().os === "windows");
    await executeAction("run.runConfig", execConfig(parsed.runner, parsed.name, args, pkg));
    return true;
  },
  subscribe(onChange) {
    listeners.add(onChange);
    return () => listeners.delete(onChange);
  },
};

const AFFECTS_BINS = /(?:^|\/)(?:node_modules|package\.json|\.yarnrc\.yml)(?:\/|$)/;

/** Drops the cache when installs or manifests change (`node_modules` is excluded, so it reports as a folder). */
export function watchPackageBinsChanges(): () => void {
  const changed = (paths: readonly string[]) => {
    if (paths.some((p) => AFFECTS_BINS.test(slash(p)))) clearPackageBinsCache();
  };
  const disposers = [
    onIdeEvent("fsChanged", (e) => changed([...e.created, ...e.modified, ...e.removed])),
    onIdeEvent("excludedDirsChanged", (e) => changed(e.dirs)),
  ];
  return () => disposers.forEach((d) => d());
}
