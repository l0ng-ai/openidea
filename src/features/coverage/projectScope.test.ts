import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CoveragePrepared, CoverageSuite, RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { coverageExecutor } from "./executor";
import { importReport } from "./reports";
import { importedReports, resetCoverage, useCoverage } from "./store";

const backend = vi.hoisted(() => ({
  coverageImport: vi.fn(),
  coveragePrepare: vi.fn(),
  coverageCollect: vi.fn(),
  open: vi.fn(),
  show: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("@/platform/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    commands: {
      ...actual.commands,
      coverageImport: backend.coverageImport,
      coveragePrepare: backend.coveragePrepare,
      coverageCollect: backend.coverageCollect,
    },
  };
});
vi.mock("@/platform/dialog", () => ({ open: backend.open }));
vi.mock("@/workbench/contributions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/workbench/contributions")>()),
  notifications: () => ({ notify: backend.notify }),
  toolWindowService: () => ({ show: backend.show }),
}));

const origin = "/project-a";
const next = "/project-b";
const report = `${origin}/lcov.info`;
const data: CoverageSuite = {
  runner: "lcov",
  hasBranches: false,
  files: [
    { path: `${origin}/src/a.ts`, lines: [], linesCovered: 1, linesTotal: 2, branchesCovered: 0, branchesTotal: 0 },
  ],
};
const config: RunConfig = {
  id: "run-a",
  kind: "shell",
  name: "Run A",
  command: "go",
  args: ["test"],
  cwd: null,
  env: {},
  detected: false,
  isTest: true,
  debugAdapter: null,
};
const plan: CoveragePrepared = {
  status: "ready",
  runner: "lcov",
  launch: config,
  report: { kind: "lcov", runner: "lcov", path: report, base: origin },
};
const ok = <T>(value: T) => ({ status: "ok" as const, data: value });
const switchTo = (root: string) => useProject.setState({ project: { root } as never });
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  resetCoverage();
  switchTo(origin);
});
afterEach(() => {
  useProject.setState({ project: null, opening: false, openingPath: null });
  resetCoverage();
});

it("remembers a late coverage import only in the requesting project", async () => {
  const response = pending<ReturnType<typeof ok<CoverageSuite>>>();
  backend.coverageImport.mockReturnValueOnce(response.promise).mockResolvedValueOnce(ok(data));
  const importing = importReport(report);
  expect(backend.coverageImport).toHaveBeenCalledWith(report);

  switchTo(next);
  response.resolve(ok(data));
  await importing;
  expect(useCoverage.getState().suites).toEqual([]);
  expect(importedReports()).toEqual([]);
  expect(importedReports(origin)).toEqual([{ path: report, name: "lcov.info", importedAt: expect.any(Number) }]);
  expect(backend.show).not.toHaveBeenCalled();
  expect(backend.notify).not.toHaveBeenCalled();

  switchTo(origin);
  const suite = await importReport(importedReports()[0]!.path);
  expect(useCoverage.getState().suites).toEqual([suite]);
  expect(suite?.data).toEqual(data);
  expect(backend.show).toHaveBeenCalledWith("coverage");
});

it.each([
  ["while the next project opens", () => useProject.setState({ opening: true, openingPath: next })],
  ["after the next project opens", () => switchTo(next)],
])("abandons a report picked %s", async (_transition, changeProject) => {
  const picker = pending<string>();
  backend.open.mockReturnValue(picker.promise);
  backend.coverageImport.mockResolvedValue(ok(data));
  const importing = importReport();
  await vi.waitFor(() => expect(backend.open).toHaveBeenCalledOnce());
  changeProject();
  picker.resolve(report);
  await expect(importing).resolves.toBeNull();
  expect(backend.coverageImport).not.toHaveBeenCalled();
});

it("does not launch coverage after leaving the project during preparation", async () => {
  const response = pending<ReturnType<typeof ok<CoveragePrepared>>>();
  backend.coveragePrepare.mockReturnValue(response.promise);
  const preparing = coverageExecutor.prepare(config);
  switchTo(next);
  response.resolve(ok(plan));
  await expect(preparing).resolves.toBeNull();
});

it("does not show a collected run after leaving its project", async () => {
  const response = pending<ReturnType<typeof ok<CoverageSuite>>>();
  backend.coveragePrepare.mockResolvedValue(ok(plan));
  backend.coverageCollect.mockReturnValue(response.promise);
  const run = await coverageExecutor.prepare(config);
  expect(run).not.toBeNull();
  run!.finished({ stopped: false, exitCode: 0 });
  expect(backend.coverageCollect).toHaveBeenCalledWith(plan.report);

  switchTo(next);
  response.resolve(ok(data));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(useCoverage.getState().suites).toEqual([]);
  expect(backend.show).not.toHaveBeenCalled();
  expect(backend.notify).not.toHaveBeenCalled();
});
