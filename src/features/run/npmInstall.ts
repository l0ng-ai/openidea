/**
 * "Run npm install?" (WebStorm): a notification when a package's dependencies changed after the
 * last install, or none are installed, with Install (the detected package manager, in the Run
 * tool window) and Ignore (until the dependencies change again). One per workspace root.
 */
import { registerActions } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { call, commands, isTauri, onIdeEvent, type RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { maybeEditorService, notifications } from "@/workbench/contributions";
import { scriptPackageManager } from "./npmGutter";
import { startRun } from "./store";

const LOCKS = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];
/** Rewritten by every install: npm, pnpm, Yarn classic, Yarn's node-modules linker. */
const MARKERS = [".package-lock.json", ".modules.yaml", ".yarn-integrity", ".yarn-state.yml"];
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
// ponytail: bun writes bun.lock just after node_modules and leaves no marker, so a lockfile this
// close to the install counts as written by it.
const SLACK_MS = 2000;
const STORE_KEY = "openidea.npmInstall.v1";

export type InstallDue = "missing" | "stale" | null;

/**
 * `installedAt`: newest install output (`null` when there is none); `lockAt`: newest lockfile;
 * `editedAt`: newest `package.json` whose dependencies differ from the last up-to-date check.
 */
export function installDue(f: {
  hasDeps: boolean;
  installedAt: number | null;
  lockAt: number | null;
  editedAt: number | null;
}): InstallDue {
  if (!f.hasDeps) return null;
  if (f.installedAt === null) return "missing";
  return Math.max(f.lockAt ?? 0, f.editedAt ?? 0) > f.installedAt + SLACK_MS ? "stale" : null;
}

/** The dependency fields of a `package.json`, as compared between checks (scripts and the rest do not count). */
export function dependencySignature(pkg: Record<string, unknown> | null): string {
  return JSON.stringify(DEP_FIELDS.map((f) => pkg?.[f] ?? null));
}

interface Store {
  /** By `package.json`: its dependency signature when it was last up to date. */
  baseline: Record<string, string>;
  /** By install root: the state Ignore was chosen for. */
  ignored: Record<string, string>;
}

function readStore(): Store {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(STORE_KEY) ?? "{}") as Partial<Store>;
    return { baseline: raw.baseline ?? {}, ignored: raw.ignored ?? {} };
  } catch {
    return { baseline: {}, ignored: {} };
  }
}

function writeStore(update: (s: Store) => void) {
  const store = readStore();
  update(store);
  try {
    globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    // Storage full or unavailable: the prompt only comes back sooner.
  }
}

