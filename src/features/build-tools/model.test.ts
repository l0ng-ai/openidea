import { describe, expect, it } from "vitest";
import type { GradleModel, MavenModel, MavenProject, RunConfig } from "@/platform/ipc";
import {
  expandableKeys,
  goalCompletions,
  gradleChildren,
  gradleRoots,
  gradleRunConfigs,
  gradleProjectKey,
  gradleTaskConfig,
  isRunnable,
  mavenChildren,
  mavenGoalConfig,
  mavenRoots,
  mavenPomAtPath,
  nodeIcon,
  nodeLabel,
  parseGoalLine,
  parseTaskLine,
  profilesArg,
  splitArgs,
  taskCompletions,
  withGradleOptions,
  gradleHasTestTask,
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

const runConfig = (over: Partial<RunConfig>): RunConfig => ({
  id: "x",
  name: "x",
  kind: "maven",
  command: "mvn",
  args: [],
  cwd: null,
  env: {},
  detected: true,
  isTest: false,
  debugAdapter: null,
  ...over,
});

const children = (n: BuildNode) => mavenChildren(n, maven, []) ?? [];
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

  it("lists the project's maven run configurations", () => {
    const configs = [
      runConfig({ id: "a", name: "core [test]", cwd: "core", detected: false }),
      runConfig({ id: "b", name: "root", cwd: null }),
      runConfig({ id: "c", kind: "npm", cwd: "core" }),
    ];
    const top = mavenChildren(mavenRoots(maven)[1]!, maven, configs)!;
    expect(labels(top)).toEqual(["Lifecycle", "Plugins", "Run Configurations", "core", "Demo App"]);
    expect(labels(mavenChildren(top[2]!, maven, configs)!)).toEqual(["root"]);
    const runs = mavenChildren(top[3]!, maven, configs)!.find((n) => n.kind === "runConfigs")!;
    expect(labels(mavenChildren(runs, maven, configs)!)).toEqual(["core [test]"]);
  });

  it("expand all opens folders but not dependency subtrees", () => {
    const keys = expandableKeys(mavenRoots(maven), (n) => mavenChildren(n, maven, []));
    expect(keys.has("mvn:pom.xml")).toBe(true);
    expect(keys.has("mvn:core/pom.xml:deps")).toBe(true);
    expect([...keys].some((k) => k.includes("deps/"))).toBe(false);
  });
});

