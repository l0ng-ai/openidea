import { afterEach, beforeEach, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  fsReadText: vi.fn(),
  fsReadDir: vi.fn(),
  fsEntryKind: vi.fn(),
  runApplySettings: vi.fn(),
}));
const run = vi.hoisted(() => ({ startRun: vi.fn() }));
vi.mock("@/platform/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/ipc")>()),
  isTauri: () => true,
  commands: ipc,
}));
vi.mock("./store", () => run);

import { emitLocalIdeEvent, type IdeEvent, type RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { provideNotificationService } from "@/workbench/contributions";
import { installDue, isWorkspaceMember, pnpmWorkspacePackages, registerNpmInstall } from "./npmInstall";

const ok = <T>(data: T) => Promise.resolve({ status: "ok" as const, data });
const err = () => Promise.resolve({ status: "error" as const, error: { kind: "notFound", message: "" } });

/** The disk: modification time and, for files the code reads, text. Folders are implied by their contents. */
let disk: Map<string, { mtime: number; text?: string }>;
const write = (path: string, mtime: number, text?: string) => disk.set(path, { mtime, text });
const pkg = (deps: Record<string, string> = {}, extra: object = {}) =>
  JSON.stringify({ name: "x", scripts: { dev: "vite" }, dependencies: deps, ...extra });

const notify = vi.fn();
const expire = vi.fn();
provideNotificationService({ notify, expire });

const settle = () => new Promise((r) => setTimeout(r, 0)).then(() => new Promise((r) => setTimeout(r, 0)));
const fsChanged = async (...modified: string[]) => {
  emitLocalIdeEvent({ type: "fsChanged", created: [], modified, removed: [] } as unknown as IdeEvent);
  await vi.waitFor(() => expect(ipc.fsReadDir).toHaveBeenCalled());
  await settle();
};
const titles = () => notify.mock.calls.map(([n]) => n.title as string);
const act = (label: string) =>
  notify.mock.calls
    .at(-1)![0]
    .actions.find((a: { label: string }) => a.label === label)
    .run();

let dispose: () => void;
beforeEach(() => {
  localStorage.clear();
  disk = new Map();
  ipc.fsReadText.mockImplementation((path: string) => {
    const text = disk.get(path)?.text;
    return text === undefined ? err() : ok(text);
  });
  ipc.fsReadDir.mockImplementation((dir: string) => {
    const names = new Map<string, { name: string; mtimeMs: number; kind: string }>();
    for (const [path, { mtime }] of disk) {
      if (!path.startsWith(`${dir}/`)) continue;
      const name = path.slice(dir.length + 1).split("/")[0]!;
      const isFile = !path.slice(dir.length + 1).includes("/");
      // A folder's mtime: its newest direct entry.
      const prev = names.get(name);
      names.set(name, { name, mtimeMs: Math.max(prev?.mtimeMs ?? 0, mtime), kind: isFile ? "file" : "dir" });
    }
    return names.size ? ok([...names.values()]) : err();
  });
  ipc.fsEntryKind.mockImplementation((path: string) => ok(disk.has(path) ? "file" : null));
  ipc.runApplySettings.mockImplementation((configs: RunConfig[]) => ok(configs));
  run.startRun.mockResolvedValue(null);
});
afterEach(() => {
  dispose?.();
  vi.clearAllMocks();
  useProject.setState({ project: null });
});

const open = async (root = "/p") => {
  useProject.setState({ project: { root, trusted: true } as never });
  dispose = registerNpmInstall();
  await vi.waitFor(() => expect(ipc.fsReadDir).toHaveBeenCalled());
  await settle();
};

it("is due without install output, or when a lockfile or edited package.json is newer than it", () => {
  const base = { hasDeps: true, installedAt: 10_000, lockAt: 9_000, editedAt: null };
  expect(installDue(base)).toBeNull();
  expect(installDue({ ...base, hasDeps: false, installedAt: null })).toBeNull();
  expect(installDue({ ...base, installedAt: null })).toBe("missing");
  expect(installDue({ ...base, lockAt: 20_000 })).toBe("stale");
  // bun writes its lockfile just after node_modules.
  expect(installDue({ ...base, lockAt: 10_500 })).toBeNull();
  expect(installDue({ ...base, editedAt: 20_000 })).toBe("stale");
});

it("asks once for a fresh clone and installs with the detected package manager in the Run tool window", async () => {
  write("/p/package.json", 1_000, pkg({ react: "^19.0.0" }));
  write("/p/pnpm-lock.yaml", 1_000);
  await open();
  expect(titles()).toEqual(["Dependencies are not installed"]);
  expect(notify.mock.calls[0]![0].body).toBe("Run 'pnpm install' to install them.");

  await fsChanged("/p/package.json");
  expect(titles()).toHaveLength(1);

  act("Install");
  await vi.waitFor(() => expect(run.startRun).toHaveBeenCalled());
  expect(run.startRun.mock.calls[0]![0]).toMatchObject({ kind: "npm", command: "pnpm", args: ["install"], cwd: "/p" });
});

it("asks when the lockfile changes after the install (a pull), not for package.json edits outside dependencies", async () => {
  write("/p/package.json", 1_000, pkg({ react: "^19.0.0" }));
  write("/p/package-lock.json", 1_000);
  write("/p/node_modules/.package-lock.json", 2_000);
  await open();
  expect(notify).not.toHaveBeenCalled();

  write("/p/package.json", 60_000, pkg({ react: "^19.0.0" }, { scripts: { dev: "vite", build: "vite build" } }));
  await fsChanged("/p/package.json");
  expect(notify).not.toHaveBeenCalled();

  write("/p/package.json", 70_000, pkg({ react: "^19.1.0" }));
  await fsChanged("/p/package.json");
  expect(titles()).toEqual(["Dependencies changed since the last install"]);
  expect(notify.mock.calls[0]![0].body).toBe("Run 'npm install' to install them.");

  // Installed from a terminal: the prompt goes.
  write("/p/node_modules/.package-lock.json", 80_000);
  emitLocalIdeEvent({ type: "excludedDirsChanged", dirs: ["/p/node_modules"] } as unknown as IdeEvent);
  await vi.waitFor(() => expect(expire).toHaveBeenCalledWith("npm-install:/p"));

  write("/p/package-lock.json", 90_000);
  await fsChanged("/p/package-lock.json");
  expect(titles()).toHaveLength(2);
});

it("asks once at the workspace root for a member's dependency change", async () => {
  write("/p/package.json", 1_000, pkg({}, { workspaces: ["packages/*"] }));
  write("/p/yarn.lock", 1_000);
  write("/p/packages/web/package.json", 1_000, pkg({ react: "^19.0.0" }));
  write("/p/node_modules/.yarn-integrity", 2_000);
  await open();
  expect(notify).not.toHaveBeenCalled();

  write("/p/packages/web/package.json", 60_000, pkg({ react: "^19.0.0", vite: "^7.0.0" }));
  await fsChanged("/p/packages/web/package.json");
  expect(titles()).toEqual(["Dependencies changed since the last install"]);
  expect(notify.mock.calls[0]![0].key).toBe("npm-install:/p");

  act("Install");
  await vi.waitFor(() => expect(run.startRun).toHaveBeenCalled());
  expect(run.startRun.mock.calls[0]![0]).toMatchObject({ command: "yarn", args: ["install"], cwd: "/p" });
});

it("stays quiet after Ignore until the dependencies change again, also after reopening", async () => {
  write("/p/package.json", 1_000, pkg({ react: "^19.0.0" }));
  await open();
  act("Ignore");
  dispose();
  notify.mockClear();
  await open();
  expect(notify).not.toHaveBeenCalled();

  write("/p/package.json", 60_000, pkg({ react: "^19.0.0", vite: "^7.0.0" }));
  await fsChanged("/p/package.json");
  expect(titles()).toEqual(["Dependencies are not installed"]);
});

it("leaves packages without dependencies and untrusted projects alone", async () => {
  write("/p/package.json", 1_000, pkg());
  await open();
  dispose();
  write("/q/package.json", 1_000, pkg({ react: "^19.0.0" }));
  useProject.setState({ project: { root: "/q", trusted: false } as never });
  dispose = registerNpmInstall();
  await settle();
  expect(notify).not.toHaveBeenCalled();
});

it("reads members from pnpm-workspace.yaml `packages` only and matches them with exclusions", () => {
  expect(pnpmWorkspacePackages("onlyBuiltDependencies:\n  - esbuild\n")).toEqual([]);
  expect(pnpmWorkspacePackages("packages:\n  - 'apps/*'\n  - \"!apps/legacy\" # old\ncatalog:\n  - x\n")).toEqual([
    "apps/*",
    "!apps/legacy",
  ]);
  const patterns = ["apps/*", "!apps/legacy", "libs/**"];
  expect(isWorkspaceMember("apps/web", patterns)).toBe(true);
  expect(isWorkspaceMember("apps/legacy", patterns)).toBe(false);
  expect(isWorkspaceMember("apps/web/nested", patterns)).toBe(false);
  expect(isWorkspaceMember("libs/a/b", patterns)).toBe(true);
  expect(isWorkspaceMember("fixtures/app", patterns)).toBe(false);
  expect(isWorkspaceMember("", [])).toBe(true);
});

it("keeps a dependency change pending when a dev server writes node_modules/.vite", async () => {
  write("/p/package.json", 1_000, pkg({ react: "^19.0.0" }));
  write("/p/package-lock.json", 1_000);
  write("/p/node_modules/.package-lock.json", 2_000);
  write("/p/node_modules/react/package.json", 2_000);
  await open();
  write("/p/package.json", 60_000, pkg({ react: "^19.1.0" }));
  await fsChanged("/p/package.json");
  expect(titles()).toEqual(["Dependencies changed since the last install"]);
  expire.mockClear();

  write("/p/node_modules/.vite/deps/react.js", 70_000);
  emitLocalIdeEvent({ type: "excludedDirsChanged", dirs: ["/p/node_modules/.vite"] } as unknown as IdeEvent);
  await settle();
  expect(expire).not.toHaveBeenCalled();
  // Still due on the next look: the change was not taken as installed.
  dispose();
  notify.mockClear();
  await open();
  expect(titles()).toEqual(["Dependencies changed since the last install"]);
});

it("takes bun's package folders as the install when node_modules has no marker", async () => {
  write("/p/package.json", 1_000, pkg({ react: "^19.0.0" }));
  write("/p/bun.lock", 2_500);
  write("/p/node_modules/react/package.json", 2_000);
  write("/p/node_modules/.cache/x", 90_000);
  await open();
  expect(notify).not.toHaveBeenCalled();
  write("/p/bun.lock", 60_000);
  await fsChanged("/p/bun.lock");
  expect(titles()).toEqual(["Dependencies changed since the last install"]);
});

it("checks packages right under the project root, each on its own outside a pnpm `packages` list", async () => {
  write("/p/package.json", 1_000, pkg());
  write("/p/pnpm-workspace.yaml", 1_000, "onlyBuiltDependencies:\n  - esbuild\n");
  write("/p/web/package.json", 1_000, pkg({ react: "^19.0.0" }));
  write("/p/node_modules/.modules.yaml", 2_000);
  await open();
  expect(titles()).toEqual(["Dependencies are not installed"]);
  expect(notify.mock.calls[0]![0]).toMatchObject({
    key: "npm-install:/p/web",
    body: "Run 'npm install' in 'web' to install them.",
  });
});
