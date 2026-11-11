import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { executeAction, registerAction, allActions, isActionEnabled } from "@/platform/actions";
import { setContext } from "@/platform/context";
import type { BuildModel, GradleModel, ProjectInfo, RunConfig } from "@/platform/ipc";
import { emitLocalIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { usePlatform } from "@/platform/platformInfo";
import { GradleView, MavenView } from "./BuildToolView";
import { activate } from "./index";
import { expandableKeys, gradleChildren, gradleRoots, gradleProjectKey } from "./model";
import { executeBuildLine } from "./runAnything";
import { useBuild } from "./store";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  model: vi.fn(),
  configs: vi.fn(),
  open: vi.fn(),
  confirm: vi.fn(),
  menu: vi.fn(),
  link: vi.fn(),
  notify: vi.fn(),
  unlink: vi.fn(),
  show: vi.fn(),
  sync: vi.fn(),
}));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    call: (value: unknown) => value,
    commands: {
      ...real.commands,
      settingsGet: mocks.get,
      settingsSet: mocks.set,
      buildModel: mocks.model,
      runConfigs: mocks.configs,
      gradleLinkProjects: mocks.link,
      gradleUnlinkProjects: mocks.unlink,
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
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  toolWindowService: () => ({ show: mocks.show }),
  notifications: () => ({ notify: mocks.notify }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("@/workbench/messages", () => ({ confirm: mocks.confirm }));
vi.mock("@/ui", async (original) => ({
  ...(await original<typeof import("@/ui")>()),
  showContextMenu: mocks.menu,
}));

const model: BuildModel = {
  gradle: [],
  maven: {
    syncedAt: 1,
    stale: false,
    syncError: null,
    profiles: [],
    projects: [
      {
        pom: "a/pom.xml",
        dir: "a",
        groupId: "example",
        artifactId: "a",
        version: "1",
        packaging: "pom",
        displayName: "project-a",
        parent: null,
        modules: [],
        aggregated: false,
        plugins: [],
        dependencies: [],
        profiles: [],
        javaVersion: null,
        command: "mvn",
        options: [],
        env: {},
      },
    ],
  },
};
let dispose: () => void;
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({
    languages: { java: { maven: { unlinkedProjects: [] } } },
  });
  mocks.set.mockResolvedValue({});
  mocks.model.mockResolvedValue(model);
  mocks.configs.mockResolvedValue([]);
  mocks.confirm.mockResolvedValue(true);
  useProject.setState({ project: { root: "/p" } as ProjectInfo });
  setContext("projectOpen", true);
  setContext("workspaceOpen", false);
  await act(async () => {
    dispose = activate();
  });
});
afterEach(() => {
  dispose();
  useProject.setState({ project: null });
  setContext("projectOpen", false);
});

