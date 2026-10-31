import { describe, expect, it } from "vitest";
import { goModuleCommand, goModuleMenu } from "./goActions";

describe("Go module commands", () => {
  it("runs module operations from the selected manifest directory", () => {
    for (const operation of ["tidy", "download"] as const) {
      expect(goModuleCommand(operation, "/work/app/go.mod")).toMatchObject({
        kind: "go",
        command: "go",
        args: ["mod", operation],
        cwd: "/work/app",
        isTest: false,
      });
    }
    expect(goModuleCommand("sync", "/work/go.work")?.args).toEqual(["work", "sync"]);
    expect(goModuleCommand("use", "/work/go.work", "./module with spaces")?.args).toEqual([
      "work",
      "use",
      "--",
      "./module with spaces",
    ]);
  });
  it("does not reinterpret invalid manifests, missing directories or NULs", () => {
    expect(goModuleCommand("tidy", "/work/go.work")).toBeNull();
    expect(goModuleCommand("sync", "/work/go.mod")).toBeNull();
    expect(goModuleCommand("use", "/work/go.work")).toBeNull();
    expect(goModuleCommand("use", "/work/go.work", "x\0y")).toBeNull();
  });
  it("contributes stable action ids only to applicable manifest menus", () => {
    expect(goModuleMenu({ paths: ["/p/go.mod"] }).map((m) => m.action)).toEqual(["go.mod.tidy", "go.mod.download"]);
    expect(goModuleMenu({ paths: ["/p/go.work"] }).map((m) => m.action)).toEqual(["go.work.sync", "go.work.use"]);
    expect(goModuleMenu({ paths: ["/p/go.work", "/p/go.mod"] })).toEqual([]);
    expect(goModuleMenu({ paths: ["/p/main.go"] })).toEqual([]);
  });
});
