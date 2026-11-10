import { afterEach, expect, it, vi } from "vitest";
import { registerActions } from "@/platform/actions";
import { setContext } from "@/platform/context";
import type { RunConfig } from "@/platform/ipc";
import { provideNotificationService } from "@/workbench/contributions";
import { validateConfig } from "./configs";
import { cmakeBuildId, isCMakeBuild } from "./cmake";
import { runBeforeLaunch, taskLabel } from "./beforeLaunch";
import { resetRuns, startRun, useRun } from "./store";

const config = (id: string, kind: string, args: string[] = []): RunConfig => ({
  id,
  kind,
  args,
  name: id,
  command: "cmake",
  cwd: null,
  env: {},
  detected: true,
  isTest: false,
  debugAdapter: null,
});
const configure = config("cmake:build:configure", "cmake", ["-S", ".", "-B", "build"]);
const build = config("cmake:build:build", "cmake", ["--build", "build"]);
const target = config("cmake:release:hello:build", "cmake", [
  "--build",
  "release",
  "--target",
  "hello",
  "--config",
  "Release",
]);
const app = { ...config("hello", "cmake-application"), beforeLaunch: [{ kind: "build", target: target.id }] };
const configs = [configure, build, target, app];
afterEach(() => resetRuns());

it("selects the target build, configure's build directory, and CTest's prerequisite", () => {
  expect(cmakeBuildId(configure, configs)).toBe(build.id);
  expect(cmakeBuildId(target, configs)).toBe(target.id);
  expect(cmakeBuildId(app, configs)).toBe(target.id);
  expect(
    cmakeBuildId(
      { ...config("ctest", "cmake", ["--test-dir", "build"]), beforeLaunch: [{ kind: "build", target: build.id }] },
      configs,
    ),
  ).toBe(build.id);
  expect(cmakeBuildId(config("script", "shell"), configs)).toBeNull();
  expect(cmakeBuildId(undefined, configs)).toBeNull();
  expect(isCMakeBuild(config("test", "cmake", ["--test-dir", "build"]))).toBe(false);
});

it.each(["success", "failed", "cancelled"])(
  "awaits a %s target build before launching, including saved run prerequisites",
  async (status) => {
    const notify = vi.fn();
    provideNotificationService({ notify });
    useRun.setState({ configs });
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const run = vi.fn(async () => {
      await pending;
      setContext("build.lastStatus", status);
    });
    const dispose = registerActions([{ id: "build.buildProject", title: "Build Project", run }]);
    try {
      const launch = runBeforeLaunch(app, [app.id]);
      expect(run).toHaveBeenCalledWith(expect.objectContaining({ arg: { cmake: target.id, activate: false } }));
      finish();
      expect(await launch).toBe(status === "success");
      const legacy = { ...app, beforeLaunch: [{ kind: "run", target: target.id }] };
      expect(await runBeforeLaunch(legacy, [app.id])).toBe(status === "success");
      expect(taskLabel(app.beforeLaunch[0]!, configs)).toBe(target.name);
      expect(useRun.getState().sessions).toHaveLength(0);
    } finally {
      dispose();
    }
  },
);

it("sends explicit configure and build configurations to Build without creating Run tabs", async () => {
  const run = vi.fn(async () => setContext("build.lastStatus", "success"));
  const dispose = registerActions([{ id: "build.buildProject", title: "Build Project", run }]);
  try {
    for (const c of [configure, build, target]) {
      expect(await startRun(c)).toBeNull();
      expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ arg: { cmake: c.id, activate: true } }));
    }
    expect(useRun.getState().sessions).toHaveLength(0);
  } finally {
    dispose();
  }
});

it("validates target build prerequisites while allowing a generic project build", () => {
  expect(validateConfig(app, configs).beforeLaunch).toBeUndefined();
  expect(validateConfig(app, []).beforeLaunch).toBeDefined();
  expect(
    validateConfig({ ...app, beforeLaunch: [{ kind: "build", target: app.id }] }, configs).beforeLaunch,
  ).toBeDefined();
  expect(
    validateConfig({ ...app, beforeLaunch: [{ kind: "build", target: "" }] }, configs).beforeLaunch,
  ).toBeUndefined();
});
