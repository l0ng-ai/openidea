import { describe, expect, it } from "vitest";
import type { RunConfig, SbtBuild } from "@/platform/ipc";
import { sbtChildren, sbtLabel, sbtNodeConfig, sbtRoots, sbtTaskConfig, type SbtNode } from "./sbt";

const build: SbtBuild = {
  dir: "",
  command: "sbt",
  version: "1.10.7",
  projects: [
    { id: "root", dir: "", root: true },
    { id: "core", dir: "core", root: false },
    { id: "web-app", dir: "modules/web", root: false },
  ],
};

const saved = (cwd: string | null, kind = "sbt"): RunConfig => ({
  id: `c-${kind}-${cwd}`,
  name: "sbt run",
  kind,
  command: "sbt",
  args: ["run"],
  cwd,
  env: {},
  detected: true,
  isTest: false,
  debugAdapter: null,
});

const labels = (nodes: SbtNode[] | undefined) => nodes?.map(sbtLabel);

describe("sbt tree", () => {
  it("lists the root project with its tasks, run configurations and the other projects", () => {
    const [root] = sbtRoots([build]);
    const kids = sbtChildren(root!, [saved(null), saved("other"), saved(null, "gradle")]);
    expect(labels(kids)).toEqual(["Tasks", "Run Configurations", "core", "web-app"]);
    expect(labels(sbtChildren(kids![1]!, []))).toEqual(["sbt run"]);
    expect(labels(sbtChildren(kids![0]!, []))).toContain("compile");
    // A subproject has only its tasks.
    expect(labels(sbtChildren(kids![2]!, []))).toEqual(["Tasks"]);
    expect(labels(sbtChildren(root!, []))).toEqual(["Tasks", "core", "web-app"]);
  });

  it("runs root tasks unscoped and other projects' tasks scoped, several in one invocation", () => {
    expect(sbtTaskConfig(build, build.projects[0]!, ["test"])).toMatchObject({
      kind: "sbt",
      command: "sbt",
      args: ["test"],
      cwd: null,
      isTest: true,
    });
    const [root] = sbtRoots([{ ...build, dir: "svc", command: "./sbt" }]);
    const web = sbtChildren(root!, [])!.find((n) => sbtLabel(n) === "web-app")!;
    const tasks = sbtChildren(sbtChildren(web, [])![0]!, [])!;
    const config = sbtNodeConfig(tasks.filter((t) => ["clean", "package"].includes(sbtLabel(t))));
    expect(config).toMatchObject({
      name: "web-app [clean,package]",
      command: "./sbt",
      args: ["web-app/clean", "web-app/package"],
      cwd: "svc",
      isTest: false,
    });
  });
});
