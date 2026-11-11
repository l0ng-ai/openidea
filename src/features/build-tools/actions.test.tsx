import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { allActions, executeAction, isActionEnabled, registerAction } from "@/platform/actions";
import { getContext, setContext } from "@/platform/context";
import type { BuildModel, RunConfig } from "@/platform/ipc";
import { useContributions } from "@/workbench/contributions";
import { GradleView, MavenView } from "./BuildToolView";
import { activate } from "./index";
import { gradleProjectKey } from "./model";
import { useBuild } from "./store";
import styles from "./BuildTools.module.css";

const mavenModel: BuildModel = {
  maven: {
    projects: [
      {
        pom: "pom.xml",
        dir: "",
        groupId: "com.example",
        artifactId: "spring-demo",
        version: "0.0.1-SNAPSHOT",
        packaging: "jar",
        displayName: "spring-demo",
        parent: null,
        modules: [],
        aggregated: false,
        plugins: [],
        dependencies: [],
        profiles: ["ci"],
        javaVersion: 21,
        command: "/p/mvnw",
        options: [],
        env: {},
      },
    ],
    profiles: [{ id: "ci", activeByDefault: false }],
    syncedAt: 1,
    stale: true,
    syncError: null,
  },
  gradle: [],
};

describe("build tools feature", () => {
  let dispose: () => void = () => {};
  beforeEach(() => {
    localStorage.clear();
    setContext("projectOpen", true);
    dispose = activate();
  });
  afterEach(() => {
    dispose();
    setContext("projectOpen", false);
  });

  const toolWindows = () => [...useContributions.getState().toolWindows.keys()];

  it("registers the Maven tool window only while the project has a POM", () => {
    expect(toolWindows()).not.toContain("maven");
    act(() => useBuild.setState({ root: "/p", model: mavenModel }));
    const tw = useContributions.getState().toolWindows.get("maven");
    expect(tw).toMatchObject({ title: "Maven", icon: "toolwindow-maven", anchor: "right" });
    expect(tw?.stripe).toBeUndefined();
    expect(getContext()["build.maven"]).toBe(true);
    expect(toolWindows()).not.toContain("gradle");

    act(() => useBuild.setState({ model: { maven: null, gradle: [] } }));
    expect(toolWindows()).not.toContain("maven");
    expect(getContext()["build.maven"]).toBe(false);
  });

  it("offers its actions in Search Everywhere only for Maven projects and toggles run options", async () => {
    const visible = () => allActions().filter((a) => !a.hidden && a.id.startsWith("maven."));
    expect(
      visible()
        .map((a) => a.id)
        .sort(),
    ).toEqual([
      "maven.addProjects",
      "maven.analyzeDependencies",
      "maven.executeGoal",
      "maven.generateSources",
      "maven.reload",
      "maven.settings",
      "maven.toggleOffline",
      "maven.toggleSkipTests",
    ]);
    const reload = allActions().find((a) => a.id === "maven.reload")!;
    expect(isActionEnabled(reload)).toBe(false);
    act(() => useBuild.setState({ root: "/p", model: mavenModel }));
    expect(isActionEnabled(reload)).toBe(true);

    await executeAction("maven.toggleSkipTests");
    await executeAction("maven.toggleOffline");
    expect(useBuild.getState().settings.maven).toMatchObject({ offline: true, skipTests: true });
    expect(JSON.parse(localStorage.getItem("openidea.buildTools:/p")!).maven.skipTests).toBe(true);
    expect(
      allActions()
        .find((a) => a.id === "maven.toggleOffline")!
        .toggled?.(),
    ).toBe(true);

    await executeAction("maven.executeGoal");
    expect(useBuild.getState().executeOpen).toBe("maven");
  });

  it("runs a lifecycle phase through the run feature with the toolbar options", async () => {
    const started: unknown[] = [];
    const off = registerAction({
      id: "run.runConfig",
      title: "Run",
      hidden: true,
      run: ({ arg }) => void started.push(arg),
    });
    act(() =>
      useBuild.setState({
        root: "/p",
        model: mavenModel,
        expanded: { maven: new Set(["mvn:pom.xml", "mvn:pom.xml:lifecycle"]), gradle: new Set() },
      }),
    );
    await executeAction("maven.toggleSkipTests");
    render(<MavenView />);
    expect(screen.getByText("Build files changed since the last reload")).toBeTruthy();
    const phase = screen.getByText("test");
    expect(phase).toHaveClass(styles.skippedGoal!);
    await act(() => executeAction("maven.toggleSkipTests"));
    expect(phase).not.toHaveClass(styles.skippedGoal!);
    await act(() => executeAction("maven.toggleSkipTests"));
    expect(phase).toHaveClass(styles.skippedGoal!);
    await act(async () => {
      phase.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    off();
    expect(started).toHaveLength(1);
    const { config, temporary } = started[0] as { config: RunConfig; temporary: boolean };
    expect(temporary).toBe(true);
    expect(config).toMatchObject({
      name: "spring-demo [test]",
      command: "/p/mvnw",
      args: ["test", "-DskipTests"],
      kind: "maven",
    });
  });

  it("does not mark Gradle test tasks as skipped when Maven Skip Tests is on", async () => {
    const build = {
      dir: "",
      projects: [
        {
          path: ":",
          name: "demo",
          dir: "",
          buildFile: "build.gradle.kts",
          tasks: [{ name: "test", group: "verification", description: null }],
        },
      ],
      command: "gradle",
      env: {},
      javaVersion: null,
      syncedAt: null,
      stale: false,
      syncError: null,
    };
    const key = gradleProjectKey(build, build.projects[0]!);
    act(() =>
      useBuild.setState({
        root: "/p",
        model: { maven: mavenModel.maven, gradle: [build] },
        expanded: { maven: new Set(), gradle: new Set([key, `${key}:tasks`, `${key}:tasks:verification`]) },
      }),
    );
    await executeAction("maven.toggleSkipTests");
    render(<GradleView />);
    expect(screen.getByText("test")).not.toHaveClass(styles.skippedGoal!);
  });

  it("toggles Gradle Skip Tests and runs tasks with -x test", async () => {
    const started: unknown[] = [];
    const off = registerAction({
      id: "run.runConfig",
      title: "Run",
      hidden: true,
      run: ({ arg }) => void started.push(arg),
    });
    const build = {
      dir: "",
      projects: [
        {
          path: ":",
          name: "demo",
          dir: "",
          buildFile: "build.gradle.kts",
          tasks: [{ name: "test", group: "verification", description: null }],
        },
      ],
      command: "/p/gradlew",
      env: {},
      javaVersion: null,
      syncedAt: null,
      stale: false,
      syncError: null,
    };
    const key = gradleProjectKey(build, build.projects[0]!);
    act(() =>
      useBuild.setState({
        root: "/p",
        model: { maven: mavenModel.maven, gradle: [build] },
        expanded: { maven: new Set(), gradle: new Set([key, `${key}:tasks`, `${key}:tasks:verification`]) },
      }),
    );
    await executeAction("gradle.toggleSkipTests");
    expect(useBuild.getState().settings.gradle).toMatchObject({ skipTests: true });
    expect(JSON.parse(localStorage.getItem("openidea.buildTools:/p")!).gradle.skipTests).toBe(true);
    expect(
      allActions()
        .find((a) => a.id === "gradle.toggleSkipTests")!
        .toggled?.(),
    ).toBe(true);
    render(<GradleView />);
    const task = screen.getByText("test");
    expect(task).toHaveClass(styles.skippedGoal!);
    await act(async () => {
      task.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    off();
    expect(started).toHaveLength(1);
    const { config } = started[0] as { config: RunConfig };
    expect(config).toMatchObject({
      name: "demo [test]",
      command: "/p/gradlew",
      args: ["test", "-x", "test"],
      kind: "gradle",
      isTest: false,
    });
  });
});
