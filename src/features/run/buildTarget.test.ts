import { describe, expect, it } from "vitest";
import type { GradleModel, RunConfig } from "@/platform/ipc";
import { selectedBuildTarget } from "./buildTarget";

const cfg = (overrides: Partial<RunConfig>): RunConfig => ({
  id: "id",
  name: "App",
  kind: "application",
  command: "java",
  args: [],
  cwd: null,
  env: {},
  detected: true,
  isTest: false,
  debugAdapter: null,
  ...overrides,
});

const GRADLE: GradleModel = {
  dir: "",
  command: "./gradlew",
  env: {},
  javaVersion: null,
  projects: [
    { path: ":", name: "root", dir: "", buildFile: "build.gradle.kts", tasks: [] },
    { path: ":services:api", name: "api", dir: "services/api", buildFile: "services/api/build.gradle.kts", tasks: [] },
  ],
  syncedAt: null,
  syncError: null,
  stale: false,
};

describe("selectedBuildTarget", () => {
  it("resolves Java and Spring Boot application modules against the project root", () => {
    const sub = cfg({ name: "App", kind: "application", module: "fixtures/java-app" });
    expect(selectedBuildTarget(sub, [sub], "/repo")).toEqual({
      cmake: null,
      target: "/repo/fixtures/java-app",
      name: "App",
    });

    const rootApp = cfg({ name: "BootApp", kind: "spring-boot", module: "" });
    expect(selectedBuildTarget(rootApp, [rootApp], "/repo")).toEqual({
      cmake: null,
      target: "/repo",
      name: "BootApp",
    });

    const external = cfg({ name: "Sibling", kind: "application", module: "/ws/member-a" });
    expect(selectedBuildTarget(external, [external], "/ws")).toEqual({
      cmake: null,
      target: "/ws/member-a",
      name: "Sibling",
    });

    const legacy = cfg({ name: "Legacy", kind: "application", module: undefined, cwd: null });
    expect(selectedBuildTarget(legacy, [legacy], "/repo")).toEqual({
      cmake: null,
      target: null,
      name: null,
    });
  });

  it("resolves Maven, Gradle, JUnit, Tomcat, Cargo, Go, and .NET targets", () => {
    const mavenPl = cfg({ name: "mvn api", kind: "maven", cwd: null, args: ["-pl", "services/api", "test"] });
    expect(selectedBuildTarget(mavenPl, [mavenPl], "/repo")).toEqual({
      cmake: null,
      target: "/repo/services/api",
      name: "mvn api",
    });

    const mavenRoot = cfg({ name: "mvn package", kind: "maven", cwd: null, args: ["package"] });
    expect(selectedBuildTarget(mavenRoot, [mavenRoot], "/repo")).toEqual({
      cmake: null,
      target: "/repo",
      name: "mvn package",
    });

    const gradleTask = cfg({ name: "api tests", kind: "gradle", cwd: null, args: [":services:api:test"] });
    expect(selectedBuildTarget(gradleTask, [gradleTask], "/repo", [GRADLE])).toEqual({
      cmake: null,
      target: "/repo/services/api",
      name: "api tests",
    });

    const gradleSub = cfg({ name: "gradle run", kind: "gradle", cwd: "fixtures/kotlin-gradle", args: ["run"] });
    expect(selectedBuildTarget(gradleSub, [gradleSub], "/repo")).toEqual({
      cmake: null,
      target: "/repo/fixtures/kotlin-gradle",
      name: "gradle run",
    });

    const junitRoot = cfg({ name: "AppTest", kind: "junit", params: { module: "." } });
    expect(selectedBuildTarget(junitRoot, [junitRoot], "/repo")).toEqual({
      cmake: null,
      target: "/repo",
      name: "AppTest",
    });

    const tomcat = cfg({ name: "Tomcat", kind: "tomcat", cwd: "web" });
    expect(selectedBuildTarget(tomcat, [tomcat], "/repo")).toEqual({
      cmake: null,
      target: "/repo/web",
      name: "Tomcat",
    });

    const dotnet = cfg({ name: "WebApi", kind: "dotnet", params: { project: "src/WebApi/WebApi.csproj" } });
    expect(selectedBuildTarget(dotnet, [dotnet], "/repo")).toEqual({
      cmake: null,
      target: "/repo/src/WebApi/WebApi.csproj",
      name: "WebApi",
    });

    const cargo = cfg({ name: "cargo run", kind: "cargo", cwd: "crates/cli" });
    expect(selectedBuildTarget(cargo, [cargo], "/repo")).toEqual({
      cmake: null,
      target: "/repo/crates/cli",
      name: "cargo run",
    });

    const go = cfg({ name: "go run", kind: "go", cwd: "cmd/server" });
    expect(selectedBuildTarget(go, [go], "/repo")).toEqual({
      cmake: null,
      target: "/repo/cmd/server",
      name: "go run",
    });
  });

  it("keeps CMake target resolution and hides script configurations", () => {
    const build = cfg({
      id: "cmake:release:hello:build",
      name: "Build hello",
      kind: "cmake",
      command: "cmake",
      args: ["--build", "release", "--target", "hello"],
    });
    const app = cfg({
      id: "cmake:release:hello",
      name: "hello [Release]",
      kind: "cmake-application",
      beforeLaunch: [{ kind: "build", target: build.id }],
    });
    expect(selectedBuildTarget(app, [build, app], "/repo")).toEqual({
      cmake: build.id,
      target: null,
      name: "hello [Release]",
    });
    expect(selectedBuildTarget(undefined, [build, app], "/repo")).toEqual({
      cmake: build.id,
      target: null,
      name: null,
    });

    const script = cfg({ name: "dev", kind: "npm", command: "pnpm", args: ["dev"] });
    expect(selectedBuildTarget(script, [script], "/repo")).toEqual({
      cmake: null,
      target: null,
      name: null,
    });
  });
});
