import { describe, expect, it } from "vitest";
import type { GradleModel, RunConfig } from "@/platform/ipc";
import { applicationConfig } from "./application";
import { DELEGATED_DEBUG, delegatedGradleConfig, wrapperGradleVersion } from "./gradleRun";
import { jdwpLaunch } from "./javaDebug";
import { isJvmApplication } from "@/platform/javaLaunch";

const ROOT = "/w/shop";
const CORE = "/w/billing/modules/core";
const gradle = {
  dir: "",
  command: "/w/shop/gradlew",
  env: { JAVA_HOME: "/jdk21" },
  projects: [
    { path: ":", name: "Shop", dir: "", buildFile: null, tasks: [] },
    { path: ":billing:core", name: "core", dir: CORE, buildFile: null, tasks: [] },
    { path: ":app", name: "app", dir: "app", buildFile: null, tasks: [] },
  ],
} as unknown as GradleModel;
const ctx = {
  root: ROOT,
  gradle,
  script: "/tmp/openidea-gradle-run.gradle",
  offline: false,
  configurationCache: false,
};

describe("Build and run using: Gradle", () => {
  it("runs an Application of an includeFlat module as its JavaExec task", () => {
    const app: RunConfig = {
      ...applicationConfig(
        { className: "com.example.ShopApplication", spring: true },
        `${CORE}/src/main/java/com/example/ShopApplication.java`,
        [],
      ),
      args: ["-Xmx1g", "-cp", "${classpath}", "com.example.ShopApplication", "--port", "8081 x"],
      env: { SPRING_PROFILES_ACTIVE: "dev" },
    };
    const run = delegatedGradleConfig(app, CORE, ctx)!;
    expect(run).toMatchObject({
      kind: "gradle",
      name: "ShopApplication",
      command: "/w/shop/gradlew",
      cwd: null,
      module: CORE,
      env: { JAVA_HOME: "/jdk21", SPRING_PROFILES_ACTIVE: "dev" },
    });
    expect(run.args).toEqual([
      "--console=plain",
      "--init-script",
      "/tmp/openidea-gradle-run.gradle",
      "-Dopenidea.run.project=:billing:core",
      "-Dopenidea.run.main=com.example.ShopApplication",
      "-Dopenidea.run.sourceSet=main",
      '-Dopenidea.run.args=["--port","8081 x"]',
      '-Dopenidea.run.jvmArgs=["-Dspring.output.ansi.enabled=always","-Xmx1g"]',
      `-Dopenidea.run.workingDir=${CORE}`,
      ":billing:core:openideaRun",
    ]);
  });

  it("colours Spring Boot consoles unless the configuration decides", () => {
    const boot = (args: string[]) =>
      delegatedGradleConfig(
        { ...applicationConfig({ className: "a.App", spring: true }, "app/x.java"), args },
        "app",
        ctx,
      )!;
    expect(boot(["-cp", "${classpath}", "a.App"]).args).toContain(
      '-Dopenidea.run.jvmArgs=["-Dspring.output.ansi.enabled=always"]',
    );
    expect(boot(["-Dspring.output.ansi.enabled=never", "-cp", "${classpath}", "a.App"]).args).toContain(
      '-Dopenidea.run.jvmArgs=["-Dspring.output.ansi.enabled=never"]',
    );
    const plain = applicationConfig({ className: "a.Main" }, "app/src/main/java/a/Main.java", []);
    expect(delegatedGradleConfig(plain, "app", ctx)!.args).toContain("-Dopenidea.run.jvmArgs=[]");
  });

  it("uses the test classpath, a project-relative module and offline mode", () => {
    const test = applicationConfig({ className: "a.Tool" }, "app/src/test/java/a/Tool.java", []);
    const run = delegatedGradleConfig(test, "app", { ...ctx, offline: true })!;
    expect(run.args).toContain("-Dopenidea.run.sourceSet=test");
    expect(run.args).toContain("-Dopenidea.run.workingDir=/w/shop/app");
    expect(run.args.slice(-2)).toEqual(["--offline", ":app:openideaRun"]);
  });

  it("reuses Gradle's configuration cache on Gradle 8.1+ wrappers", () => {
    const app = applicationConfig({ className: "a.Main" }, "app/src/main/java/a/Main.java", []);
    const run = delegatedGradleConfig(app, "app", { ...ctx, configurationCache: true })!;
    expect(run.args.slice(-3)).toEqual([
      "--configuration-cache",
      "--configuration-cache-problems=warn",
      ":app:openideaRun",
    ]);
    const props = (url: string) => `distributionBase=GRADLE_USER_HOME\ndistributionUrl=${url}\n`;
    expect(wrapperGradleVersion(props("https\\://services.gradle.org/distributions/gradle-8.10.2-bin.zip"))).toEqual([
      8, 10,
    ]);
    expect(wrapperGradleVersion(props("https://x/gradle-7.6-all.zip"))).toEqual([7, 6]);
    expect(wrapperGradleVersion("# no distribution\n")).toBeNull();
  });

  it("leaves mains outside the build's modules to the language server", () => {
    const stray = applicationConfig({ className: "x.Main" }, "/elsewhere/src/main/java/x/Main.java", []);
    expect(delegatedGradleConfig(stray, "/elsewhere", ctx)).toBeNull();
  });

  it("is a Gradle run from then on: never delegated twice, the Application's params dropped", () => {
    const app = { ...applicationConfig({ className: "a.Main" }, "app/src/main/java/a/Main.java", []) };
    const run = delegatedGradleConfig({ ...app, params: { vmOptions: "-Xmx1g" } }, "app", ctx)!;
    expect(isJvmApplication(run)).toBe(false);
    expect(run.params).toBeUndefined();
  });

  it("debugs the forked JVM: the init script adds the agent", () => {
    const app = applicationConfig({ className: "a.Main" }, "app/src/main/java/a/Main.java", []);
    const run = delegatedGradleConfig(app, "app", ctx)!;
    const debug = jdwpLaunch(run)!;
    expect(debug.args.at(-1)).toBe(DELEGATED_DEBUG);
    expect(debug.args).not.toContain("--debug-jvm");
    expect(jdwpLaunch(debug)!.args.filter((a) => a === DELEGATED_DEBUG)).toHaveLength(1);
  });
});
