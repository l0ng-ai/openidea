import { describe, expect, it } from "vitest";
import { goGenerateConfig, goGenerateMenu } from "./goGenerate";
import { detectRunTargets } from "./targets";
import { OPTIMISTIC, produceContext, produceContextChoices } from "./producers";
import { formParams } from "./types";
import { goBuildType } from "./goTypes";

const path = "/work/app/tools/generate.go";

describe("Go generate", () => {
  it("runs files and packages in their own directory without shell interpretation", () => {
    const file = goGenerateConfig(path, "file")!;
    expect(file).toMatchObject({
      command: "go",
      args: ["generate", "generate.go"],
      cwd: "/work/app/tools",
      isTest: false,
      debugAdapter: null,
    });
    expect(goGenerateConfig(path, "package")?.args).toEqual(["generate", "."]);
    expect(goGenerateConfig("/work/app/-name.go", "file")?.args).toEqual(["generate", "./-name.go"]);
    expect(formParams(file, goBuildType)).toBeNull();
    expect(goGenerateConfig("/work/app/go.mod", "file")).toBeNull();
  });
  it("recognizes real directives in non-main packages and narrows the command to their literal line", () => {
    const content =
      "package tools\n//go:generate go run gen.go -out=$GOFILE\nfunc helper() {}\n// go:generate ignored\n//go:generate   \n";
    const targets = detectRunTargets(content, "tools/generate.go");
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ kind: "generate", line: 1 });
    const input = { path, root: "/work/app", configs: [], content, line: 1 };
    const result = produceContext(input, OPTIMISTIC)!;
    expect(result.config?.args).toEqual([
      "generate",
      "-run",
      "^//go:generate go run gen\\.go -out=\\$GOFILE$",
      "generate.go",
    ]);
    expect(result.config?.isTest).toBe(false);
    expect(produceContext({ ...input, line: 2 }, OPTIMISTIC)).toBeNull();
    const testBase = { ...goGenerateConfig(path, "file")!, id: "go:test", isTest: true, args: ["test", "./..."] };
    expect(
      produceContextChoices({ ...input, configs: [testBase, { ...testBase, id: "go:other" }] }, OPTIMISTIC),
    ).toHaveLength(1);
  });
  it("adds file and package actions only for a single Go source file", () => {
    expect(goGenerateMenu({ paths: [path] }).map((m) => m.action)).toEqual(["go.generate.file", "go.generate.package"]);
    expect(goGenerateMenu({ paths: [path, "/work/other.go"] })).toEqual([]);
    expect(goGenerateMenu({ paths: ["/work/app/go.mod"] })).toEqual([]);
  });
});
