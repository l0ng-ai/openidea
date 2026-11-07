import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IpcError, type RunConfig } from "@/platform/ipc";
import { recordProjectBuild } from "@/platform/buildReceipt";
import { useProject } from "@/platform/project";
import { findJavaModule, prepareJavaLaunch } from "@/platform/javaLaunch";
import { _resetI18nForTests, setLocale } from "@/platform/i18n";
import { provideEditorService, provideNotificationService } from "@/workbench/contributions";
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
  provideEditorService({ dirtyDocumentIds: () => [], saveAll: async () => {} } as never);
});
afterEach(() => {
  resetRuns();
  _resetI18nForTests();
});

it.each(["sibling", "/outside/modules"])("runs from %s using the stored module's classpath", async (cwd) => {
  const session = await startRun({ ...config, module: "app", cwd });
  expect(session?.status).toBe("running");
  expect(ipc.javaResolveLaunch).toHaveBeenCalledWith("app", false, "automatic", expect.any(Number));
  expect(ipc.runStart).toHaveBeenCalledWith(
    expect.objectContaining({ cwd, args: ["-cp", "/p/app/target/classes", "a.Main"] }),
    expect.anything(),
  );
  expect(ipc.findFiles).not.toHaveBeenCalled();
});

const launchInfo = (build: "succeeded" | "failed" | "withErrors") => ({
  build,
  projectRoot: "/p",
  classPaths: ["/p/app/target/classes"],
  modulePaths: [],
  javaHome: null,
  javaExec: "java",
  shortenCommandLine: null,
  errors: build === "succeeded" ? [] : [{ path: "/p/app/src/Main.java", line: 1, column: 1, message: "boom" }],
  errorCount: build === "succeeded" ? 0 : 1,
  hints: [],
});

it("applies Rebuild to a Maven run command", async () => {
  await startRun({
    ...config,
    kind: "maven",
    command: "mvn",
    args: ["-B", "spring-boot:run"],
    buildPolicy: "rebuild",
  });
  expect(ipc.runStart).toHaveBeenCalledWith(
    expect.objectContaining({ command: "mvn", args: ["clean", "-B", "spring-boot:run"] }),
    expect.anything(),
  );
});

it("resolves an explicit classpath without building for NoBuild", async () => {
  await startRun({ ...config, module: "app", buildPolicy: "noBuild", args: ["-cp", "lib/*", "a.Main"] });
  expect(ipc.javaResolveLaunch).toHaveBeenCalledWith("app", false, "noBuild", expect.any(Number));
  expect(ipc.runStart).toHaveBeenCalledWith(
    expect.objectContaining({ args: ["-cp", "lib/*", "a.Main"] }),
    expect.anything(),
  );
});

it.each(["noBuild", "rebuild"] as const)("passes the %s build policy to the resolver", async (buildPolicy) => {
  await startRun({ ...config, module: "app", buildPolicy });
  expect(ipc.javaResolveLaunch).toHaveBeenCalledWith("app", false, buildPolicy, expect.any(Number));
});

it("reuses a successful Before launch Build Project instead of building again", async () => {
  useProject.setState({ project: { root: "/p" } as never });
  recordProjectBuild("/p");
  await startRun({ ...config, module: "app" }, undefined, undefined, { prepared: true });
  expect(ipc.javaResolveLaunch).toHaveBeenCalledWith("app", false, "noBuild", expect.any(Number));
  useProject.setState({ project: null });
});

it("does not reuse a Build Project receipt after a dirty editor", async () => {
  useProject.setState({ project: { root: "/p" } as never });
  recordProjectBuild("/p");
  provideEditorService({ dirtyDocumentIds: () => [1], saveAll: async () => {} } as never);
  await startRun({ ...config, module: "app" }, undefined, undefined, { prepared: true });
  expect(ipc.javaResolveLaunch).toHaveBeenCalledWith("app", false, "automatic", expect.any(Number));
  provideEditorService({ dirtyDocumentIds: () => [] } as never);
  useProject.setState({ project: null });
});

it("does not start a configuration whose build failed", async () => {
  ipc.javaResolveLaunch.mockResolvedValueOnce({ status: "ok", data: launchInfo("failed") });
  const session = await startRun({ ...config, module: "app", buildPolicy: "make" });
  expect(session?.status).toBe("failed");
  expect(ipc.runStart).not.toHaveBeenCalled();
});

it("starts with the last compiled classes for makeAndContinueOnErrors", async () => {
  ipc.javaResolveLaunch.mockResolvedValueOnce({ status: "ok", data: launchInfo("withErrors") });
  const session = await startRun({ ...config, module: "app", buildPolicy: "makeAndContinueOnErrors" });
  expect(session?.status).toBe("running");
  expect(ipc.runStart).toHaveBeenCalled();
});

it("finds the source module for an old saved configuration without a module", async () => {
  await startRun({ ...config, cwd: "/outside/modules" });
  expect(ipc.findFiles).toHaveBeenCalledWith("Main.java", 1000);
  expect(ipc.javaResolveLaunch).toHaveBeenCalledWith("app", false, "automatic", expect.any(Number));
  expect(ipc.runStart).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/outside/modules" }), expect.anything());
});

it.each([["-cp", "lib/*"], []])("colours Spring Boot runs without classpath resolution (%j)", async (...classpath) => {
  const args = ["-Xmx256m", ...classpath, "a.Main", "--spring.profiles.active=dev"];
  const boot = { ...config, kind: "spring-boot", args };
  const session = await startRun(boot);
  expect(session?.status).toBe("running");
  expect(ipc.runStart).toHaveBeenCalledWith(
    expect.objectContaining({ args: ["-Dspring.output.ansi.enabled=always", ...args] }),
    expect.anything(),
  );
  expect(ipc.javaResolveLaunch).toHaveBeenCalledWith("app", false, "automatic", expect.any(Number));
  expect(boot.args).toBe(args);
  expect(args).not.toContain("-Dspring.output.ansi.enabled=always");
});

it.each(["never", "detect", "always"])("preserves an explicit Spring Boot console setting (%s)", async (value) => {
  const args = [`-Dspring.output.ansi.enabled=${value}`, "-cp", "lib/*", "a.Main"];
  await startRun({ ...config, kind: "spring-boot", args });
  expect(ipc.runStart).toHaveBeenCalledWith(expect.objectContaining({ args }), expect.anything());
  expect(ipc.javaResolveLaunch).toHaveBeenCalledWith("app", false, "automatic", expect.any(Number));
});

it("keeps plain Java runs with an explicit classpath free of Spring Boot options", async () => {
  const args = ["-cp", "lib/*", "a.Main"];
  await startRun({ ...config, args });
  expect(ipc.runStart).toHaveBeenCalledWith(expect.objectContaining({ args }), expect.anything());
  expect(ipc.javaResolveLaunch).toHaveBeenCalledWith("app", false, "automatic", expect.any(Number));
});

it("adds the Spring Boot console option once when resolving the module classpath", async () => {
  await startRun({ ...config, kind: "spring-boot", module: "app" });
  expect(ipc.runStart).toHaveBeenCalledWith(
    expect.objectContaining({
      args: ["-Dspring.output.ansi.enabled=always", "-cp", "/p/app/target/classes", "a.Main"],
    }),
    expect.anything(),
  );
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
