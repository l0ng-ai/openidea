import { describe, expect, it } from "vitest";
import type { MavenModel, MavenProject } from "@/platform/ipc";
import { mavenModuleScope, scopeToRunModule } from "./moduleScope";

function project(dir: string, artifactId: string, dependsOn: string[] = []): MavenProject {
  return {
    pom: dir ? `${dir}/pom.xml` : "pom.xml",
    dir,
    groupId: "com.example",
    artifactId,
    version: "1.0",
    packaging: "jar",
    displayName: artifactId,
    parent: null,
    modules: [],
    aggregated: true,
    plugins: [],
    dependencies: dependsOn.map((target) => ({
      groupId: "com.example",
      artifactId: target,
      version: "1.0",
      type: "jar",
      classifier: null,
      scope: "test",
      optional: false,
      children: [],
    })),
    profiles: [],
    javaVersion: 8,
    command: "mvn",
    options: [],
    env: {},
  };
}

const model = (projects: MavenProject[]): { maven: MavenModel } => ({
  maven: { projects, profiles: [], syncedAt: 0, stale: false, syncError: null },
});

/** app → web-common → core; reporting and core-extra depend on nothing shared. */
const nested = model([
  project("app", "app", ["web-common"]),
  project("web-common", "web-common", ["core"]),
  project("core", "core"),
  project("reporting", "reporting"),
  project("core-extra", "core-extra"),
]);

describe("mavenModuleScope", () => {
  it("follows module dependencies transitively", () => {
    expect(mavenModuleScope("/p", "app", nested)?.sort()).toEqual(["/p/app", "/p/core", "/p/web-common"]);
  });

  it("counts every dependency scope, so a test run keeps its test-only modules", () => {
    expect(mavenModuleScope("/p", "app", nested)).toContain("/p/core");
  });

  it("is unknown for a module the model doesn't list, or without a model", () => {
    expect(mavenModuleScope("/p", "gone", nested)).toBeNull();
    expect(mavenModuleScope("/p", "app", null)).toBeNull();
    expect(mavenModuleScope(null, "app", nested)).toBeNull();
  });

  it("ignores a linked build's projects: their folders aren't under this root", () => {
    const linked = model([
      project("app", "app", ["shared"]),
      { ...project("shared", "shared"), projectRoot: "/elsewhere" },
    ]);
    expect(mavenModuleScope("/p", "app", linked)).toEqual(["/p/app"]);
  });

  it("takes an absolute module, as imported IDEA configurations carry one", () => {
    expect(mavenModuleScope("/p", "/p/core", nested)).toEqual(["/p/core"]);
  });
});

describe("scopeToRunModule", () => {
  const hits = [
    "/p/reporting/src/main/java/com/example/Task.java",
    "/p/core/src/main/java/com/example/Task.java",
    "/p/core-extra/src/main/java/com/example/Task.java",
  ];

  it("drops copies from modules the run doesn't depend on", () => {
    expect(scopeToRunModule(hits, "/p", "core", nested)).toEqual(["/p/core/src/main/java/com/example/Task.java"]);
  });

  it("doesn't treat a folder whose name starts with the module's as the module", () => {
    expect(scopeToRunModule(["/p/core/Task.java", "/p/core-extra/Task.java"], "/p", "core", nested)).toEqual([
      "/p/core/Task.java",
    ]);
  });

  it("keeps every candidate when the scope is unknown or matches none", () => {
    expect(scopeToRunModule(hits, "/p", null, nested)).toEqual(hits);
    expect(scopeToRunModule(hits, "/p", "gone", nested)).toEqual(hits);
    expect(scopeToRunModule(["/other/Task.java"], "/p", "core", nested)).toEqual(["/other/Task.java"]);
  });
});