it("re-reads the build model when an applied Groovy or Kotlin script changes", async () => {
  vi.useFakeTimers();
  try {
    for (const path of ["/p/gradle/dependencies.gradle", "/p/gradle/dependencies.gradle.kts"]) {
      const calls = mocks.model.mock.calls.length;
      await act(async () => {
        emitLocalIdeEvent({ type: "fsChanged", created: [], modified: [path], removed: [] });
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(mocks.model).toHaveBeenCalledTimes(calls + 1);
    }
  } finally {
    vi.useRealTimers();
  }
});

it("offers unlink on a root's context menu and persists a confirmed project setting", async () => {
  render(<MavenView />);
  fireEvent.contextMenu(screen.getByText("project-a"));
  expect(mocks.menu).toHaveBeenCalledWith(
    expect.anything(),
    expect.arrayContaining([
      expect.objectContaining({
        action: "maven.unlinkProjects",
        arg: { pom: "a/pom.xml" },
      }),
    ]),
  );
  await act(async () => {
    await executeAction("maven.unlinkProjects", { pom: "a/pom.xml" });
  });
  expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Unlink Maven projects?" }));
  expect(mocks.set).toHaveBeenCalledWith("project", "languages.java.maven.unlinkedProjects", '["a/pom.xml"]');
  expect(mocks.model).toHaveBeenCalledTimes(2);
});

it("does not write after cancelled confirmation", async () => {
  mocks.confirm.mockResolvedValue(false);
  await executeAction("maven.unlinkProjects", { pom: "a/pom.xml" });
  expect(mocks.confirm).toHaveBeenCalledTimes(1);
  expect(mocks.set).not.toHaveBeenCalled();
});

it("unlinks a module of a linked reactor so only the modules in use are imported", async () => {
  const root = model.maven!.projects[0]!;
  const child = {
    ...root,
    pom: "a/child/pom.xml",
    dir: "a/child",
    artifactId: "child",
    displayName: "child-module",
    packaging: "jar",
    parent: "a/pom.xml",
    aggregated: true,
  };
  const reactor: BuildModel = {
    ...model,
    maven: {
      ...model.maven!,
      projects: [{ ...root, modules: ["a/child/pom.xml"] }, child],
    },
  };
  mocks.model.mockResolvedValue(reactor);
  mocks.get.mockResolvedValue({
    languages: { java: { maven: { unlinkedProjects: ["b/pom.xml"] } } },
  });
  await act(async () => {
    useBuild.setState({ model: reactor });
  });
  render(<MavenView />);
  fireEvent.contextMenu(await screen.findByText("child-module"));
  expect(mocks.menu).toHaveBeenCalledWith(
    expect.anything(),
    expect.arrayContaining([
      expect.objectContaining({
        action: "maven.unlinkProjects",
        arg: { pom: "a/child/pom.xml" },
      }),
    ]),
  );
  await act(async () => {
    await executeAction("maven.unlinkProjects", { pom: "a/child/pom.xml" });
  });
  expect(mocks.confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      message: expect.stringContaining("Java language server stops importing them"),
    }),
  );
  expect(mocks.set).toHaveBeenCalledWith(
    "project",
    "languages.java.maven.unlinkedProjects",
    '["b/pom.xml","a/child/pom.xml"]',
  );
});

it("ignores a POM that is not in the Maven model", async () => {
  await executeAction("maven.unlinkProjects", { pom: "missing/pom.xml" });
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(mocks.set).not.toHaveBeenCalled();
});

it("re-adds a picked POM using the plus button and preserves other unlinked roots", async () => {
  mocks.get.mockResolvedValue({
    languages: {
      java: { maven: { unlinkedProjects: ["a/pom.xml", "b/pom.xml"] } },
    },
  });
  mocks.open.mockResolvedValue("/p/a/pom.xml");
  act(() =>
    useBuild.setState({
      model: { ...model, maven: { ...model.maven!, projects: [] } },
    }),
  );
  render(<MavenView />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Add Maven Projects" }));
  });
  await waitFor(() =>
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: "/p", directory: false })),
  );
  await waitFor(() =>
    expect(mocks.set).toHaveBeenCalledWith("project", "languages.java.maven.unlinkedProjects", '["b/pom.xml"]'),
  );
});

it.each([null, "/outside/pom.xml", "/p/a/build.xml", "/p/../outside/pom.xml", "/p/a/pom.xml"])(
  "ignores cancelled, invalid, outside or already linked picks: %s",
  async (picked) => {
    mocks.open.mockResolvedValue(picked);
    await executeAction("maven.addProjects");
    expect(mocks.set).not.toHaveBeenCalled();
  },
);

it("links `\\\\?\\`-prefixed and differently-cased picks on Windows", async () => {
  const os = usePlatform.getState().os;
  usePlatform.setState({ os: "windows" });
  try {
    useProject.setState({ project: { root: "C:\\Projects\\demo" } as ProjectInfo });
    mocks.get.mockResolvedValue({
      languages: { java: { maven: { unlinkedProjects: [], linkedProjects: [] } } },
    });
    mocks.open.mockResolvedValue(["\\\\?\\C:\\Projects\\demo\\svc\\pom.xml", "c:/Projects/demo/web/pom.xml"]);
    await act(async () => {
      await executeAction("maven.addProjects");
    });
    expect(mocks.set).toHaveBeenCalledWith(
      "project",
      "languages.java.maven.linkedProjects",
      '["svc/pom.xml","web/pom.xml"]',
    );
  } finally {
    usePlatform.setState({ os });
  }
});

