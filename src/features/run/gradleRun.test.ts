import { afterEach, describe, expect, it, vi } from "vitest";
import type { GradleModel, ProjectInfo, RunConfig } from "@/platform/ipc";
import { applicationConfig } from "./application";
import {
  DELEGATED_DEBUG,
  delegatedGradleConfig,
  gradleDelegation,
  withTestEvents,
  supportsConfigurationCache,
  wrapperGradleVersion,
} from "./gradleRun";
import { jdwpLaunch } from "./javaDebug";
import { isJvmApplication } from "@/platform/javaLaunch";
import RUN_SCRIPT from "./gradleRun.gradle?raw";
import TESTS_SCRIPT from "./gradleTests.gradle?raw";
import { useBuildModel } from "@/platform/buildModel";
import { useProject } from "@/platform/project";

vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    call: (value: unknown) => value,
    commands: {
      ...real.commands,
      runGradleInitScript: () => Promise.resolve("/tmp/openidea-gradle-run.gradle"),
      fsReadText: () => Promise.resolve("distributionUrl=https://x/gradle-8.10-bin.zip"),
    },
  };
});

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
      '-Dopenidea.run.jvmArgs=["-Xmx1g"]',
      `-Dopenidea.run.workingDir=${CORE}`,
      ":billing:core:openideaRun",
    ]);
  });

  it("Rebuild cleans the module before the Gradle run", () => {
    const app = applicationConfig(
      { className: "com.example.ShopApplication" },
      `${CORE}/src/main/java/com/example/ShopApplication.java`,
      [],
    );
    const run = delegatedGradleConfig({ ...app, buildPolicy: "rebuild" }, CORE, ctx)!;
    expect(run.args.slice(-2)).toEqual([":billing:core:clean", ":billing:core:openideaRun"]);
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

  it("recognizes a versioned local Gradle distribution for the configuration cache", async () => {
    const local = (command: string) => ({ root: "/w", gradle: { ...gradle, command } });
    expect(await supportsConfigurationCache(local("/opt/gradle-8.10/bin/gradle"))).toBe(true);
    expect(await supportsConfigurationCache(local("/opt/gradle-7.6/bin/gradle"))).toBe(false);
    expect(await supportsConfigurationCache(local("/opt/gradle/bin/gradle"))).toBe(false);
  });

  it("leaves mains outside the build's modules to the language server", () => {
    const stray = applicationConfig({ className: "x.Main" }, "/elsewhere/src/main/java/x/Main.java", []);
    expect(delegatedGradleConfig(stray, "/elsewhere", ctx)).toBeNull();
  });

  it("runs included builds' modules by identity path, never buildSrc's", () => {
    const nested = {
      ...ctx,
      gradle: {
        ...gradle,
        projects: [
          ...gradle.projects,
          { path: ":lib:core", name: "core", dir: "/w/lib/core", buildFile: null, tasks: [], build: ":lib" },
          { path: ":buildSrc", name: "buildSrc", dir: "buildSrc", buildFile: null, tasks: [], build: ":buildSrc" },
        ],
      },
    };
    const main = (file: string) => applicationConfig({ className: "a.Main" }, file, []);
    const lib = delegatedGradleConfig(main("/w/lib/core/src/main/java/a/Main.java"), "/w/lib/core", nested)!;
    expect(lib.args.at(-1)).toBe(":lib:core:openideaRun");
    const debug = jdwpLaunch(lib)!;
    expect(debug.args.at(-1)).toBe(DELEGATED_DEBUG);
    expect(delegatedGradleConfig(main("buildSrc/src/main/java/a/Main.java"), "buildSrc", nested)).toBeNull();
  });

  it("is a Gradle run from then on: never delegated twice, the Application's params dropped", () => {
    const app = { ...applicationConfig({ className: "a.Main" }, "app/src/main/java/a/Main.java", []) };
    const run = delegatedGradleConfig({ ...app, params: { vmOptions: "-Xmx1g" } }, "app", ctx)!;
    expect(isJvmApplication(run)).toBe(false);
    expect(run.params).toBeUndefined();
  });

  it("gives Gradle test workers a dynamic JDWP port when debugging", () => {
    expect(TESTS_SCRIPT).toContain("openidea.run.debug");
    expect(TESTS_SCRIPT).toContain("address=127.0.0.1:0");
  });

  it("compiles the source set before running it", () => {
    expect(RUN_SCRIPT).toContain("t.dependsOn(p.tasks.named(sourceSet == 'test' ? 'testClasses' : 'classes'))");
  });

  it("skips the compile dependency for Build, no error check", () => {
    const app = applicationConfig({ className: "a.Main" }, "app/src/main/java/a/Main.java", []);
    const run = delegatedGradleConfig({ ...app, buildPolicy: "makeAndContinueOnErrors" }, "app", ctx)!;
    expect(run.args).toContain("-Dopenidea.run.noErrorCheck=true");
    expect(RUN_SCRIPT).toContain("openidea.run.noErrorCheck");
  });

  it("uses a JRE chosen on the Application as the JavaExec launcher", () => {
    const app = applicationConfig(
      { className: "com.example.ShopApplication" },
      `${CORE}/src/main/java/com/example/ShopApplication.java`,
      [],
    );
    const run = delegatedGradleConfig({ ...app, command: "/jdks/17/bin/java" }, CORE, ctx)!;
    expect(run.args).toContain("-Dopenidea.run.javaExec=/jdks/17/bin/java");
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

describe("Gradle test runs", () => {
  const script = "/tmp/openidea-gradle-tests.gradle";
  it("add the init script that reports each test", () => {
    expect(
      withTestEvents({ kind: "gradle", command: "./gradlew", args: ["test", "--tests", "*OrderTest"] }, script).args,
    ).toEqual(["--init-script", script, "test", "--tests", "*OrderTest"]);
    expect(withTestEvents({ kind: "shell", command: "C:\\w\\gradlew.bat", args: ["test"] }, script).args).toEqual([
      "--init-script",
      script,
      "test",
    ]);
  });

  it("leave other runs and an added script alone", () => {
    const maven = { kind: "maven", command: "./mvnw", args: ["test"] };
    expect(withTestEvents(maven, script)).toBe(maven);
    const twice = withTestEvents({ kind: "gradle", command: "gradle", args: ["test"] }, script);
    expect(withTestEvents(twice, script)).toBe(twice);
  });
});

describe("delegation across independent builds", () => {
  afterEach(() => {
    useProject.setState({ project: null, settings: null });
    useBuildModel.setState({ root: null, model: null, gradleOffline: false });
  });

  it("selects the module's linked build and preserves composite identity task paths", async () => {
    const builds = ["first", "second"].map((dir) => ({
      ...gradle,
      dir,
      command: `${ROOT}/${dir}/gradlew`,
      env: { JAVA_HOME: `/${dir}/jdk` },
      projects: [{ path: ":app", name: "app", dir: `${dir}/app`, buildFile: null, tasks: [] }],
    }));
    useProject.setState({ project: { root: ROOT } as ProjectInfo, settings: null });
    useBuildModel.setState({ root: ROOT, model: { maven: null, gradle: builds }, gradleOffline: true });
    const app = {
      ...applicationConfig({ className: "a.Main" }, "second/app/src/main/java/a/Main.java", []),
      module: "second/app",
    };
    const run = await gradleDelegation(app);
    expect(run).toMatchObject({ command: `${ROOT}/second/gradlew`, cwd: "second", env: { JAVA_HOME: "/second/jdk" } });
    expect(run!.args).toContain("--offline");
    expect(run!.args.at(-1)).toBe(":app:openideaRun");
  });

  it("leaves the launch to the IDE when Build and run using is IDE", async () => {
    useProject.setState({
      project: { root: ROOT } as ProjectInfo,
      settings: { languages: { java: { gradle: { runUsing: "ide" } } } } as never,
    });
    useBuildModel.setState({ root: ROOT, model: { maven: null, gradle: [gradle] } });
    const app = applicationConfig({ className: "a.Main" }, "app/src/main/java/a/Main.java", []);
    expect(await gradleDelegation(app)).toBeNull();
  });

  it("does not delegate a No Build configuration to Gradle", async () => {
    useProject.setState({ project: { root: ROOT } as ProjectInfo, settings: null });
    useBuildModel.setState({ root: ROOT, model: { maven: null, gradle: [gradle] } });
    const app = applicationConfig({ className: "a.Main" }, "app/src/main/java/a/Main.java", []);
    expect(await gradleDelegation({ ...app, buildPolicy: "noBuild" })).toBeNull();
  });

  it("prefers the directly linked owner over a longer sibling composite root", async () => {
    const composite = {
      ...gradle,
      dir: "very-long-composite",
      command: `${ROOT}/very-long-composite/gradlew`,
      projects: [{ path: ":b:app", name: "app", dir: "b/app", buildFile: null, tasks: [], build: ":b" }],
    };
    const direct = {
      ...gradle,
      dir: "b",
      command: `${ROOT}/b/gradlew`,
      projects: [{ path: ":app", name: "app", dir: "b/app", buildFile: null, tasks: [] }],
    };
    useProject.setState({ project: { root: ROOT } as ProjectInfo, settings: null });
    useBuildModel.setState({ root: ROOT, model: { maven: null, gradle: [composite, direct] } });
    const app = {
      ...applicationConfig({ className: "a.Main" }, "b/app/src/main/java/a/Main.java", []),
      module: "b/app",
    };
    const run = await gradleDelegation(app);
    expect(run).toMatchObject({ command: `${ROOT}/b/gradlew`, cwd: "b" });
    expect(run!.args.at(-1)).toBe(":app:openideaRun");
  });
});
