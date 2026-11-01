import { describe, expect, it } from "vitest";
import type { GradleModel, MavenModel, MavenPlugin, MavenProject } from "@/platform/ipc";
import {
  expandableKeys,
  goalCompletions,
  gradleChildren,
  gradleRoots,
  gradleTaskConfig,
  isRunnable,
  mavenChildren,
  mavenGoalConfig,
  mavenRoots,
  nodeIcon,
  nodeLabel,
  parseGoalLine,
  parseTaskLine,
  profilesArg,
  skippedTestRun,
  splitArgs,
  taskCompletions,
  type BuildNode,
} from "./model";

function project(over: Partial<MavenProject>): MavenProject {
  return {
    pom: "pom.xml",
    dir: "",
    groupId: "demo",
    artifactId: "parent",
    version: "1.0",
    packaging: "pom",
    displayName: "parent",
    parent: null,
    modules: [],
    aggregated: false,
    plugins: [],
    dependencies: [],
    profiles: [],
    javaVersion: 21,
    command: "/p/mvnw",
    options: [],
    env: { JAVA_HOME: "/jdk21" },
    ...over,
  };
}

const surefire = {
  groupId: "org.apache.maven.plugins",
  artifactId: "maven-surefire-plugin",
  version: "3.2.5",
  prefix: "surefire",
  goals: ["help", "test"],
};

const maven: MavenModel = {
  projects: [
    project({ modules: ["core/pom.xml", "app/pom.xml"], displayName: "Multi Demo", profiles: ["dev", "ci"] }),
    project({
      pom: "core/pom.xml",
      dir: "core",
      artifactId: "core",
      displayName: "core",
      packaging: "jar",
      aggregated: true,
      plugins: [surefire],
      dependencies: [
        {
          groupId: "org.junit.jupiter",
          artifactId: "junit-jupiter",
          version: "5.10.2",
          type: "jar",
          classifier: null,
          scope: "test",
          optional: false,
          children: [
            {
              groupId: "org.junit.jupiter",
              artifactId: "junit-jupiter-api",
              version: "5.10.2",
              type: "jar",
              classifier: null,
              scope: "test",
              optional: false,
              children: [],
            },
          ],
        },
      ],
    }),
    project({
      pom: "app/pom.xml",
      dir: "app",
      artifactId: "app",
      displayName: "Demo App",
      packaging: "jar",
      aggregated: true,
    }),
  ],
  profiles: [
    { id: "dev", activeByDefault: true },
    { id: "ci", activeByDefault: false },
  ],
  syncedAt: null,
  stale: false,
  syncError: null,
};

const children = (n: BuildNode) => mavenChildren(n, maven) ?? [];
const labels = (nodes: BuildNode[]) => nodes.map(nodeLabel);

describe("Maven tree", () => {
  it("shows profiles, then the aggregator with lifecycle, plugins and its modules", () => {
    const roots = mavenRoots(maven);
    expect(labels(roots)).toEqual(["Profiles", "Multi Demo"]);
    expect(labels(children(roots[0]!))).toEqual(["dev", "ci"]);
    const top = children(roots[1]!);
    expect(labels(top)).toEqual(["Lifecycle", "Plugins", "core", "Demo App"]);
    expect(labels(children(top[0]!))).toEqual([
      "clean",
      "validate",
      "compile",
      "test",
      "package",
      "verify",
      "install",
      "site",
      "deploy",
    ]);
    expect(nodeIcon(top[2]!)).toBe("maven-module");
    expect(nodeIcon(roots[1]!)).toBe("maven-project");
  });

  it("expands plugins to goals and dependencies to their transitive ones", () => {
    const core = children(mavenRoots(maven)[1]!)[2]!;
    const kids = children(core);
    expect(labels(kids)).toEqual(["Lifecycle", "Plugins", "Dependencies"]);
    const plugin = children(kids[1]!)[0]!;
    expect(nodeLabel(plugin)).toBe("surefire (org.apache.maven.plugins:maven-surefire-plugin:3.2.5)");
    const goals = children(plugin);
    expect(labels(goals)).toEqual(["surefire:help", "surefire:test"]);
    expect(isRunnable(goals[1]!)).toBe(true);
    const deps = children(kids[2]!);
    expect(labels(deps)).toEqual(["org.junit.jupiter:junit-jupiter:5.10.2"]);
    expect(labels(children(deps[0]!))).toEqual(["org.junit.jupiter:junit-jupiter-api:5.10.2"]);
    expect(isRunnable(deps[0]!)).toBe(false);
  });

  it("does not list Run Configurations in the tree (run configs live in Services)", () => {
    const walk = (nodes: readonly BuildNode[]): string[] =>
      nodes.flatMap((n) => [nodeLabel(n), ...walk(mavenChildren(n, maven) ?? [])]);
    expect(walk(mavenRoots(maven))).not.toContain("Run Configurations");
  });

  it("expand all opens folders but not dependency subtrees", () => {
    const keys = expandableKeys(mavenRoots(maven), (n) => mavenChildren(n, maven));
    expect(keys.has("mvn:pom.xml")).toBe(true);
    expect(keys.has("mvn:core/pom.xml:deps")).toBe(true);
    expect([...keys].some((k) => k.includes("deps/"))).toBe(false);
  });
});

