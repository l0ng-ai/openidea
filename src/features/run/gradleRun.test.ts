import { afterEach, describe, expect, it, vi } from "vitest";
import type { GradleModel, ProjectInfo, RunConfig } from "@/platform/ipc";
import * as ipc from "@/platform/ipc";
import { applicationConfig } from "./application";
import {
  DELEGATED_ATTACH_LISTENER,
  DELEGATED_DEBUG,
  delegatedGradleConfig,
  gradleDelegation,
  gradleBootLaunch,
  gradleTestLaunch,
  withTestEvents,
  wrapperGradleVersion,
} from "./gradleRun";
import { jdwpLaunch } from "./javaDebug";
import RUN_SCRIPT from "./gradleRun.gradle?raw";
import { isJvmApplication } from "@/platform/javaLaunch";
import TESTS_SCRIPT from "./gradleTests.gradle?raw";
import BOOT_SCRIPT from "./gradleBoot.gradle?raw";
import { useBuildModel } from "@/platform/buildModel";
import { usePlatform } from "@/platform/platformInfo";
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
    expect(delegatedGradleConfig(main("buildSrc/src/main/java/a/Main.java"), "buildSrc", nested)).toBeNull();
  });

  it("is a Gradle run from then on: never delegated twice, the Application's params dropped", () => {
    const app = { ...applicationConfig({ className: "a.Main" }, "app/src/main/java/a/Main.java", []) };
    const run = delegatedGradleConfig({ ...app, params: { vmOptions: "-Xmx1g" } }, "app", ctx)!;
    expect(isJvmApplication(run)).toBe(false);
    expect(run.params).toBeUndefined();
  });

  it("gives Gradle BootRun a dynamic JDWP port when debugging", () => {
    expect(BOOT_SCRIPT).toContain("openidea.run.debug");
    expect(BOOT_SCRIPT).toContain("address=127.0.0.1:0");
  });

  it("gives Gradle test workers a dynamic JDWP port when debugging", () => {
    expect(TESTS_SCRIPT).toContain("openidea.run.debug");
    expect(TESTS_SCRIPT).toContain("address=127.0.0.1:0");
  });

  it("debugs the forked JVM: the init script adds the agent", () => {
    const app = applicationConfig({ className: "a.Main" }, "app/src/main/java/a/Main.java", []);
    const run = delegatedGradleConfig(app, "app", ctx)!;
    const debug = jdwpLaunch(run)!;
    expect(debug.args.at(-1)).toBe(DELEGATED_DEBUG);
    expect(debug.args).not.toContain("--debug-jvm");
    expect(jdwpLaunch(debug)!.args.filter((a) => a === DELEGATED_DEBUG)).toHaveLength(1);
    expect(jdwpLaunch(debug)!.args.filter((a) => a === DELEGATED_ATTACH_LISTENER)).toHaveLength(1);
  });

  it("asks the init script for the attach listener except when Gradle runs on Windows", () => {
    const app = applicationConfig({ className: "a.Main" }, "app/src/main/java/a/Main.java", []);
    const run = delegatedGradleConfig(app, "app", ctx)!;
    expect(jdwpLaunch(run)!.args).toContain(DELEGATED_ATTACH_LISTENER);
    const os = usePlatform.getState().os;
    usePlatform.setState({ os: "windows" });
    try {
      const debug = jdwpLaunch(run)!;
      expect(debug.args).not.toContain(DELEGATED_ATTACH_LISTENER);
      expect(debug.args.at(-1)).toBe(DELEGATED_DEBUG);
    } finally {
      usePlatform.setState({ os });
    }
  });

  it("adds the attach listener before the agent in the init script, unless the VM options decide", () => {
    const flag = RUN_SCRIPT.indexOf("'-XX:+StartAttachListener'");
    const agent = RUN_SCRIPT.indexOf("'-agentlib:jdwp=");
    expect(flag).toBeGreaterThan(0);
    expect(flag).toBeLessThan(agent);
    const guard = RUN_SCRIPT.slice(RUN_SCRIPT.lastIndexOf("if (", flag), flag);
    // Only when the IDE asked for it (never on Windows).
    expect(guard).toContain("Boolean.getBoolean('openidea.run.attachListener')");
    // The guard reads the same list the user's VM options arrive in.
    expect(guard).toContain("list('openidea.run.jvmArgs')");
    expect(guard).toContain("StartAttachListener|DisableAttachMechanism");
  });

  // Gradle 4.6 is the oldest IDEA supports: `register`, `named` and `configureEach` are 4.9+,
  // `debugOptions` 5.6+, `JavaExec.mainClass` 6.4+. Each use needs a guard on its line (#3864).
  it.each([
    ["gradleRun", RUN_SCRIPT],
    ["gradleTests", TESTS_SCRIPT],
    ["gradleBoot", BOOT_SCRIPT],
  ])("%s guards Gradle API newer than 4.6", (_, script) => {
    const unguarded = script
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .filter((l) => /\.register\(|\.named\(|configureEach|debugOptions|mainClass/.test(l))
      .filter((l) => !/GradleVersion|lazyTasks|hasProperty/.test(l));
    expect(unguarded).toEqual([]);
  });

  // Up to Gradle 7.0, a build JVM with its own `org.gradle.jvmargs` gets the command line's `-D`
  // values only once the settings load: read at an init script's top level, they are null (#4093).
  it.each([
    ["gradleRun", RUN_SCRIPT],
    ["gradleTests", TESTS_SCRIPT],
    ["gradleBoot", BOOT_SCRIPT],
  ])("%s reads the launch's -D values in project actions, not at its top level", (_, script) => {
    const topLevel = script
      .split("\n")
      .filter((l) => /^\S/.test(l) && /System\.getProperty|Boolean\.getBoolean|systemPropertiesArgs/.test(l));
    expect(topLevel).toEqual([]);
  });

  it.each([
    // The report: a Spring Boot application in the root project, Gradle wrapper 6.4.1.
    ["", ":", ":openideaRun"],
    ["app", ":app", ":app:openideaRun"],
    [CORE, ":billing:core", ":billing:core:openideaRun"],
  ])("runs module %j as project %s on a Gradle 6.4.1 wrapper (#4093)", (module, project, task) => {
    const file = `${module ? `${module}/` : ""}src/main/java/com/example/demo/DemoApplication.java`;
    const app = applicationConfig({ className: "com.example.demo.DemoApplication", spring: true }, file, []);
    expect(wrapperGradleVersion("distributionUrl=https\\://x/gradle-6.4.1-bin.zip")).toEqual([6, 4]);
    // Below Gradle 8.1: no configuration cache.
    const run = delegatedGradleConfig(app, module, { ...ctx, configurationCache: false })!;
    expect(run.args).toContain(`-Dopenidea.run.project=${project}`);
    expect(run.args.at(-1)).toBe(task);
    // The init script compares each project's identity path with it inside `allprojects`.
    expect(RUN_SCRIPT).toContain("if (id() != System.getProperty('openidea.run.project')) return");
  });

  it("sets the main class with `main` and creates the task eagerly on old Gradle (#3864)", () => {
    expect(RUN_SCRIPT).toContain("if (t.hasProperty('mainClass')) t.mainClass.set(main) else t.main = main");
    expect(RUN_SCRIPT).toContain("else p.tasks.create('openideaRun', JavaExec, configure)");
    expect(RUN_SCRIPT).toContain("import org.gradle.util.GradleVersion");
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

describe("Gradle launch routing", () => {
  const boot = {
    kind: "gradle",
    command: "./gradlew",
    args: [":module:bootRun"],
  } as RunConfig;
  const test = { ...boot, args: [":module:test"], isTest: true };

  afterEach(() => vi.restoreAllMocks());

  it("leaves non-desktop launches alone", async () => {
    vi.spyOn(ipc, "isTauri").mockReturnValue(false);
    expect(await gradleBootLaunch(boot)).toBe(boot);
    expect(await gradleTestLaunch(test)).toBe(test);
  });

  it("keeps the configuration when the host cannot write the init script", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(ipc.commands, "runGradleInitScript").mockRejectedValue(new Error("host unavailable"));
    expect(await gradleBootLaunch(boot)).toBe(boot);
    expect(await gradleTestLaunch(test)).toBe(test);
  });

  it("adds reporting scripts without enabling JDWP for plain Run", async () => {
    for (const config of [await gradleBootLaunch(boot), await gradleTestLaunch(test)]) {
      expect(config.args.slice(0, 2)).toEqual(["--init-script", "/tmp/openidea-gradle-run.gradle"]);
      expect(config.args).not.toContain(DELEGATED_DEBUG);
      expect(config.args).not.toContain("--debug-jvm");
    }
    expect(boot.args).toEqual([":module:bootRun"]);
    expect(test.args).toEqual([":module:test"]);
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

it("uses the same Rebuild preparation for delegated Run and Debug", () => {
  const app = {
    ...applicationConfig({ className: "a.Main" }, "app/src/main/java/a/Main.java", []),
    buildPolicy: "rebuild" as const,
  };
  const run = delegatedGradleConfig(app, "app", ctx)!;
  expect(run.args[0]).toBe("clean");
  const debug = jdwpLaunch(run)!;
  expect(debug.args.filter((a) => a === "clean")).toHaveLength(1);
  expect(debug.args).toContain(DELEGATED_DEBUG);
});
