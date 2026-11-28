import { beforeEach, expect, it, vi } from "vitest";

const ok = <T>(data: T) => Promise.resolve({ status: "ok" as const, data });
const ipc = vi.hoisted(() => ({
  packages: ["django"] as string[],
  envFiles: ["/p/.venv/pyvenv.cfg"] as string[],
  pip: vi.fn(),
  restart: vi.fn(),
  notify: vi.fn(),
  gate: null as null | Promise<void>,
}));

vi.mock("@tauri-apps/api/core", () => ({ Channel: class {} }));
vi.mock("@/workbench/tasks", () => ({ upsertTask: () => {} }));
vi.mock("@/workbench/contributions", () => ({ notifications: () => ({ notify: ipc.notify }) }));
vi.mock("@/platform/ipc", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  nextRequestId: () => 1,
  commands: {
    cancelRequest: () => ok(null),
    fsEntryKind: (path: string) =>
      ipc.envFiles.includes(path) ? ok("file") : Promise.resolve({ status: "error", error: { message: "missing" } }),
    sdkPythonPackages: async () => {
      await ipc.gate;
      return ok(ipc.packages.map((name) => ({ name, version: "1" })));
    },
    sdkPythonPip: (python: string, requirement: string) => {
      ipc.pip(python, requirement);
      ipc.packages.push(requirement);
      return ok(null);
    },
    lspRestartNamed: (name: string) => {
      ipc.restart(name);
      return ok(null);
    },
  },
}));

const { checkStubs, install, needsStubs, resetStubs, useStubs } = await import("./stubs");

beforeEach(() => {
  resetStubs();
  ipc.packages = ["django"];
  ipc.envFiles = ["/p/.venv/pyvenv.cfg"];
  ipc.gate = null;
  ipc.pip.mockClear();
  ipc.restart.mockClear();
});

it("asks for stubs when Django has none", () => {
  expect(needsStubs(["django", "asgiref"])).toBe(true);
  expect(needsStubs(["django", "django-types"])).toBe(false);
  expect(needsStubs(["django", "django-stubs"])).toBe(false);
  expect(needsStubs(["flask"])).toBe(false);
});

it("offers the install only for a virtual environment", async () => {
  await checkStubs("/p/.venv/bin/python");
  expect(useStubs.getState()).toMatchObject({ python: "/p/.venv/bin/python", missing: true });
  await checkStubs("/usr/bin/python3");
  expect(useStubs.getState().missing).toBe(false);
  ipc.envFiles = ["/opt/conda/envs/site/conda-meta"];
  await checkStubs("/opt/conda/envs/site/bin/python");
  expect(useStubs.getState().missing).toBe(true);
});

it("installs into the checked interpreter, restarts the type checker and checks again", async () => {
  await checkStubs("/p/.venv/bin/python");
  await install();
  expect(ipc.pip).toHaveBeenCalledWith("/p/.venv/bin/python", "django-types");
  expect(ipc.restart).toHaveBeenCalledWith("basedpyright");
  expect(useStubs.getState()).toMatchObject({ missing: false, installing: false });
});

it("drops a check that ends after the project changed", async () => {
  let release!: () => void;
  ipc.gate = new Promise((resolve) => (release = resolve));
  const old = checkStubs("/old/.venv/bin/python");
  resetStubs();
  release();
  await old;
  expect(useStubs.getState().python).toBeNull();
});