it("warns about picks outside the project instead of silently doing nothing", async () => {
  mocks.open.mockResolvedValue("/other/pom.xml");
  await act(async () => {
    await executeAction("maven.addProjects");
  });
  expect(mocks.set).not.toHaveBeenCalled();
  expect(mocks.notify).toHaveBeenCalledWith(
    expect.objectContaining({
      level: "warning",
      title: expect.stringContaining("not added"),
      body: expect.stringContaining("/other/pom.xml"),
    }),
  );
});

it("links picked POMs that no reactor lists as independent top-level projects", async () => {
  mocks.get.mockResolvedValue({
    languages: { java: { maven: { unlinkedProjects: ["b/pom.xml"], linkedProjects: ["tools/pom.xml"] } } },
  });
  mocks.open.mockResolvedValue(["/p/stub/pom.xml", "/p/b/pom.xml", "/p/a/pom.xml", "/p/tools/pom.xml"]);
  await act(async () => {
    await executeAction("maven.addProjects");
  });
  expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ multiple: true }));
  expect(mocks.set).toHaveBeenCalledWith("project", "languages.java.maven.unlinkedProjects", "[]");
  expect(mocks.set).toHaveBeenCalledWith(
    "project",
    "languages.java.maven.linkedProjects",
    '["tools/pom.xml","stub/pom.xml"]',
  );
});

it("unlinking a linked independent project removes the link instead of hiding it", async () => {
  mocks.get.mockResolvedValue({ languages: { java: { maven: { linkedProjects: ["a/pom.xml"] } } } });
  await act(async () => {
    await executeAction("maven.unlinkProjects", { pom: "a/pom.xml" });
  });
  expect(mocks.set).toHaveBeenCalledWith("project", "languages.java.maven.linkedProjects", "[]");
  expect(mocks.set).not.toHaveBeenCalledWith("project", "languages.java.maven.unlinkedProjects", expect.anything());
});

const gradleBuild = (dir: string): GradleModel => ({
  dir,
  command: `/p/${dir}/gradlew`,
  env: { JAVA_HOME: `/${dir}/jdk` },
  javaVersion: 21,
  syncedAt: 1,
  stale: false,
  syncError: null,
  projects: [
    { path: ":", name: dir, dir, buildFile: `${dir}/build.gradle`, tasks: [] },
    {
      path: ":app",
      name: "app",
      dir: `${dir}/app`,
      buildFile: `${dir}/app/build.gradle`,
      tasks: [{ name: "test", group: "verification", description: null }],
    },
  ],
});

it("links from the toolbar and keeps Link available after unlinking the final build", async () => {
  const build = gradleBuild("first");
  const linked: BuildModel = { maven: null, gradle: [build] };
  mocks.link.mockResolvedValue(linked);
  mocks.unlink.mockResolvedValue({ maven: null, gradle: [] });
  mocks.open.mockResolvedValue(["/p/first/settings.gradle"]);
  act(() => useBuild.setState({ model: { maven: null, gradle: [] } }));
  render(<GradleView />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Link Gradle Projects" })));
  expect(mocks.link).toHaveBeenCalledWith(["/p/first/settings.gradle"]);
  expect(screen.getByText("first")).toBeTruthy();
  fireEvent.contextMenu(screen.getByText("first"));
  expect(mocks.menu).toHaveBeenCalledWith(
    expect.anything(),
    expect.arrayContaining([expect.objectContaining({ action: "gradle.unlinkProjects", arg: { buildDir: "first" } })]),
  );
  await act(async () => executeAction("gradle.unlinkProjects", { buildDir: "first" }));
  expect(mocks.unlink).toHaveBeenCalledWith(["first"]);
  expect(mocks.confirm).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining("Files will remain") }),
  );
  expect(screen.getByText("No Gradle projects")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Link Gradle Projects" })).toBeTruthy();
  expect(useBuild.getState().model?.gradle).toEqual([]);
});