describe("Maven runs", () => {
  const core = maven.projects[1]!;

  it.each([["-P", "prod"], ["-Pprod"], ["--activate-profiles", "prod"], ["--activate-profiles=prod"]])(
    "keeps explicit Maven profiles %j",
    (...profiles) => {
      const goals = ["test", ...profiles];
      const config = mavenGoalConfig(core, goals, maven, {
        offline: false,
        skipTests: false,
        profiles: { ci: true, dev: false },
      });
      expect(config.args).toEqual(goals);
    },
  );

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
      env: {},
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
    const external = mavenGoalConfig(
      project({
        pom: "/code/B/pom.xml",
        dir: "/code/B",
        artifactId: "b",
        displayName: "b",
        command: "/code/B/mvnw",
      }),
      ["compile"],
      maven,
      { offline: false, skipTests: false, profiles: {} },
    );
    expect(external).toMatchObject({ command: "/code/B/mvnw", cwd: "/code/B", args: ["compile"] });
    const configured = {
      ...core,
      command: "//?/UNC/server/share/maven/bin/mvn.cmd",
      options: ["-s", "/old/settings.xml", "-Dmaven.repo.local=/old/repository"],
    };
    const goal = mavenGoalConfig(configured, ["test"], maven, {
      offline: false,
      skipTests: true,
      profiles: {},
    });
    expect(goal.command).toBe("mvn");
    expect(goal.args).toEqual(["test", "-DskipTests"]);
    expect(
      mavenGoalConfig(configured, ["-s", "/own/settings.xml", "test"], maven, {
        offline: false,
        skipTests: false,
        profiles: {},
      }).args,
    ).toEqual(["-s", "/own/settings.xml", "test"]);
  });

  // #2433: the model's `JAVA_HOME` is Settings-derived; freezing it in the configuration kept an
  // outdated runner JRE even after the setting was corrected (also across a restart, since a
  // temporary configuration persisted it). The launcher resolves it from Settings instead.
  it("does not freeze the settings-derived JAVA_HOME into a generated configuration", () => {
    expect(core.env).toEqual({ JAVA_HOME: "/jdk21" });
    const goal = mavenGoalConfig(core, ["compile"], maven, { offline: false, skipTests: false, profiles: {} });
    expect(goal.env).toEqual({});
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
    expect(goalCompletions("mvn clean test ", [surefire]).map((x) => x.label)).not.toContain("test");
    expect(goalCompletions("clean c", []).map((x) => x.label)).not.toContain("clean");
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
  const kids = (n: BuildNode) =>
    gradleChildren(n, [gradle], [runConfig({ id: "g", name: "app [run]", kind: "gradle" })]) ?? [];

  it("nests subprojects and groups tasks, other last", () => {
    const roots = gradleRoots([gradle]);
    expect(labels(roots)).toEqual(["gradle-demo"]);
    expect(labels(kids(roots[0]!))).toEqual(["Tasks", "Run Configurations", "app", "core"]);
    const app = kids(roots[0]!)[2]!;
    const groups = kids(kids(app)[0]!);
    expect(labels(groups)).toEqual(["application", "build", "verification", "other"]);
    expect(labels(kids(kids(kids(roots[0]!)[0]!)[0]!))).toEqual(["init", "wrapper"]);
    expect(nodeIcon(groups[0]!)).toBe("build-task-group");
  });

  it("runs tasks by path from the build directory", () => {
    const app = gradle.projects[1]!;
    const config = gradleTaskConfig(gradle, app, ["test"], { offline: true, skipTests: false });
    expect(config).toMatchObject({
      name: "app [test]",
      kind: "gradle",
      command: "/p/gradlew",
      args: [":app:test", "--offline"],
      cwd: null,
      // The build model's `JAVA_HOME` comes from Settings; a task must not freeze it (#2433).
      env: {},
      isTest: true,
    });
    expect(
      gradleTaskConfig(gradle, gradle.projects[0]!, ["wrapper"], { offline: false, skipTests: false }).args,
    ).toEqual(["wrapper"]);
    expect(gradleTaskConfig(gradle, app, [":lib:jar", "--info"], { offline: false, skipTests: false }).args).toEqual([
      ":lib:jar",
      "--info",
    ]);
  });

  it("appends -x test to task runs when Skip Tests is on", () => {
    const app = gradle.projects[1]!;
    const skipped = gradleTaskConfig(gradle, app, ["build"], { offline: false, skipTests: true });
    expect(skipped.args).toEqual([":app:build", "-x", "test"]);
    // Running `test` with Skip Tests on is not a test run for the Run window.
    const test = gradleTaskConfig(gradle, app, ["test"], { offline: false, skipTests: true });
    expect(test.args).toEqual([":app:test", "-x", "test"]);
    expect(test.isTest).toBe(false);
    // A command line that already excludes tests is not changed again (typed task names keep
    // the pre-existing project-path prefix).
    const explicit = gradleTaskConfig(gradle, app, ["build", "-x", "test"], { offline: false, skipTests: true });
    expect(explicit.args).toEqual([":app:build", "-x", ":app:test"]);
    const verbose = gradleTaskConfig(gradle, app, ["build", "--exclude-task", "test"], {
      offline: false,
      skipTests: true,
    });
    expect(verbose.args).toEqual([":app:build", "--exclude-task", ":app:test"]);
    // A build without a `test` task would fail on `-x test`.
    const noTests = {
      ...gradle,
      projects: gradle.projects.map((p) => ({ ...p, tasks: p.tasks.filter((t) => t.name !== "test") })),
    };
    expect(gradleHasTestTask([noTests])).toBe(false);
    expect(
      gradleTaskConfig(noTests, noTests.projects[1]!, ["build"], { offline: false, skipTests: true }).args,
    ).toEqual([":app:build"]);
  });

  it("applies the toolbar toggles to saved configurations started from the tree", () => {
    const saved = runConfig({ id: "g", name: "app [build]", kind: "gradle", args: ["build"] });
    expect(withGradleOptions(saved, { offline: false, skipTests: false }).args).toEqual(["build"]);
    expect(withGradleOptions(saved, { offline: true, skipTests: false }).args).toEqual(["build", "--offline"]);
    expect(withGradleOptions(saved, { offline: true, skipTests: true }).args).toEqual([
      "build",
      "--offline",
      "-x",
      "test",
    ]);
    const excluding = withGradleOptions(runConfig({ ...saved, args: ["build", "-x", "test"] }), {
      offline: false,
      skipTests: true,
    });
    expect(excluding.args).toEqual(["build", "-x", "test"]);
    expect(withGradleOptions(saved, { offline: false, skipTests: true }, false).args).toEqual(["build"]);
  });

  it("keeps identical project paths and tasks of independent builds distinct", () => {
    const builds = ["first", "second"].map((dir) => ({
      ...gradle,
      dir,
      command: `/p/${dir}/gradlew`,
      env: { JAVA_HOME: `/${dir}/jdk` },
      projects: gradle.projects.map((p) => ({ ...p, dir: `${dir}/${p.dir}`.replace(/\/$/, "") })),
    }));
    const roots = gradleRoots(builds);
    expect(new Set(roots.map((n) => n.key)).size).toBe(2);
    const tasks = roots.map((r) => {
      const app = gradleChildren(r, builds, [])!.find((n) => n.kind === "gradleProject" && n.project.path === ":app")!;
      const folder = gradleChildren(app, builds, [])![0]!;
      const group = gradleChildren(folder, builds, [])!.find(
        (n) => n.kind === "taskGroup" && n.group === "verification",
      )!;
      return gradleChildren(group, builds, [])![0]!;
    });
    expect(tasks[0]!.key).not.toBe(tasks[1]!.key);
    const runs = builds.map((b) => gradleTaskConfig(b, b.projects[1]!, ["test"], { offline: true, skipTests: false }));
    expect(runs[0]!.id).not.toBe(runs[1]!.id);
    expect(runs[1]).toMatchObject({
      command: "/p/second/gradlew",
      cwd: "second",
      // The build's `JAVA_HOME` is Settings-derived and stays out of the configuration (#2433).
      env: {},
      args: [":app:test", "--offline"],
    });
    expect(gradleProjectKey(builds[1]!, builds[1]!.projects[1]!)).toBe('gradle:["second",":app"]');
  });

  it("shows run configurations only under their owning linked build", () => {
    const nested = {
      ...gradle,
      dir: "nested",
      projects: gradle.projects.map((p) => ({ ...p, dir: `nested/${p.dir}` })),
    };
    const configs = [
      runConfig({ id: "root", kind: "gradle", cwd: "app" }),
      runConfig({ id: "nested", kind: "gradle", cwd: "nested/app" }),
      runConfig({ id: "absolute", kind: "gradle", cwd: "/p/nested/app" }),
      runConfig({ id: "other", kind: "maven", cwd: "nested" }),
    ];
    expect(gradleRunConfigs(gradle, [gradle, nested], configs, "/p").map((c) => c.id)).toEqual(["root"]);
    expect(gradleRunConfigs(nested, [gradle, nested], configs, "/p").map((c) => c.id)).toEqual(["nested", "absolute"]);
  });

  it("places a saved run under its directly linked root instead of a longer sibling composite", () => {
    const composite = {
      ...gradle,
      dir: "very-long-composite",
      projects: [{ ...gradle.projects[1]!, path: ":b:app", dir: "b/app", build: ":b" }],
    };
    const direct = { ...gradle, dir: "b", projects: [{ ...gradle.projects[1]!, dir: "b/app" }] };
    const saved = runConfig({ id: "saved", kind: "gradle", cwd: "b/app" });
    const builds = [composite, direct];
    expect(gradleRunConfigs(composite, builds, [saved], "/p")).toEqual([]);
    expect(gradleRunConfigs(direct, builds, [saved], "/p")).toEqual([saved]);
  });

  it("completes task names and paths", () => {
    const labelsOf = taskCompletions("ru", gradle).map((c) => c.label);
    expect(labelsOf).toEqual([":app:run"]);
    expect(taskCompletions("clean wr", gradle).map((c) => c.line)).toEqual(["clean wrapper"]);
    expect(taskCompletions("wrapper wr", gradle)).toEqual([]);
    expect(taskCompletions(":app:run ", gradle).map((c) => c.label)).not.toContain(":app:run");
  });
});

it.each([
  ["pom.xml", "/workspace/pom.xml"],
  ["module/pom.xml", "/workspace/module/pom.xml"],
  ["/linked/pom.xml", "/linked/pom.xml"],
  ["/workspace/member/pom.xml", "/workspace/member/pom.xml"],
])("resolves the Maven model POM %s at %s", (pom, path) => {
  const projects = [project({ pom })];
  expect(mavenPomAtPath(projects, "/workspace", path)).toBe(pom);
  expect(mavenPomAtPath(projects, "/workspace", "/other/pom.xml")).toBeNull();
});
