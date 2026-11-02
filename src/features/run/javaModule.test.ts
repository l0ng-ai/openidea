import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IpcError, type RunConfig } from "@/platform/ipc";
import { javaModule, prepareJavaLaunch } from "@/platform/javaLaunch";
import { _resetI18nForTests, setLocale } from "@/platform/i18n";
import { provideNotificationService } from "@/workbench/contributions";
import { applicationConfig } from "./application";
import { resetRuns, runtime, saveUserConfigs, startRun } from "./store";
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
    runSaveConfigs: vi.fn((_user: RunConfig[], _removed: string[]) => ok(null)),
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
const notify = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  provideNotificationService({ notify });
});
afterEach(() => {
  resetRuns();
  _resetI18nForTests();
});

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
  expect(await javaModule({ ...config, module: "", cwd: "sibling" })).toBe("");
  expect(ipc.findFiles).not.toHaveBeenCalled();
});

it("stores the source module when a manually created application is saved", async () => {
  await saveUserConfigs([{ ...config, cwd: "sibling" }]);
  expect(ipc.runSaveConfigs).toHaveBeenCalledWith([expect.objectContaining({ module: "app", cwd: "sibling" })], []);
});

it("asks for the module when the main class is not a source file of this project", async () => {
  // The class comes from a dependency: no source file can name the module, and a wrong
  // guess would resolve the wrong classpath, so the configuration is saved without one.
  ipc.findFiles.mockResolvedValueOnce({ status: "ok", data: [] });
  await saveUserConfigs([{ ...config, name: "knowbase-gateway", cwd: "gateway" }]);
  const saved = ipc.runSaveConfigs.mock.calls[0]![0];
  expect(saved[0]).not.toHaveProperty("module");
  expect(notify).toHaveBeenCalledWith(
    expect.objectContaining({ level: "warning", title: "Module not set for 'knowbase-gateway'" }),
  );
});

it("stores the module of a detected configuration from its own source", async () => {
  await saveUserConfigs([{ ...config, detected: true, cwd: "sibling" }]);
  expect(ipc.runSaveConfigs).toHaveBeenCalledWith([expect.objectContaining({ module: "app" })], []);
});

it("stores the module at context creation and forgets it when the main class changes", () => {
  const detected = applicationConfig({ className: "a.Main" }, "app/src/main/java/a/Main.java");
  expect(detected.module).toBe("app");
  expect(withParams(detected, { mainClass: "b.Other" }, applicationType).module).toBeUndefined();
  expect(withParams(detected, { mainClass: "a.Main", programArgs: "x" }, applicationType).module).toBe("app");
});

it("does not substitute the working directory when sources are missing or ambiguous", async () => {
  ipc.findFiles.mockResolvedValueOnce({ status: "ok", data: [] });
  expect(await javaModule({ ...config, cwd: "sibling" })).toBeUndefined();
  ipc.findFiles.mockResolvedValueOnce({
    status: "ok",
    data: [
      { path: "/p/app/src/main/java/a/Main.java", relPath: "app/src/main/java/a/Main.java" },
      { path: "/p/other/src/main/java/a/Main.java", relPath: "other/src/main/java/a/Main.java" },
    ],
  });
  expect(await javaModule(config)).toBeUndefined();
});

it.each([
  "jdtls: Given URI does not belong to any Java project.",
  "jdtls: Launch configuration 1793460461218 references non-existing project parent.",
])("explains how to import a module when Run fails with %s", async (message) => {
  ipc.javaResolveLaunch.mockResolvedValueOnce({ status: "error", error: { kind: "protocol", message } } as never);
  const session = await startRun({ ...config, module: "web" });
  expect(session?.status).toBe("failed");
  const output = runtime(session!.id)!
    .console.lines.map((line) => line.text)
    .join("\n");
  expect(output).toContain("Java module 'web' is not imported.");
  expect(output).toContain("parent Maven or Gradle build");
  expect(output).toContain("open its folder as a project");
  expect(ipc.runStart).not.toHaveBeenCalled();
});

it.each([
  ["unavailable", "jdtls is not installed (Settings › Languages & Frameworks › Language Servers)"],
  ["unavailable", "jdtls exited with code 1: wrong Java version"],
  ["protocol", "jdtls: workspace/executeCommand timed out after 90 s"],
  ["internal", "Build failed"],
  ["cancelled", "jdtls: Given URI does not belong to any Java project."],
] as const)("preserves other launch errors (%s: %s)", async (kind, message) => {
  const error = new IpcError({ kind, message });
  ipc.javaResolveLaunch.mockRejectedValueOnce(error);
  await expect(
    prepareJavaLaunch({ ...config, module: "web" }, { request: 1, signal: new AbortController().signal }),
  ).rejects.toBe(error);
});

it("translates import recovery guidance for a root Spring Boot configuration", async () => {
  await setLocale("zh");
  ipc.javaResolveLaunch.mockRejectedValueOnce(
    new IpcError({ kind: "protocol", message: "jdtls: Given URI does not belong to any Java project." }),
  );
  await expect(
    prepareJavaLaunch(
      { ...config, kind: "spring-boot", module: "" },
      { request: 1, signal: new AbortController().signal },
    ),
  ).rejects.toThrow("Java 模块 '.' 尚未导入");
});