const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/"));
const parse = (text: string | null) => {
  try {
    const value: unknown = text === null ? null : JSON.parse(text);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
const readJson = (path: string) =>
  call(commands.fsReadText(path))
    .then(parse)
    .catch(() => null);
const listDir = async (dir: string) =>
  new Map((await call(commands.fsReadDir(dir)).catch(() => [])).map((e) => [e.name, e]));
const newest = (times: Array<number | null | undefined>) =>
  times.reduce<number | null>((max, t) => (typeof t === "number" && (max === null || t > max) ? t : max), null);

const declaresWorkspaces = async (dir: string) =>
  !!(await readJson(`${dir}/package.json`))?.workspaces ||
  (await call(commands.fsEntryKind(`${dir}/pnpm-workspace.yaml`)).catch(() => null)) === "file";

/** Where the package in `dir` installs: the nearest enclosing workspace root in the project, else `dir`. */
/** `dir` and its ancestors inside the project, nearest first. */
function upTo(dir: string, projectRoot: string): string[] {
  const dirs: string[] = [];
  for (let d = dir; d.length > projectRoot.length && d.startsWith(`${projectRoot}/`); d = dirOf(d)) dirs.push(d);
  return [...dirs, projectRoot];
}

/** Where the package in `dir` installs: the outermost enclosing workspace root in the project, else `dir`. */
async function installRoot(dir: string, projectRoot: string): Promise<string> {
  const dirs = upTo(dir, projectRoot);
  // ponytail: an ancestor declaring workspaces is taken as this package's, without matching its patterns.
  const workspaces = await Promise.all(dirs.map(declaresWorkspaces));
  return dirs.findLast((_, i) => workspaces[i]) ?? dir;
}

/** By install root: the members whose `package.json` changed this session. */
const members = new Map<string, Set<string>>();
/** By install root: when Install last succeeded from here (bun may leave nothing newer behind). */
const resolvedAt = new Map<string, number>();
const installing = new Set<string>();
/** Root and state already notified this session. */
const notified = new Set<string>();

async function inspect(root: string) {
  const files = await listDir(root);
  const nodeModules = files.get("node_modules");
  const [modules, yarn, rootPkg] = await Promise.all([
    nodeModules ? listDir(`${root}/node_modules`) : new Map(),
    files.has(".yarn") ? listDir(`${root}/.yarn`) : new Map(),
    readJson(`${root}/package.json`),
  ]);
  const pnp = files.get(".pnp.cjs");
  const installedAt =
    nodeModules || pnp
      ? newest([
          nodeModules?.mtimeMs,
          pnp?.mtimeMs,
          yarn.get("install-state.gz")?.mtimeMs,
          resolvedAt.get(root),
          ...MARKERS.map((m) => modules.get(m)?.mtimeMs),
        ])
      : null;
  const lockAt = newest(LOCKS.map((l) => files.get(l)?.mtimeMs));
  const memberPaths = [...(members.get(root) ?? [])].filter((p) => p !== `${root}/package.json`);
  const pkgs = [
    { path: `${root}/package.json`, json: rootPkg, mtime: files.get("package.json")?.mtimeMs ?? null },
    ...(await Promise.all(
      memberPaths.map(async (path) => {
        const [json, dir] = await Promise.all([readJson(path), listDir(dirOf(path))]);
        return { path, json, mtime: dir.get("package.json")?.mtimeMs ?? null };
      }),
    )),
  ].map((p) => ({ ...p, signature: dependencySignature(p.json) }));
  const { baseline } = readStore();
  const editedAt = newest(
    pkgs.filter((p) => baseline[p.path] !== undefined && baseline[p.path] !== p.signature).map((p) => p.mtime),
  );
  const hasDeps =
    !!rootPkg?.workspaces ||
    pkgs.some((p) => DEP_FIELDS.some((f) => Object.keys((p.json?.[f] as object | undefined) ?? {}).length > 0));
  const due = installDue({ hasDeps, installedAt, lockAt, editedAt });
  if (!due)
    writeStore((s) => {
      for (const p of pkgs) s.baseline[p.path] = p.signature;
    });
  return {
    due,
    pm: scriptPackageManager(rootPkg, [...files.keys()]),
    state: JSON.stringify([due, lockAt, pkgs.map((p) => [p.path, p.signature])]),
  };
}

export function npmInstallConfig(dir: string, pm: string): RunConfig {
  return {
    id: `npm:install:${dir}`,
    name: `${pm} install`,
    kind: "npm",
    command: pm,
    args: ["install"],
    cwd: dir,
    env: {},
    detected: true,
    isTest: false,
    debugAdapter: null,
  };
}

const notificationKey = (root: string) => `npm-install:${root}`;

async function install(root: string, pm: string) {
  if (installing.has(root)) return;
  installing.add(root);
  notifications().expire?.(notificationKey(root));
  const done = (code: number | null) => {
    installing.delete(root);
    if (code === 0) resolvedAt.set(root, Date.now());
    check(root);
  };
  try {
    // Puts the configured Node.js first on PATH.
    const [config] = await call(commands.runApplySettings([npmInstallConfig(root, pm)]));
    const session = await startRun(config ?? npmInstallConfig(root, pm), undefined, undefined, { onExit: done });
    if (!session) done(null);
  } catch (e) {
    done(null);
    throw e;
  }
}

function check(root: string) {
  const project = useProject.getState().project;
  if (!isTauri() || !project?.trusted || installing.has(root)) return;
  void inspect(root)
    .then(({ due, pm, state }) => {
      if (useProject.getState().project?.root !== project.root) return;
      const key = notificationKey(root);
      if (!due) {
        notifications().expire?.(key);
        return;
      }
      const seen = `${root}\n${state}`;
      if (installing.has(root) || notified.has(seen) || readStore().ignored[root] === state) return;
      notified.add(seen);
      const command = `${pm} install`;
      const rel = root.slice(project.root.length + 1);
      notifications().notify({
        group: "run",
        level: "warning",
        key,
        title: due === "missing" ? "Dependencies are not installed" : "Dependencies changed since the last install",
        body: rel ? tx`Run '${command}' in '${rel}' to install them.` : tx`Run '${command}' to install them.`,
        actions: [
          { label: "Install", run: () => void install(root, pm) },
          {
            label: "Ignore",
            run: () => {
              writeStore((s) => void (s.ignored[root] = state));
              notifications().expire?.(key);
            },
          },
        ],
      });
    })
    .catch(() => {});
}

/** A `package.json` or lockfile at `path` changed: checks its install root. */
async function changed(path: string) {
  const projectRoot = useProject.getState().project?.root;
  if (!projectRoot || !path.startsWith(`${projectRoot}/`) || path.includes("/node_modules/")) return;
  const dir = dirOf(path);
  if (
    !path.endsWith("/package.json") &&
    (await call(commands.fsEntryKind(`${dir}/package.json`)).catch(() => null)) !== "file"
  )
    return;
  const root = await installRoot(dir, projectRoot);
  if (!members.has(root)) members.set(root, new Set());
  members.get(root)!.add(`${dir}/package.json`);
  check(root);
}

/** Install for the active file's package (its workspace root), else the project's. */
async function installForActive(arg: unknown) {
  const projectRoot = useProject.getState().project?.root;
  if (!projectRoot) return;
  const path = typeof arg === "string" ? arg : (maybeEditorService()?.activePath() ?? "");
  const dirs = upTo(path.startsWith(`${projectRoot}/`) ? dirOf(path) : projectRoot, projectRoot);
  const kinds = await Promise.all(dirs.map((d) => call(commands.fsEntryKind(`${d}/package.json`)).catch(() => null)));
  const dir = dirs.find((_, i) => kinds[i] === "file") ?? projectRoot;
  const root = await installRoot(dir, projectRoot);
  await install(root, (await inspect(root)).pm);
}

const recheck = () => members.forEach((_, root) => check(root));

const WATCHED = /\/(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/;
const INSTALL_OUTPUT = /\/(node_modules|\.yarn)(\/|$)|\/\.pnp\.cjs$/;

/** The `package.json` of each workspace member, so its dependencies are known before an edit. */
async function workspaceMembers(root: string): Promise<string[]> {
  const [pkg, yaml] = await Promise.all([
    readJson(`${root}/package.json`),
    call(commands.fsReadText(`${root}/pnpm-workspace.yaml`)).catch(() => null),
  ]);
  const ws = pkg?.workspaces as { packages?: unknown } | unknown[] | undefined;
  const listed = Array.isArray(ws) ? ws : Array.isArray(ws?.packages) ? ws.packages : [];
  // ponytail: every `- item` of pnpm-workspace.yaml; items that are not folders simply match nothing.
  const fromYaml = [...(yaml ?? "").matchAll(/^\s*-\s*['"]?([^'"#\s]+)/gm)].map((m) => m[1]!);
  // ponytail: `dir/*` and literal folders, the usual layouts; deeper globs are picked up on their first change.
  const patterns = [...listed, ...fromYaml].filter((p): p is string => typeof p === "string" && !p.startsWith("!"));
  const dirs = (
    await Promise.all(
      patterns.map(async (p) => {
        const base = `${root}/${p.replace(/\/\*$/, "").replace(/^\.\//, "")}`;
        if (!p.endsWith("/*")) return p.includes("*") ? [] : [base];
        const entries = await listDir(base);
        return [...entries.values()].filter((e) => e.kind === "dir").map((e) => `${base}/${e.name}`);
      }),
    )
  ).flat();
  const kinds = await Promise.all(dirs.map((d) => call(commands.fsEntryKind(`${d}/package.json`)).catch(() => null)));
  return dirs.filter((_, i) => kinds[i] === "file").map((d) => `${d}/package.json`);
}

async function open() {
  members.clear();
  resolvedAt.clear();
  notified.clear();
  const root = useProject.getState().project?.root;
  if (!root) return;
  const found = await workspaceMembers(root);
  if (useProject.getState().project?.root !== root) return;
  if (!members.has(root)) members.set(root, new Set());
  for (const path of [`${root}/package.json`, ...found]) members.get(root)!.add(path);
  check(root);
}

export function registerNpmInstall(): () => void {
  void open();
  const disposers = [
    registerActions([
      {
        id: "npm.install",
        title: "Install Node.js Dependencies",
        category: "Run",
        when: "projectOpen",
        run: ({ arg }) => installForActive(arg),
      },
    ]),
    onIdeEvent("fsChanged", (e) => {
      const paths = [...e.created, ...e.modified, ...e.removed];
      for (const path of paths) if (WATCHED.test(path)) void changed(path);
      if (paths.some((p) => INSTALL_OUTPUT.test(p))) recheck();
    }),
    onIdeEvent("excludedDirsChanged", (e) => {
      if (e.dirs.some((d) => INSTALL_OUTPUT.test(d))) recheck();
    }),
    onIdeEvent("projectTrustChanged", () => recheck()),
    useProject.subscribe((s, prev) => {
      if (s.project?.root !== prev.project?.root) void open();
    }),
  ];
  return () => disposers.forEach((d) => d());
}
