import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { executeAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import type { BuildModel, ProjectInfo } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { MavenView } from "./BuildToolView";
import { activate } from "./index";
import { useBuild } from "./store";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  model: vi.fn(),
  configs: vi.fn(),
  open: vi.fn(),
  confirm: vi.fn(),
  menu: vi.fn(),
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
    },
  };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("@/workbench/messages", () => ({ confirm: mocks.confirm }));
vi.mock("@/ui", async (original) => ({ ...(await original<typeof import("@/ui")>()), showContextMenu: mocks.menu }));

const model: BuildModel = {
  gradle: null,
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
  mocks.get.mockResolvedValue({ languages: { java: { maven: { unlinkedProjects: [] } } } });
  mocks.set.mockResolvedValue({});
  mocks.model.mockResolvedValue(model);
  mocks.configs.mockResolvedValue([]);
  mocks.confirm.mockResolvedValue(true);
  useProject.setState({ project: { root: "/p" } as ProjectInfo });
  setContext("projectOpen", true);
  await act(async () => {
    dispose = activate();
  });
});
afterEach(() => {
  dispose();
  useProject.setState({ project: null });
  setContext("projectOpen", false);
});

it("offers unlink on a root's context menu and persists a confirmed project setting", async () => {
  render(<MavenView />);
  fireEvent.contextMenu(screen.getByText("project-a"));
  expect(mocks.menu).toHaveBeenCalledWith(
    expect.anything(),
    expect.arrayContaining([expect.objectContaining({ action: "maven.unlinkProjects", arg: { pom: "a/pom.xml" } })]),
  );
  await act(async () => {
    await executeAction("maven.unlinkProjects", { pom: "a/pom.xml" });
  });
  expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Unlink Maven projects?" }));
  expect(mocks.set).toHaveBeenCalledWith("project", "languages.java.maven.unlinkedProjects", '["a/pom.xml"]');
  expect(mocks.model).toHaveBeenCalledTimes(2);
});

it("does not unlink modules or write after cancelled confirmation", async () => {
  mocks.confirm.mockResolvedValue(false);
  await executeAction("maven.unlinkProjects", { pom: "a/pom.xml" });
  expect(mocks.set).not.toHaveBeenCalled();
  act(() =>
    useBuild.setState({
      model: { ...model, maven: { ...model.maven!, projects: [{ ...model.maven!.projects[0]!, aggregated: true }] } },
    }),
  );
  render(<MavenView />);
  await executeAction("maven.unlinkProjects", { pom: "a/pom.xml" });
  expect(mocks.confirm).toHaveBeenCalledTimes(1);
});

it("re-adds a picked POM using the plus button and preserves other unlinked roots", async () => {
  mocks.get.mockResolvedValue({ languages: { java: { maven: { unlinkedProjects: ["a/pom.xml", "b/pom.xml"] } } } });
  mocks.open.mockResolvedValue("/p/a/pom.xml");
  act(() => useBuild.setState({ model: { ...model, maven: { ...model.maven!, projects: [] } } }));
  render(<MavenView />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Add Maven Projects" }));
  });
  expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: "/p", directory: false }));
  expect(mocks.set).toHaveBeenCalledWith("project", "languages.java.maven.unlinkedProjects", '["b/pom.xml"]');
});

it.each([null, "/outside/pom.xml", "/p/a/build.xml", "/p/../outside/pom.xml", "/p/a/pom.xml"])(
  "ignores cancelled, invalid, outside or already linked picks: %s",
  async (picked) => {
    mocks.open.mockResolvedValue(picked);
    await executeAction("maven.addProjects");
    expect(mocks.set).not.toHaveBeenCalled();
  },
);
