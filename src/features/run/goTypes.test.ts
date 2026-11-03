import { describe, expect, it } from "vitest";
import { goBuildType, goTestType } from "./goTypes";
import { formParams, newConfigOfType, withParams } from "./types";

describe("Go configurations", () => {
  it("keeps build arguments and program arguments separate and persists the argv", () => {
    const c = newConfigOfType(goBuildType, []);
    const edited = withParams(
      c,
      {
        ...c.params,
        target: "./cmd/app",
        toolArgs: '-tags "demo other" -race',
        programArgs: 'hello "two words"',
        module: "app",
      },
      goBuildType,
    );
    expect(edited.args).toEqual(["build", "-tags", "demo other", "-race", "./cmd/app"]);
    expect(JSON.parse(edited.params!.programArgv!)).toEqual(["hello", "two words"]);
    expect(edited.isTest).toBe(false);
  });
  it("test configs use the existing Go kind and put test-binary flags after -args", () => {
    const c = newConfigOfType(goTestType, []);
    const test = withParams(
      c,
      { ...c.params, pattern: "^TestOne$", toolArgs: "-race", programArgs: "-test.short" },
      goBuildType,
    );
    expect(test.kind).toBe("go");
    expect(test.isTest).toBe(true);
    expect(test.args).toEqual(["test", "-race", "-run", "^TestOne$", ".", "-args", "-test.short"]);
  });
  it("offers existing detected configs the form without rewriting old saved command lines", () => {
    const c = { ...newConfigOfType(goBuildType, []), params: {}, args: ["run", "."] };
    expect(formParams(c, goBuildType)).toMatchObject({ goKind: "build", runAfterBuild: "true", target: "." });
    expect(c.args).toEqual(["run", "."]);
    expect(formParams({ ...c, args: ["run", "-tags", "old", "."] }, goBuildType)).toBeNull();
  });
});
