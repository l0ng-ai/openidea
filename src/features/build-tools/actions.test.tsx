import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { allActions, executeAction, isActionEnabled, registerAction } from "@/platform/actions";
import { getContext, setContext } from "@/platform/context";
import type { BuildModel, RunConfig } from "@/platform/ipc";
import { useContributions } from "@/workbench/contributions";
import { MavenView } from "./BuildToolView";
import { activate } from "./index";
import { useBuild } from "./store";

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
  gradle: null,
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

    act(() => useBuild.setState({ model: { maven: null, gradle: null } }));
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
    const phase = screen.getByText("package");
    await act(async () => {
      phase.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    off();
    expect(started).toHaveLength(1);
    const { config, temporary } = started[0] as { config: RunConfig; temporary: boolean };
    expect(temporary).toBe(true);
    expect(config).toMatchObject({
      name: "spring-demo [package]",
      command: "/p/mvnw",
      args: ["package", "-DskipTests"],
      kind: "maven",
    });
  });
});
