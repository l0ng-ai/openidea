import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as platform from "@/platform/dotnet";
import { setLocale } from "@/platform/i18n";
import type { FileMatch } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useProjectViewRoots } from "@/workbench/contributions";
import { reloadDotnet, resetDotnet, useDotnet } from "./store";
import { activateTree } from "./tree";

const mocks = vi.hoisted(() => ({
  /** The file index's answers, by query. */
  findFiles: vi.fn<(query: string, limit: number) => Promise<{ status: "ok"; data: FileMatch[] }>>(),
  indexStatus: vi.fn<() => Promise<{ status: "ok"; data: { indexing: boolean; files: number; symbols: number } }>>(),
  /** `onIdeEvent` subscriptions, to fire backend events from the tests. */
  events: new Map<string, (event: unknown) => void>(),
}));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: { ...real.commands, findFiles: mocks.findFiles, indexStatus: mocks.indexStatus },
    onIdeEvent: (type: string, callback: (event: unknown) => void) => {
      mocks.events.set(type, callback);
      return () => mocks.events.delete(type);
    },
  };
});

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

const match = (path: string): FileMatch => ({ path, relPath: path, score: 1, indices: [] });
/** What the file index answers for every query (the gate unions and filters the hits by extension). */
const indexed = (paths: string[]) => mocks.findFiles.mockResolvedValue({ status: "ok", data: paths.map(match) });
const indexing = (state: boolean) =>
  mocks.indexStatus.mockResolvedValue({ status: "ok", data: { indexing: state, files: 3, symbols: 30 } });
/** The gate's check has completed: one `findFiles` per query, one `indexStatus`. */
const gateChecked = () =>
  vi.waitFor(() => {
    expect(mocks.findFiles).toHaveBeenCalledTimes(3);
    expect(mocks.indexStatus).toHaveBeenCalledTimes(1);
  });
const indexSettled = () =>
  mocks.events.get("indexState")?.({ type: "indexState", indexing: false, files: 4, symbols: 40 });

