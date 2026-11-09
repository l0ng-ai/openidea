import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelDotnet, discoveredTests, packageList, selectDotnet, resetDotnet, useDotnet } from "./store";
import * as platform from "@/platform/dotnet";

afterEach(() => {
  resetDotnet();
  vi.restoreAllMocks();
});

it("recovers a project that failed the initial workspace scan", async () => {
  const project: platform.DotnetProject = {
    path: "/repo/Test.csproj",
    name: "Test",
    frameworks: ["net9.0"],
    configurations: ["Debug"],
    references: [],
    packages: [],
    test: true,
    runner: "vstest",
    adapter: "mstest",
    trx: false,
  };
  vi.spyOn(platform, "evaluateProject").mockResolvedValue(project);
  useDotnet.setState({ model: { projects: [], solutions: [], errors: [`${project.path}: failed`] } });
  await selectDotnet(project.path);
  expect(useDotnet.getState().model).toEqual({ projects: [project], solutions: [], errors: [] });
});

it("ignores an evaluation completed after switching workspaces", async () => {
  let complete!: (p: platform.DotnetProject) => void;
  vi.spyOn(platform, "evaluateProject").mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const pending = selectDotnet("/repo/Test.csproj");
  resetDotnet();
  complete({ path: "/repo/Test.csproj", frameworks: ["net9.0"] } as platform.DotnetProject);
  await pending;
  expect(useDotnet.getState().selected).toBe("");
  expect(useDotnet.getState().busy).toBe(false);
});

it("ignores an evaluation completed after cancellation", async () => {
  let complete!: (p: platform.DotnetProject) => void;
  vi.spyOn(platform, "evaluateProject").mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const pending = selectDotnet("/repo/Test.csproj");
  cancelDotnet();
  complete({ path: "/repo/Test.csproj", frameworks: ["net9.0"] } as platform.DotnetProject);
  await pending;
  expect(useDotnet.getState().selected).toBe("");
  expect(useDotnet.getState().busy).toBe(false);
  expect(useDotnet.getState().error).toBe("");
});

describe("real dotnet discovery output", () => {
  it.each([
    "The following Tests are available:\n    Passes\n    Parameterized (1)\n\nProcess finished with exit code 0",
    "The following Tests are available:\nPasses\nParameterized (1)\nTests succeeded: 'Tests.dll' [net9.0|x64]",
    "Discovering tests from Tests.dll (net10.0|x64)\nDiscovered 2 tests in assembly - Tests.dll (net10.0|x64)\n  Passes\n  Parameterized (1)\n\nDiscovered 2 tests.",
  ])("extracts names without host and runner summaries", (output) => {
    expect(discoveredTests(output)).toEqual(["Passes", "Parameterized (1)"]);
  });
  it("merges target frameworks and assemblies without duplicating names", () => {
    expect(
      discoveredTests(
        "The following Tests are available:\n    A.Tests.One\n\nThe following Tests are available:\n    A.Tests.One\n    B.Tests.Two\n",
      ),
    ).toEqual(["A.Tests.One", "B.Tests.Two"]);
  });
  it("keeps direct and transitive dependencies across frameworks", () => {
    expect(
      packageList({
        projects: [
          {
            frameworks: [
              {
                topLevelPackages: [{ id: "Direct", resolvedVersion: "1.0" }],
                transitivePackages: [{ id: "Child", resolvedVersion: "2.0" }],
              },
              { transitivePackages: [{ id: "Direct", resolvedVersion: "1.0" }] },
            ],
          },
        ],
      }),
    ).toEqual([
      { id: "Direct", version: "1.0", transitive: false, latest: undefined },
      { id: "Child", version: "2.0", transitive: true, latest: undefined },
    ]);
  });
});