describe("Maven runs", () => {
  const core = maven.projects[1]!;

  it("passes goals, offline, skip tests and changed profiles", () => {
    expect(profilesArg(maven.profiles, {})).toBeNull();
    expect(profilesArg(maven.profiles, { ci: true, dev: false })).toBe("!dev,ci");
    const config = mavenGoalConfig(core, ["clean", "test"], maven, {
      offline: true,
      skipTests: false,
      profiles: { ci: true },
    });
    expect(config).toMatchObject({
      name: "core [clean,test]",
      kind: "maven",
      command: "/p/mvnw",
      args: ["clean", "test", "-o", "-Pci"],
      cwd: "core",
      env: { JAVA_HOME: "/jdk21" },
      isTest: true,
      detected: false,
    });
    const skipped = mavenGoalConfig(core, ["test"], maven, { offline: false, skipTests: true, profiles: {} });
    expect(skipped.args).toEqual(["test", "-DskipTests"]);
    expect(skipped.isTest).toBe(false);
    const root = mavenGoalConfig(maven.projects[0]!, ["clean"], maven, {
      offline: false,
      skipTests: false,
      profiles: {},
    });
    expect(root.cwd).toBeNull();
    expect(root.isTest).toBe(false);
    // Settings › Maven options go before the goals.
    const configured = { ...core, options: ["-s", "/m2/settings.xml"] };
    expect(
      mavenGoalConfig(configured, ["test"], maven, { offline: false, skipTests: true, profiles: {} }).args,
    ).toEqual(["-s", "/m2/settings.xml", "test", "-DskipTests"]);
  });

  it("parses typed command lines", () => {
    expect(parseGoalLine("mvn clean install -Dmsg='a b'")).toEqual(["clean", "install", "-Dmsg=a b"]);
    expect(parseGoalLine("./mvnw -q verify")).toEqual(["-q", "verify"]);
    expect(parseTaskLine('./gradlew :app:run --args "x y"')).toEqual([":app:run", "--args", "x y"]);
    expect(splitArgs(`a "" 'b c'`)).toEqual(["a", "", "b c"]);
  });

  it("completes phases and plugin goals for the last word, history for the whole line", () => {
    const c = goalCompletions("clean te", [surefire], ["clean test -DskipTests"]);
    expect(c.map((x) => x.label)).toEqual(["test", "test-compile"]);
    expect(c[0]!.line).toBe("clean test");
    expect(goalCompletions("sure", [surefire]).map((x) => x.label)).toEqual(["surefire:help", "surefire:test"]);
    expect(goalCompletions("cl", [], ["clean install"]).map((x) => x.label)[0]).toBe("clean install");
    expect(goalCompletions("-D", [surefire])).toEqual([]);
  });
});

