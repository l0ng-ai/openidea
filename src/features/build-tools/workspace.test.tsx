import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { BuildModel, ProjectInfo, RunConfig } from "@/platform/ipc";
import { executeAction, registerAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { useProject } from "@/platform/project";
import { MavenView, GradleView } from "./BuildToolView";
import { activate } from "./index";
import { expandableKeys, gradleChildren, gradleRoots, mavenChildren, mavenRoots, profileKey } from "./model";
import { executeBuildLine } from "./runAnything";
import { loadModel, PROFILE_RELOAD_DELAY_MS, resetBuild, setProfile, syncTool, useBuild } from "./store";

const mocks = vi.hoisted(() => ({ model: vi.fn(), sync: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    call: (value: unknown) => value,
    commands: {
      ...real.commands,
      buildModel: mocks.model,
      runConfigs: () => Promise.resolve([]),
      buildSync: mocks.sync,
      cancelRequest: () => Promise.resolve(),
    },
  };
});
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage: unknown = null;
  },
}));

const members = ["/projects/first", "/projects/second"];
const model: BuildModel = {
  maven: {
    syncedAt: 1,
    stale: false,
    syncError: null,
    profiles: members.map((projectRoot) => ({ id: "local", activeByDefault: false, projectRoot })),
    projects: members.map((projectRoot) => ({
      projectRoot,
      pom: `${projectRoot}/pom.xml`,
      dir: projectRoot,
      groupId: "example",
      artifactId: "app",
      version: "1",
      packaging: "jar",
      displayName: projectRoot.split("/").pop()!,
      parent: null,
      modules: [],
      aggregated: false,
      plugins: [],
      dependencies: [],
      profiles: ["local"],
      javaVersion: null,
      command: `${projectRoot}/mvnw`,
      options: [],
      env: {},
    })),
  },
  gradle: members.map((dir) => ({
    dir,
    command: `${dir}/gradlew`,
    env: {},
    javaVersion: null,
    syncedAt: 1,
    stale: false,
    syncError: null,
    projects: [
      {
        path: ":",
        name: dir.split("/").pop()!,
        dir,
        buildFile: `${dir}/build.gradle`,
        tasks: [{ name: "test", group: "verification", description: null }],
      },
    ],
  })),
};
let dispose: () => void;
beforeEach(async () => {
  vi.clearAllMocks();
  localStorage.clear();
  resetBuild();
  useProject.setState({
    project: {
      root: "/workspace",
      trusted: true,
      workspace: { version: 1, name: "Workspace", projects: members },
    } as ProjectInfo,
  });
  setContext("projectOpen", true);
  setContext("workspaceOpen", true);
  mocks.model.mockResolvedValue(model);
  mocks.sync.mockResolvedValue(model);
  await act(async () => {
    dispose = activate();
  });
});
afterEach(() => {
  dispose();
  resetBuild();
  useProject.setState({ project: null });
  setContext("projectOpen", false);
  setContext("workspaceOpen", false);
  vi.useRealTimers();
});

it("lists linked Maven projects and keeps duplicate profile choices and goal directories independent", async () => {
  const maven = model.maven!;
  const roots = mavenRoots(maven);
  act(() =>
    useBuild.setState((s) => ({
      expanded: { ...s.expanded, maven: expandableKeys(roots, (n) => mavenChildren(n, maven, [])) },
    })),
  );
  render(<MavenView />);
  expect(screen.getAllByText("first")).toHaveLength(2);
  expect(screen.getAllByText("second")).toHaveLength(2);
  const profiles = screen.getAllByRole("checkbox", { name: "local" });
  expect(profiles).toHaveLength(2);
  vi.useFakeTimers();
  await act(async () => {
    fireEvent.click(profiles[1]!);
  });
  expect(profiles[0]).not.toBeChecked();
  expect(profiles[1]).toBeChecked();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PROFILE_RELOAD_DELAY_MS);
  });
  expect(mocks.sync).toHaveBeenCalledWith("maven", expect.any(Number), false, ["local"], members[1], expect.anything());
  const runs: RunConfig[] = [];
  const off = registerAction({
    id: "run.runConfig",
    title: "Run",
    hidden: true,
    run: ({ arg }) => {
      runs.push((arg as { config: RunConfig }).config);
    },
  });
  await act(async () => {
    fireEvent.doubleClick(screen.getAllByText("validate")[1]!);
  });
  expect(executeBuildLine("maven", "validate", maven.projects[0]!.pom)).toBe(true);
  off();
  expect(runs[0]).toMatchObject({ cwd: members[1], command: `${members[1]}/mvnw`, args: ["validate", "-Plocal"] });
  expect(runs[1]).toMatchObject({ cwd: members[0], command: `${members[0]}/mvnw`, args: ["validate"] });
});

