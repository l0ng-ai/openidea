import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { executeAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import type { BuildModel, GradleDependency, GradleModel, MavenDependency } from "@/platform/ipc";
import { menuGroupItems, provideEditorService, type EditorService } from "@/workbench/contributions";
import { DependencyAnalyzer } from "./DependencyAnalyzer";
import { activate } from "./index";
import { ANALYZER_KIND, useAnalyzer, useBuild } from "./store";

const ipc = vi.hoisted(() => ({ exclude: vi.fn(), declaration: vi.fn(), gradle: vi.fn(), cancel: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    call: (value: unknown) => value,
    commands: {
      ...real.commands,
      mavenExcludeDependency: ipc.exclude,
      mavenDependencyDeclaration: ipc.declaration,
      gradleDependencies: ipc.gradle,
      cancelRequest: ipc.cancel,
    },
  };
});

function dep(coords: string, extra: Partial<MavenDependency> = {}, children: MavenDependency[] = []): MavenDependency {
  const [groupId, artifactId, version] = coords.split(":");
  return {
    groupId: groupId!,
    artifactId: artifactId!,
    version: version!,
    type: "jar",
    classifier: null,
    scope: "compile",
    optional: false,
    children,
    ...extra,
  };
}

const model: BuildModel = {
  maven: {
    projects: [
      {
        pom: "pom.xml",
        dir: "",
        groupId: "demo",
        artifactId: "conflict-demo",
        version: "1.0",
        packaging: "jar",
        displayName: "conflict-demo",
        parent: null,
        modules: [],
        aggregated: false,
        plugins: [],
        dependencies: [
          dep("com.google.guava:guava:32.1.3-jre"),
          dep("com.google.inject:guice:5.1.0", {}, [
            dep("com.google.guava:guava:30.1-jre", { omitted: "conflict", conflictWith: "32.1.3-jre" }),
          ]),
        ],
        profiles: [],
        javaVersion: 17,
        command: "mvn",
        options: [],
        env: {},
      },
    ],
    profiles: [],
    syncedAt: 1,
    stale: false,
    syncError: null,
  },
  gradle: null,
};

describe("dependency analyzer", () => {
  let dispose: () => void = () => {};
  const openInput = vi.fn(() => Promise.resolve());
  const openFile = vi.fn(() => Promise.resolve());
  beforeEach(() => {
    provideEditorService({ openInput, openFile, activePath: () => null } as unknown as EditorService);
    setContext("projectOpen", true);
    dispose = activate();
    act(() => useBuild.setState({ root: "/p", model }));
  });
  afterEach(() => {
    dispose();
    setContext("projectOpen", false);
    vi.clearAllMocks();
  });

  it("opens as an editor tab from the action and from a pom.xml's menus", async () => {
    await executeAction("maven.analyzeDependencies", { pom: "pom.xml" });
    expect(openInput).toHaveBeenCalledWith(expect.objectContaining({ kind: ANALYZER_KIND }), { focus: true });
    expect(useAnalyzer.getState().module).toBe("pom.xml");
    for (const menu of ["editor", "projectView", "editorTab"] as const) {
      const items = menuGroupItems(menu, { paths: ["/p/pom.xml"] });
      expect(items[0]).toMatchObject({ action: "maven.analyzeDependencies", arg: { pom: "pom.xml" } });
    }
    expect(menuGroupItems("editor", { paths: ["/p/other/pom.xml"] })).toEqual([]);
    expect(menuGroupItems("editor", { paths: ["/p/src/Main.java"] })).toEqual([]);
  });

  it("marks conflicts, shows their usages and excludes through the direct dependency", async () => {
    ipc.exclude.mockResolvedValue({ path: "/p/pom.xml", range: {} });
    render(<DependencyAnalyzer input={{ kind: ANALYZER_KIND, key: ANALYZER_KIND }} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Show conflicts only" }));
    expect(screen.queryByText("com.google.inject:guice")).toBeNull();
    fireEvent.mouseDown(screen.getByText("com.google.guava:guava").closest("[role=treeitem]")!, { button: 0 });
    expect(screen.getByText("omitted for conflict with 32.1.3-jre")).toBeTruthy();
    expect(screen.getByText("com.google.inject:guice:5.1.0")).toBeTruthy();
    // Only the transitive usage can be excluded.
    const exclude = screen.getAllByRole("button", { name: "Exclude" });
    expect(exclude).toHaveLength(1);
    await act(async () => fireEvent.click(exclude[0]!));
    expect(ipc.exclude).toHaveBeenCalledWith(
      "pom.xml",
      { groupId: "com.google.inject", artifactId: "guice" },
      { groupId: "com.google.guava", artifactId: "guava" },
    );
  });
});

function gradleDep(coords: string, selected: string | null, children: GradleDependency[] = []): GradleDependency {
  const [group, name, requested] = coords.split(":");
  return {
    group: group!,
    name: name!,
    requested: requested ?? null,
    selected,
    project: false,
    repeated: false,
    constraint: false,
    unresolved: false,
    children,
  };
}

const gradle: GradleModel = {
  dir: "",
  projects: [
    { path: ":", name: "demo", dir: "", buildFile: "build.gradle", tasks: [] },
    { path: ":app", name: "app", dir: "app", buildFile: "app/build.gradle.kts", tasks: [] },
  ],
  javaVersion: null,
  command: "gradle",
  env: {},
  syncedAt: null,
  stale: false,
  syncError: null,
};

describe("dependency analyzer for Gradle", () => {
  let dispose: () => void = () => {};
  const openInput = vi.fn(() => Promise.resolve());
  beforeEach(() => {
    provideEditorService({ openInput, activePath: () => null } as unknown as EditorService);
    setContext("projectOpen", true);
    dispose = activate();
    act(() => useBuild.setState({ root: "/g", model: { maven: null, gradle } }));
  });
  afterEach(() => {
    dispose();
    setContext("projectOpen", false);
    vi.clearAllMocks();
  });

  it("opens for a project from the action and from its build script's menus", async () => {
    await executeAction("gradle.analyzeDependencies", { gradlePath: ":app" });
    expect(openInput).toHaveBeenCalledWith(expect.objectContaining({ kind: ANALYZER_KIND }), { focus: true });
    expect(useAnalyzer.getState().module).toBe("gradle::app");
    const items = menuGroupItems("projectView", { paths: ["/g/app/build.gradle.kts"] });
    expect(items).toContainEqual(
      expect.objectContaining({ action: "gradle.analyzeDependencies", arg: { path: "/g/app/build.gradle.kts" } }),
    );
    await executeAction("gradle.analyzeDependencies", { path: "/g/build.gradle" });
    expect(useAnalyzer.getState().module).toBe("gradle::");
    expect(menuGroupItems("editor", { paths: ["/g/other/build.gradle"] })).toEqual([]);
  });

  it("reads the configuration's report and marks versions Gradle replaced", async () => {
    ipc.gradle.mockResolvedValue([
      gradleDep("org.springframework.boot:spring-boot-starter-json", "3.2.0", [
        gradleDep("com.fasterxml.jackson.core:jackson-databind:2.15.0", "2.15.3"),
      ]),
      gradleDep("com.fasterxml.jackson.core:jackson-databind:2.15.3", null),
    ]);
    act(() => useAnalyzer.setState({ module: "gradle::app" }));
    render(<DependencyAnalyzer input={{ kind: ANALYZER_KIND, key: ANALYZER_KIND }} />);
    expect(ipc.gradle).toHaveBeenCalledWith(":app", "runtimeClasspath", false, expect.any(Number));
    await screen.findByText("com.fasterxml.jackson.core:jackson-databind");
    fireEvent.click(screen.getByRole("checkbox", { name: "Show conflicts only" }));
    expect(screen.queryByText("org.springframework.boot:spring-boot-starter-json")).toBeNull();
    fireEvent.mouseDown(screen.getByText("com.fasterxml.jackson.core:jackson-databind").closest("[role=treeitem]")!, {
      button: 0,
    });
    expect(screen.getByText("requested 2.15.0")).toBeTruthy();
    expect(screen.getByText("org.springframework.boot:spring-boot-starter-json:3.2.0")).toBeTruthy();
    // Exclude and Jump to Source edit a pom.xml: not offered for Gradle.
    expect(screen.queryByRole("button", { name: "Exclude" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Jump to Source" })).toBeNull();
  });

  it("shows why Gradle could not resolve the configuration", async () => {
    ipc.gradle.mockRejectedValue(new Error("Could not resolve all files for configuration ':app:runtimeClasspath'."));
    act(() => useAnalyzer.setState({ module: "gradle::" }));
    render(<DependencyAnalyzer input={{ kind: ANALYZER_KIND, key: ANALYZER_KIND }} />);
    expect(await screen.findByText("Cannot resolve dependencies")).toBeTruthy();
    expect(screen.getByText(/Could not resolve all files/)).toBeTruthy();
    ipc.gradle.mockResolvedValue([]);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    expect(ipc.gradle).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("No dependencies")).toBeTruthy();
  });
});
