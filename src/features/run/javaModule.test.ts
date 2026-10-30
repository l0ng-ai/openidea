import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { findJavaModule } from "@/platform/javaLaunch";
import { provideNotificationService } from "@/workbench/contributions";
import { applicationConfig } from "./application";
import { resetRuns, saveUserConfigs, startRun } from "./store";
import { applicationType } from "./jvmTypes";
import { withParams } from "./types";

const ipc = vi.hoisted(() => {
  const ok = (data: unknown) => Promise.resolve({ status: "ok", data });
  return {
    findFiles: vi.fn((name: string) =>
      ok(
        name === "Main.java"
          ? [{ path: "/p/app/src/main/java/a/Main.java", relPath: "app/src/main/java/a/Main.java" }]
          : [],
      ),
    ),
    fsReadText: vi.fn(() => ok("package a;\npublic class Main {}")),
    runConfigs: vi.fn(() => ok([])),
    runSaveConfigs: vi.fn(() => ok(null)),
    runStart: vi.fn(() => ok({ id: 1, pty: false })),
    javaResolveLaunch: vi.fn(() =>
      ok({
        build: "succeeded",
        projectRoot: "/p",
        classPaths: ["/p/app/target/classes"],
        modulePaths: [],
        javaHome: null,
        javaExec: "java",
        shortenCommandLine: null,
        errors: [],
        errorCount: 0,
        hints: [],
      }),
    ),
  };
});
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage = null;
  },
}));
const config: RunConfig = {
  id: "user:main",
  name: "Main",
  kind: "application",
  command: "java",
  args: ["-cp", "${classpath}", "a.Main"],
  cwd: "app",
  env: {},
  detected: false,
  isTest: false,
  debugAdapter: "java-debug",
};
beforeEach(() => {
  vi.clearAllMocks();
  provideNotificationService({ notify: vi.fn() });
});
afterEach(() => resetRuns());

it.each(["sibling", "/outside/modules"])("runs from %s using the stored module's classpath", async (cwd) => {
  const session = await startRun({ ...config, module: "app", cwd });
  expect(session?.status).toBe("running");
  expect(ipc.javaResolveLaunch).toHaveBeenCalledWith("app", false, true, expect.any(Number));
  expect(ipc.runStart).toHaveBeenCalledWith(
    expect.objectContaining({ cwd, args: ["-cp", "/p/app/target/classes", "a.Main"] }),
    expect.anything(),
  );
  expect(ipc.findFiles).not.toHaveBeenCalled();
});

it("finds the source module for an old saved configuration without a module", async () => {
  await startRun({ ...config, cwd: "/outside/modules" });
  expect(ipc.findFiles).toHaveBeenCalledWith("Main.java", 1000);
  expect(ipc.javaResolveLaunch).toHaveBeenCalledWith("app", false, true, expect.any(Number));
  expect(ipc.runStart).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/outside/modules" }), expect.anything());
});

it("keeps an explicitly stored root module", async () => {
  expect(await findJavaModule({ ...config, module: "", cwd: "sibling" })).toBe("");
  expect(ipc.findFiles).not.toHaveBeenCalled();
});

it("stores the source module when a manually created application is saved", async () => {
  await saveUserConfigs([{ ...config, cwd: "sibling" }]);
  expect(ipc.runSaveConfigs).toHaveBeenCalledWith([expect.objectContaining({ module: "app", cwd: "sibling" })], []);
});

it("stores the module at context creation and forgets it when the main class changes", () => {
  const detected = applicationConfig({ className: "a.Main" }, "app/src/main/java/a/Main.java");
  expect(detected.module).toBe("app");
  expect(withParams(detected, { mainClass: "b.Other" }, applicationType).module).toBeUndefined();
  expect(withParams(detected, { mainClass: "a.Main", programArgs: "x" }, applicationType).module).toBe("app");
});

it("does not substitute the working directory when sources are missing or ambiguous", async () => {
  ipc.findFiles.mockResolvedValueOnce({ status: "ok", data: [] });
  expect(await findJavaModule({ ...config, cwd: "sibling" })).toBeNull();
  ipc.findFiles.mockResolvedValueOnce({
    status: "ok",
    data: [
      { path: "/p/app/src/main/java/a/Main.java", relPath: "app/src/main/java/a/Main.java" },
      { path: "/p/other/src/main/java/a/Main.java", relPath: "other/src/main/java/a/Main.java" },
    ],
  });
  expect(await findJavaModule(config)).toBeNull();
});