describe("the .NET solution tree", () => {
  const previousProject = useProject.getState().project;
  let dispose = () => {};

  beforeEach(() => {
    vi.clearAllMocks();
    useProject.setState({ project: { root: "/repo" } as NonNullable<typeof previousProject> });
    indexed([]);
    indexing(false);
  });
  afterEach(async () => {
    dispose();
    resetDotnet();
    useProject.setState({ project: previousProject });
    vi.restoreAllMocks();
    await setLocale("en");
  });

  const rootIds = () => [...useProjectViewRoots.getState().roots.keys()];
  const dotnetRoots = () =>
    rootIds().filter((id) => id.startsWith("dotnetSolution:") || id.startsWith("dotnetProject:"));

  it("registers one solution group per solution with a leaf per project", async () => {
    indexed(["/repo/App.sln"]);
    const scan = vi.spyOn(platform, "dotnetWorkspace").mockResolvedValue({
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
    // The gate starts the one shared scan once, not per root or per subscription.
    expect(scan).toHaveBeenCalledTimes(1);
    const solution = useProjectViewRoots.getState().roots.get("dotnetSolution:/repo/App.sln")!;
    expect([solution.label, solution.icon, solution.beforeProject]).toEqual(["Solution 'App'", "project-dotnet", true]);
    expect(solution.children?.map((c) => [c.label, c.path, c.file])).toEqual([
      ["App", "/repo/src/App/App.csproj", true],
      ["App.Tests", "/repo/tests/App.Tests/App.Tests.csproj", true],
    ]);
  });

  it("shows the solution label through the tx template", async () => {
    indexed(["/repo/App.sln"]);
    vi.spyOn(platform, "dotnetWorkspace").mockResolvedValue({
      projects: [project("/repo/src/App/App.csproj", "App")],
      solutions: [{ path: "/repo/App.sln", projects: ["/repo/src/App/App.csproj"] }],
    });
    await setLocale("zh");
    dispose = activateTree();
    await vi.waitFor(() => expect(rootIds()).toContain("dotnetSolution:/repo/App.sln"));
    expect(useProjectViewRoots.getState().roots.get("dotnetSolution:/repo/App.sln")!.label).toBe("解决方案 'App'");
  });

  it("registers standalone projects as file roots of their own", async () => {
    indexed(["/repo/App/App.csproj"]);
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
    indexed(["/repo/App.sln"]);
    vi.spyOn(platform, "dotnetWorkspace").mockResolvedValue({ projects: [], solutions: [] });
    dispose = activateTree();
    await vi.waitFor(() => expect(useDotnet.getState().busy).toBe(false));
    expect(dotnetRoots()).toEqual([]);
  });

  it("does not scan a workspace whose index holds no .NET files", async () => {
    const scan = vi.spyOn(platform, "dotnetWorkspace").mockResolvedValue({ projects: [], solutions: [] });
    dispose = activateTree();
    await gateChecked();
    expect(scan).not.toHaveBeenCalled();
    expect(useDotnet.getState().busy).toBe(false);
    expect(dotnetRoots()).toEqual([]);
    // Nothing was armed either: an index settle later must not rescan.
    indexSettled();
    expect(scan).not.toHaveBeenCalled();
  });

  it("retries the gate once when indexing finishes", async () => {
    const scan = vi.spyOn(platform, "dotnetWorkspace").mockResolvedValue({
      projects: [project("/repo/App/App.csproj", "App")],
      solutions: [],
    });
    // Fresh open: the index is still building and has no .NET files yet.
    indexed([]);
    indexing(true);
    dispose = activateTree();
    await gateChecked();
    expect(scan).not.toHaveBeenCalled();
    // Indexing finished, and now the projects are there: the one retry scans.
    indexed(["/repo/App/App.csproj"]);
    indexing(false);
    indexSettled();
    await vi.waitFor(() => expect(rootIds()).toContain("dotnetProject:/repo/App/App.csproj"));
    expect(scan).toHaveBeenCalledTimes(1);
    // A further settle after the retry must not scan again.
    indexSettled();
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("retries the gate when the project opened before its first index pass started", async () => {
    const scan = vi.spyOn(platform, "dotnetWorkspace").mockResolvedValue({
      projects: [project("/repo/App/App.csproj", "App")],
      solutions: [],
    });
    indexed([]);
    mocks.indexStatus.mockResolvedValue({ status: "ok", data: { indexing: false, files: 0, symbols: 0 } });
    dispose = activateTree();
    await gateChecked();
    expect(scan).not.toHaveBeenCalled();
    indexed(["/repo/App/App.csproj"]);
    indexing(false);
    indexSettled();
    await vi.waitFor(() => expect(rootIds()).toContain("dotnetProject:/repo/App/App.csproj"));
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("re-registers in place when the model changes", async () => {
    indexed(["/repo/App.sln"]);
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

  it("clears the roots and gates each project open once", async () => {
    const scan = vi.spyOn(platform, "dotnetWorkspace").mockImplementation(async (root: string) => ({
      projects: [project(`${root}/App/App.csproj`, "App")],
      solutions: [],
    }));
    indexed(["/repo/App/App.csproj", "/other/App/App.csproj"]);
    dispose = activateTree();
    await vi.waitFor(() => expect(rootIds()).toContain("dotnetProject:/repo/App/App.csproj"));
    expect(scan).toHaveBeenCalledTimes(1);
    // As the feature does on a project switch: reset the model, then the tree follows.
    resetDotnet();
    useProject.setState({ project: { root: "/other" } as NonNullable<typeof previousProject> });
    expect(dotnetRoots()).toEqual([]);
    await vi.waitFor(() => expect(rootIds()).toContain("dotnetProject:/other/App/App.csproj"));
    expect(scan).toHaveBeenCalledTimes(2);
  });
});
