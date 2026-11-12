import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import type { BuildModel } from "@/platform/ipc";
import { useBuildModel } from "@/platform/buildModel";
import { useProject } from "@/platform/project";
import { provideEditorService, useProjectViewRoots, type EditorService } from "@/workbench/contributions";
import { activate } from "./index";
import { MemoryFs, setProjectFsForTests } from "./fs";
import { ProjectView } from "./ProjectView";

const backend = vi.hoisted(() => ({
  model: null as BuildModel | null,
}));

vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      buildModel: () => Promise.resolve({ status: "ok", data: backend.model }),
      projectRoots: () => Promise.resolve({ status: "ok", data: [] }),
      projectCurrent: () => Promise.resolve({ status: "ok", data: null }),
      fsReadDir: () => Promise.resolve({ status: "ok", data: [] }),
    },
  };
});
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/home/me" }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

const ROOT = "/code/erms";
const LINKED = ["/code/cloud-auth-common", "/code/cloud-auth-server", "/code/cloud-auth-gateway"];
const NOTES = "/data/notes";

function mavenModel(dirs: string[]): BuildModel {
  return {
    gradle: [],
    maven: {
      profiles: [],
      syncedAt: 1,
      stale: false,
      syncError: null,
      projects: dirs.map((dir) => ({
        pom: dir ? `${dir}/pom.xml` : "pom.xml",
        dir,
        groupId: "example",
        artifactId: dir ? dir.slice(dir.lastIndexOf("/") + 1) : "erms",
        version: "1",
        packaging: "jar",
        displayName: dir ? dir.slice(dir.lastIndexOf("/") + 1) : "erms",
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
      })),
    },
  };
}

let dispose: () => void = () => {};

beforeEach(() => {
  localStorage.clear();
  backend.model = mavenModel(["", ...LINKED]);
  setProjectFsForTests(
    new MemoryFs(
      {
        [`${ROOT}/pom.xml`]: "x",
        [`${NOTES}/readme.txt`]: "x",
        ...Object.fromEntries(LINKED.map((dir) => [`${dir}/pom.xml`, "x"])),
      },
      ROOT,
    ),
    ROOT,
  );
  provideEditorService({ openFile: async () => {}, activePath: () => null } as unknown as EditorService);
  useProject.setState({
    project: { name: "erms", root: ROOT, trusted: true } as never,
    settings: { projectStructure: { contentRoots: [NOTES] } } as never,
  });
  useBuildModel.setState({ root: ROOT, model: backend.model, gradleOffline: false });
  dispose = activate();
});

afterEach(() => {
  dispose();
  useProjectViewRoots.setState({ roots: new Map() });
  useBuildModel.setState({ root: null, model: null, gradleOffline: false });
  useProject.setState({ project: null, settings: null });
  setProjectFsForTests(null);
});

const iconOf = (path: string) =>
  document.querySelector(`[data-project-path="${path}"]`)?.getAttribute("data-project-icon");

describe("external Maven roots in the project tree", () => {
  it("uses the Maven project icon for linked roots and drops them when they are unlinked", async () => {
    render(<ProjectView />);
    const tree = screen.getByRole("tree", { name: "Project" });
    await waitFor(() => expect(iconOf(ROOT)).toBe("maven-project"));
    for (const path of LINKED) {
      expect(within(tree).getByText(path.slice(path.lastIndexOf("/") + 1))).toBeInTheDocument();
      expect(iconOf(path)).toBe("maven-project");
    }
    // A plain content root stays a folder. It is not a Maven project.
    expect(iconOf(NOTES)).toBe("module");

    backend.model = mavenModel([""]);
    act(() => useBuildModel.setState({ root: ROOT, model: backend.model, gradleOffline: false }));
    await waitFor(() => expect(document.querySelector(`[data-project-path="${LINKED[0]}"]`)).toBeNull());
    for (const path of LINKED) expect(document.querySelector(`[data-project-path="${path}"]`)).toBeNull();
    expect(iconOf(ROOT)).toBe("maven-project");
    expect(iconOf(NOTES)).toBe("module");
  });
});