it("leaves links unchanged when unlink is cancelled or a module is targeted", async () => {
  act(() => useBuild.setState({ model: { maven: null, gradle: [gradleBuild("first")] } }));
  mocks.confirm.mockResolvedValue(false);
  await executeAction("gradle.unlinkProjects", { buildDir: "first" });
  await executeAction("gradle.unlinkProjects", { buildDir: "first/app" });
  expect(mocks.unlink).not.toHaveBeenCalled();
  expect(useBuild.getState().model?.gradle).toHaveLength(1);
});

it("runs duplicate task paths with the selected build's wrapper, cwd and offline setting", async () => {
  const builds = [gradleBuild("first"), gradleBuild("second")];
  const model: BuildModel = { maven: null, gradle: builds };
  const roots = gradleRoots(builds);
  const expanded = expandableKeys(roots, (n) => gradleChildren(n, builds, [], "/p"));
  act(() =>
    useBuild.setState({
      model,
      expanded: { maven: new Set(), gradle: expanded },
      current: { gradle: gradleProjectKey(builds[1]!, builds[1]!.projects[1]!) },
      settings: { ...useBuild.getState().settings, gradle: { offline: true, skipTests: false } },
    }),
  );
  const started: RunConfig[] = [];
  const off = registerAction({
    id: "run.runConfig",
    title: "Run",
    hidden: true,
    run: ({ arg }) => {
      started.push((arg as { config: RunConfig }).config);
    },
  });
  render(<GradleView />);
  const tasks = screen.getAllByText("test");
  expect(tasks).toHaveLength(2);
  await act(async () => fireEvent.doubleClick(tasks[1]!));
  expect(executeBuildLine("gradle", "test")).toBe(true);
  off();
  expect(started).toHaveLength(2);
  for (const config of started)
    expect(config).toMatchObject({
      command: "/p/second/gradlew",
      cwd: "second",
      args: [":app:test", "--offline"],
      // The build's `JAVA_HOME` follows Settings at launch instead of being frozen here (#2433).
      env: {},
    });
});

it("drops a late link result after the user changes projects", async () => {
  let finish!: (model: BuildModel) => void;
  mocks.open.mockResolvedValue("/p/first/build.gradle");
  mocks.link.mockImplementation(
    () =>
      new Promise<BuildModel>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = executeAction("gradle.linkProjects");
  await vi.waitFor(() => expect(mocks.link).toHaveBeenCalled());
  await act(async () => {
    useProject.setState({ project: { root: "/other", trusted: false } as ProjectInfo });
    finish({ maven: null, gradle: [gradleBuild("first")] });
    await pending;
  });
  expect(useBuild.getState().model).toBeNull();
});

it("routes Reload to the chosen independent build", async () => {
  const model: BuildModel = { maven: null, gradle: [gradleBuild("first"), gradleBuild("second")] };
  mocks.sync.mockResolvedValue(model);
  act(() => useBuild.setState({ model }));
  await executeAction("gradle.reload", { buildDir: "second" });
  await vi.waitFor(() =>
    expect(mocks.sync).toHaveBeenCalledWith("gradle", expect.any(Number), false, [], "second", expect.anything()),
  );
});

it("does not offer Link or Unlink for a native Workspace window", async () => {
  act(() =>
    useProject.setState({
      project: { root: "/p", workspace: { version: 1, name: "workspace", projects: ["/p/first"] } } as ProjectInfo,
    }),
  );
  setContext("workspaceOpen", true);
  for (const id of ["gradle.linkProjects", "gradle.unlinkProjects"])
    expect(isActionEnabled(allActions().find((a) => a.id === id)!)).toBe(false);
  await executeAction("gradle.linkProjects");
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.link).not.toHaveBeenCalled();
});

it("does not link or start Gradle imports in an untrusted project", async () => {
  act(() => useProject.setState({ project: { root: "/p", trusted: false } as ProjectInfo }));
  await executeAction("gradle.linkProjects");
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.link).not.toHaveBeenCalled();
  expect(mocks.sync).not.toHaveBeenCalled();
});