describe("Gradle tree and runs", () => {
  const gradle: GradleModel = {
    dir: "",
    projects: [
      {
        path: ":",
        name: "gradle-demo",
        dir: "",
        buildFile: "build.gradle.kts",
        tasks: [
          { name: "wrapper", group: "build setup", description: null },
          { name: "init", group: "build setup", description: null },
        ],
      },
      {
        path: ":app",
        name: "app",
        dir: "app",
        buildFile: "app/build.gradle.kts",
        tasks: [
          { name: "run", group: "application", description: "Runs this project" },
          { name: "compileJava", group: "other", description: null },
          { name: "test", group: "verification", description: null },
          { name: "build", group: "build", description: null },
        ],
      },
      { path: ":libs:core", name: "core", dir: "libs/core", buildFile: null, tasks: [] },
    ],
    javaVersion: null,
    command: "/p/gradlew",
    env: {},
    syncedAt: 1,
    stale: false,
    syncError: null,
  };
  const kids = (n: BuildNode) => gradleChildren(n, gradle) ?? [];

  it("nests subprojects and groups tasks, other last", () => {
    const roots = gradleRoots(gradle);
    expect(labels(roots)).toEqual(["gradle-demo"]);
    expect(labels(kids(roots[0]!))).toEqual(["Tasks", "app", "core"]);
    const app = kids(roots[0]!)[1]!;
    const groups = kids(kids(app)[0]!);
    expect(labels(groups)).toEqual(["application", "build", "verification", "other"]);
    expect(labels(kids(kids(kids(roots[0]!)[0]!)[0]!))).toEqual(["init", "wrapper"]);
    expect(nodeIcon(groups[0]!)).toBe("build-task-group");
  });

  it("runs tasks by path from the build directory", () => {
    const app = gradle.projects[1]!;
    const config = gradleTaskConfig(gradle, app, ["test"], { offline: true });
    expect(config).toMatchObject({
      name: "app [test]",
      kind: "gradle",
      command: "/p/gradlew",
      args: [":app:test", "--offline"],
      cwd: null,
      isTest: true,
    });
    expect(gradleTaskConfig(gradle, gradle.projects[0]!, ["wrapper"], { offline: false }).args).toEqual(["wrapper"]);
    expect(gradleTaskConfig(gradle, app, [":lib:jar", "--info"], { offline: false }).args).toEqual([
      ":lib:jar",
      "--info",
    ]);
  });

  it("completes task names and paths", () => {
    const labelsOf = taskCompletions("ru", gradle).map((c) => c.label);
    expect(labelsOf).toEqual([":app:run"]);
    expect(taskCompletions("clean wr", gradle).map((c) => c.line)).toEqual(["clean wrapper"]);
  });
});

describe("skippedTestRun", () => {
  const phaseNode = (name: string): BuildNode => ({
    kind: "phase",
    key: `mvn:p:${name}`,
    project: project({}),
    phase: name,
  });
  const surefire = {
    groupId: "org.apache.maven.plugins",
    artifactId: "maven-surefire-plugin",
    version: null,
    prefix: "surefire",
    goals: ["test"],
  } satisfies MavenPlugin;
  const goalNode = (goal: string): BuildNode => ({
    kind: "goal",
    key: `mvn:g:${goal}`,
    project: project({}),
    plugin: surefire,
    goal,
  });

  it("refuses only a pure test-phase selection while Skip Tests is on", () => {
    expect(skippedTestRun([phaseNode("test")], true)).toBe(true);
    // multi-module test selection
    expect(skippedTestRun([phaseNode("test"), phaseNode("test")], true)).toBe(true);
    // mode off runs normally
    expect(skippedTestRun([phaseNode("test")], false)).toBe(false);
    // mixed goals still build something
    expect(skippedTestRun([phaseNode("clean"), phaseNode("test")], true)).toBe(false);
    // plugin goals stay runnable
    expect(skippedTestRun([goalNode("test")], true)).toBe(false);
    // empty selection
    expect(skippedTestRun([], true)).toBe(false);
  });
});
