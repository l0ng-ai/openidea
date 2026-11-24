import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDotnet,
  cancelDotnet,
  discoveredTests,
  packageList,
  reloadDotnet,
  resetDotnet,
  selectDotnet,
  useDotnet,
} from "./store";
import * as platform from "@/platform/dotnet";
import { useProject } from "@/platform/project";

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

describe("reloading a .NET workspace", () => {
  const path = "/repo/Test.csproj";
  const project: platform.DotnetProject = {
    path,
    name: "Test",
    frameworks: ["net8.0", "net9.0"],
    configurations: ["Debug", "Release"],
    references: [],
    packages: [],
    test: true,
    runner: "vstest",
    adapter: "mstest",
    trx: false,
  };
  const previousProject = useProject.getState().project;

  beforeEach(() => {
    useProject.setState({ project: { root: "/repo" } as NonNullable<typeof previousProject> });
    useDotnet.setState({ selected: path, configuration: "Release", framework: "net9.0" });
  });

  afterEach(() => useProject.setState({ project: previousProject }));

  it("preserves the project, configuration and framework and evaluates that selection", async () => {
    const first = { ...project, path: "/repo/A.csproj" };
    const release = { ...project, frameworks: ["net10.0", "net9.0"] };
    const selected = { ...release, packages: [{ id: "ReleaseOnly", version: "1.0" }] };
    vi.spyOn(platform, "dotnetWorkspace").mockResolvedValue({ projects: [first, project], solutions: [] });
    const evaluate = vi
      .spyOn(platform, "evaluateProject")
      .mockImplementation(async (_path, _config, framework) => (framework === "net9.0" ? selected : release));
    const command = vi.spyOn(platform, "dotnet").mockResolvedValue("");

    await reloadDotnet();

    expect(useDotnet.getState()).toMatchObject({
      selected: path,
      configuration: "Release",
      framework: "net9.0",
      model: { projects: [first, selected] },
    });
    expect(evaluate).toHaveBeenLastCalledWith(path, "Release", "net9.0", expect.any(AbortSignal));
    await buildDotnet("build");
    expect(command).toHaveBeenCalledWith(
      ["build", path, "--configuration", "Release", "--framework", "net9.0"],
      "/repo",
      expect.any(AbortSignal),
    );
  });

  it("uses a supported configuration and framework when the saved choices were removed", async () => {
    const updated = { ...project, configurations: ["Profile"], frameworks: ["net10.0"] };
    vi.spyOn(platform, "dotnetWorkspace").mockResolvedValue({ projects: [updated], solutions: [] });
    const evaluate = vi.spyOn(platform, "evaluateProject").mockResolvedValue(updated);

    await reloadDotnet();

    expect(useDotnet.getState()).toMatchObject({ selected: path, configuration: "Profile", framework: "net10.0" });
    expect(evaluate).toHaveBeenCalledWith(path, "Profile", "", expect.any(AbortSignal));
  });

  it("keeps a supported configuration when its previously selected framework is removed", async () => {
    const release = { ...project, frameworks: ["net10.0"] };
    vi.spyOn(platform, "dotnetWorkspace").mockResolvedValue({ projects: [project], solutions: [] });
    vi.spyOn(platform, "evaluateProject").mockResolvedValue(release);

    await reloadDotnet();

    expect(useDotnet.getState()).toMatchObject({ selected: path, configuration: "Release", framework: "net10.0" });
  });

  it("uses the remaining project's defaults when the selected project is removed", async () => {
    const remaining = { ...project, path: "/repo/Remaining.csproj" };
    vi.spyOn(platform, "dotnetWorkspace").mockResolvedValue({ projects: [remaining], solutions: [] });
    const evaluate = vi.spyOn(platform, "evaluateProject");

    await reloadDotnet();

    expect(useDotnet.getState()).toMatchObject({
      selected: remaining.path,
      configuration: "Debug",
      framework: "net8.0",
    });
    expect(evaluate).not.toHaveBeenCalled();
  });
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
