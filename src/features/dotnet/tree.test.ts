import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as platform from "@/platform/dotnet";
import { useProject } from "@/platform/project";
import { useProjectViewRoots } from "@/workbench/contributions";
import { reloadDotnet, resetDotnet, useDotnet } from "./store";
import { activateTree } from "./tree";

const project = (path: string, name: string): platform.DotnetProject => ({
  path,
  name,
  frameworks: ["net9.0"],
  configurations: ["Debug"],
  references: [],
  packages: [],
  test: false,
  runner: "vstest",
  adapter: "mstest",
  trx: false,
});

describe("the .NET solution tree", () => {
  const previousProject = useProject.getState().project;
  let dispose = () => {};

  beforeEach(() => {
    useProject.setState({ project: { root: "/repo" } as NonNullable<typeof previousProject> });
  });
  afterEach(() => {
    dispose();
    resetDotnet();
    useProject.setState({ project: previousProject });
    vi.restoreAllMocks();
  });

  const rootIds = () => [...useProjectViewRoots.getState().roots.keys()];

  it("registers one solution group per solution with a leaf per project", async () => {
    vi.spyOn(platform, "dotnetWorkspace").mockResolvedValue({
      projects: [
        project("/repo/src/App/App.csproj", "App"),
        project("/repo/tests/App.Tests/App.Tests.csproj", "App.Tests"),
      ],
      solutions: [
        {
          path: "/repo/App.sln",
          projects: ["/repo/src/App/App.csproj", "/repo/tests/App.Tests/App.Tests.csproj"],
        },
      ],
    });
    dispose = activateTree();
    await vi.waitFor(() => expect(rootIds()).toContain("dotnetSolution:/repo/App.sln"));
    const solution = useProjectViewRoots.getState().roots.get("dotnetSolution:/repo/App.sln")!;
    expect([solution.label, solution.icon, solution.beforeProject]).toEqual(["Solution 'App'", "project-dotnet", true]);
    expect(solution.children?.map((c) => [c.label, c.path, c.file])).toEqual([
      ["App", "/repo/src/App/App.csproj", true],
      ["App.Tests", "/repo/tests/App.Tests/App.Tests.csproj", true],
    ]);
  });

  it("registers standalone projects as file roots of their own", async () => {
    vi.spyOn(platform, "dotnetWorkspace").mockResolvedValue({
      projects: [project("/repo/App/App.csproj", "App")],
      solutions: [],
    });
    dispose = activateTree();
    await vi.waitFor(() => expect(rootIds()).toContain("dotnetProject:/repo/App/App.csproj"));
    const alone = useProjectViewRoots.getState().roots.get("dotnetProject:/repo/App/App.csproj")!;
    expect([alone.label, alone.path, alone.file, alone.beforeProject]).toEqual([
      "App",
      "/repo/App/App.csproj",
      true,
      true,
    ]);
    expect(alone.children).toBeUndefined();
  });

  it("registers nothing while the workspace model is empty", async () => {
    vi.spyOn(platform, "dotnetWorkspace").mockResolvedValue({ projects: [], solutions: [] });
    dispose = activateTree();
    await vi.waitFor(() => expect(useDotnet.getState().busy).toBe(false));
    expect(rootIds().some((id) => id.startsWith("dotnetSolution:") || id.startsWith("dotnetProject:"))).toBe(false);
  });

  it("re-registers in place when the model changes", async () => {
    const scan = vi.spyOn(platform, "dotnetWorkspace").mockResolvedValue({
      projects: [project("/repo/src/App/App.csproj", "App")],
      solutions: [{ path: "/repo/App.sln", projects: ["/repo/src/App/App.csproj"] }],
    });
    dispose = activateTree();
    await vi.waitFor(() => expect(rootIds()).toContain("dotnetSolution:/repo/App.sln"));
    scan.mockResolvedValue({
      projects: [project("/repo/src/App/App.csproj", "App"), project("/repo/lib/Lib/Lib.csproj", "Lib")],
      solutions: [{ path: "/repo/App.sln", projects: ["/repo/src/App/App.csproj", "/repo/lib/Lib/Lib.csproj"] }],
    });
    await reloadDotnet();
    const solution = useProjectViewRoots.getState().roots.get("dotnetSolution:/repo/App.sln")!;
    expect(solution.children?.map((c) => c.label)).toEqual(["App", "Lib"]);
    expect(rootIds().filter((id) => id.startsWith("dotnetSolution:"))).toHaveLength(1);
  });

  it("clears the roots and scans once per project open", async () => {
    const scan = vi.spyOn(platform, "dotnetWorkspace").mockImplementation(async (root: string) => ({
      projects: [project(`${root}/App/App.csproj`, "App")],
      solutions: [],
    }));
    dispose = activateTree();
    await vi.waitFor(() => expect(rootIds()).toContain("dotnetProject:/repo/App/App.csproj"));
    // As the feature does on a project switch: reset the model, then the tree follows.
    resetDotnet();
    useProject.setState({ project: { root: "/other" } as NonNullable<typeof previousProject> });
    expect(rootIds().some((id) => id.startsWith("dotnetProject:"))).toBe(false);
    await vi.waitFor(() => expect(rootIds()).toContain("dotnetProject:/other/App/App.csproj"));
    expect(scan).toHaveBeenCalledTimes(2);
  });
});