it("reloads all Maven members with their own profile choices", async () => {
  vi.useFakeTimers();
  setProfile(model.maven!.profiles[0]!, true);
  setProfile(model.maven!.profiles[1]!, true);
  await vi.advanceTimersByTimeAsync(PROFILE_RELOAD_DELAY_MS);
  expect(mocks.sync.mock.calls.map((c) => [c[3], c[4]])).toEqual([
    [["local"], members[0]],
    [["local"], members[1]],
  ]);
  mocks.sync.mockClear();
  useBuild.setState((s) => ({
    settings: {
      ...s.settings,
      maven: { ...s.settings.maven, profiles: { [profileKey(model.maven!.profiles[1]!)]: true } },
    },
  }));
  await syncTool("maven");
  expect(mocks.sync.mock.calls.map((c) => [c[3], c[4]])).toEqual([
    [[], members[0]],
    [["local"], members[1]],
  ]);
});

it("shows and runs duplicate Gradle tasks with each member's wrapper and refresh directory", async () => {
  const roots = gradleRoots(model.gradle ?? []);
  act(() =>
    useBuild.setState((s) => ({
      expanded: {
        ...s.expanded,
        gradle: expandableKeys(roots, (n) => gradleChildren(n, model.gradle ?? [], [], "/workspace")),
      },
    })),
  );
  render(<GradleView />);
  const runs: RunConfig[] = [];
  const off = registerAction({
    id: "run.runConfig",
    title: "Run",
    hidden: true,
    run: ({ arg }) => {
      runs.push((arg as { config: RunConfig }).config);
    },
  });
  await act(async () => {
    fireEvent.doubleClick(screen.getAllByText("test")[1]!);
  });
  off();
  expect(runs[0]).toMatchObject({ cwd: members[1], command: `${members[1]}/gradlew`, args: ["test"] });
  await syncTool("gradle", members[1]);
  expect(mocks.sync).toHaveBeenCalledWith("gradle", expect.any(Number), false, [], members[1], expect.anything());
});

it("refreshes availability after workspace membership changes and does not load untrusted windows", async () => {
  mocks.model.mockResolvedValue({ maven: null, gradle: [] });
  await loadModel();
  expect(useBuild.getState().model).toEqual({ maven: null, gradle: [] });
  mocks.model.mockClear();
  act(() => useProject.setState({ project: { ...useProject.getState().project!, trusted: false } }));
  await loadModel();
  expect(mocks.model).not.toHaveBeenCalled();
  expect(useBuild.getState().model).toBeNull();
});

it("generates sources in each project, then reloads so generated folders become source folders", async () => {
  const runs: { config: RunConfig; onExit: (code: number | null, stopped: boolean) => void }[] = [];
  const off = registerAction({
    id: "run.runConfig",
    title: "Run",
    hidden: true,
    run: ({ arg }) => void runs.push(arg as (typeof runs)[number]),
  });
  try {
    mocks.sync.mockClear();
    const done = executeAction("maven.generateSources");
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0]!.config).toMatchObject({ args: ["generate-sources"], cwd: members[0] });
    // One project at a time; the reload waits for the last one.
    runs[0]!.onExit(0, false);
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    expect(runs[1]!.config.cwd).toBe(members[1]);
    expect(mocks.sync).not.toHaveBeenCalled();
    runs[1]!.onExit(1, false);
    await done;
    await vi.waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(2));

    // One project from its context menu; stopping it skips the reload.
    runs.length = 0;
    mocks.sync.mockClear();
    const one = executeAction("maven.generateSources", { pom: `${members[1]}/pom.xml` });
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0]!.config.cwd).toBe(members[1]);
    runs[0]!.onExit(null, true);
    await one;
    expect(runs).toHaveLength(1);
    expect(mocks.sync).not.toHaveBeenCalled();
  } finally {
    off();
  }
});
