import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpBackgroundProject } from "@/bindings";

const mocks = vi.hoisted(() => ({
  choose: vi.fn(),
  list: vi.fn(),
  unload: vi.fn(),
}));
vi.mock("@/platform/choosePath", () => ({ choosePath: mocks.choose }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: { ...real.commands, mcpBackgroundProjects: mocks.list, mcpUnloadBackgroundProject: mocks.unload },
  };
});

const { stage, useSettingsDialog } = await import("../model/staging");
const { validateSettings, MCP_BACKGROUND_IDLE_LIMITS, MCP_BACKGROUND_PROJECT_LIMITS } = await import("../model/schema");
const { MCP_SERVER_PAGE } = await import("../pages/mcpServer");
const { specLabels } = await import("../pages/spec");
const { useRemote } = await import("@/platform/remote");

const section = MCP_SERVER_PAGE.sections!.find((s) => s.title === "Background projects")!;
const custom = (label: string) => {
  const option = section.options.find((o) => o.label === label);
  if (option?.kind !== "custom") throw new Error(`${label} is not a custom option`);
  return option.component;
};
const Mode = custom("Serve without a window");
const Folders = custom("Folders");
const IdleMinutes = custom("Unload after");
const ProjectLimit = custom("Project limit");
const OpenNow = custom("Open now");

const ok = <T,>(data: T) => ({ status: "ok" as const, data });
const project = (patch: Partial<McpBackgroundProject> = {}): McpBackgroundProject => ({
  root: "/projects/inventory",
  idleSeconds: 0,
  ...patch,
});
const stagedPaths = () => useSettingsDialog.getState().staged["global|mcpServer.backgroundProjectPaths"]?.value;
const configure = (mcpServer: object) =>
  useSettingsDialog.setState({ globalBase: validateSettings({ mcpServer }), staged: {} });
const withFolders = (paths: string[]) => configure({ backgroundProjectPaths: paths });

const saved = useSettingsDialog.getState();
beforeEach(() => {
  mocks.choose.mockReset();
  mocks.list.mockReset();
  mocks.unload.mockReset();
  mocks.unload.mockResolvedValue(ok(null));
  configure({ enabled: true, backgroundProjects: "trusted" });
});
afterEach(() => {
  useSettingsDialog.setState(saved);
  useRemote.setState({ session: null });
});

describe("Background projects settings section", () => {
  it("follows the server section with the mode, the folders, the limits and the live list", () => {
    expect(MCP_SERVER_PAGE.sections!.map((s) => s.title)).toEqual([undefined, "Background projects"]);
    expect(section.options.map((o) => o.label)).toEqual([
      "Serve without a window",
      "Folders",
      "Unload after",
      "Project limit",
      "Open now",
    ]);
  });

  it("offers off, trusted and listed projects for the mode", () => {
    render(<Mode />);
    const mode = screen.getByLabelText("Serve without a window");
    expect(mode).toBeEnabled();
    expect(mode).toHaveTextContent("Trusted projects");
    expect(specLabels(MCP_SERVER_PAGE)).toEqual(expect.arrayContaining(["Off", "Trusted projects", "Listed projects"]));
  });

  it("limits the idle minutes and the project count as the settings schema does", () => {
    render(<IdleMinutes />);
    const idle = screen.getByRole("textbox", { name: "Unload after" });
    expect(idle).toHaveValue("30");
    expect(idle).toHaveAttribute("aria-valuemin", String(MCP_BACKGROUND_IDLE_LIMITS.min));
    expect(idle).toHaveAttribute("aria-valuemax", String(MCP_BACKGROUND_IDLE_LIMITS.max));
    expect(idle).toHaveAttribute("inputmode", "numeric");
    expect(screen.getByText("min")).toBeInTheDocument();
    cleanup();
    render(<ProjectLimit />);
    const limit = screen.getByRole("textbox", { name: "Project limit" });
    expect(limit).toHaveValue("8");
    expect(limit).toHaveAttribute("aria-valuemin", String(MCP_BACKGROUND_PROJECT_LIMITS.min));
    expect(limit).toHaveAttribute("aria-valuemax", String(MCP_BACKGROUND_PROJECT_LIMITS.max));
    expect(limit).toHaveAttribute("inputmode", "numeric");
  });

  it("stages the idle minutes and the project count under their settings keys", () => {
    render(<IdleMinutes />);
    fireEvent.change(screen.getByRole("textbox", { name: "Unload after" }), { target: { value: "45" } });
    render(<ProjectLimit />);
    fireEvent.change(screen.getByRole("textbox", { name: "Project limit" }), { target: { value: "4" } });
    const staged = useSettingsDialog.getState().staged;
    expect(staged["global|mcpServer.backgroundIdleMinutes"]?.value).toBe(45);
    expect(staged["global|mcpServer.backgroundProjectLimit"]?.value).toBe(4);
  });

  it("is found by search through its title, labels and keywords", () => {
    const labels = specLabels(MCP_SERVER_PAGE);
    expect(labels).toEqual(
      expect.arrayContaining([
        "Background projects",
        "Serve without a window",
        "Trusted projects",
        "Listed projects",
        "Folders",
        "Unload after",
        "Project limit",
        "Open now",
        "Unload",
      ]),
    );
  });
});

describe("in a remote window, whose settings are the remote host's", () => {
  const remote = () =>
    useRemote.setState({
      session: { root: "/srv/app" } as NonNullable<ReturnType<typeof useRemote.getState>["session"]>,
    });

  it("turns off the mode, the folders, the idle time and the limit", () => {
    remote();
    render(
      <>
        <Mode />
        <Folders />
        <IdleMinutes />
        <ProjectLimit />
      </>,
    );
    expect(screen.getByLabelText("Serve without a window")).toBeDisabled();
    expect(screen.getByRole("listbox", { name: "Folders" }).closest("[inert]")).not.toBeNull();
    expect(screen.getByRole("textbox", { name: "Unload after" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Project limit" })).toBeDisabled();
  });

  it("says a remote host serves only its window's project and lists nothing", async () => {
    remote();
    mocks.list.mockResolvedValue(ok([project()]));
    render(<OpenNow />);
    await act(async () => {});
    expect(screen.getByText("A remote host serves only the project open in its window")).toBeInTheDocument();
    expect(screen.queryByText("/projects/inventory")).toBeNull();
    expect(screen.queryByRole("button", { name: /Unload/ })).toBeNull();
  });
});

describe("options that depend on the mode", () => {
  const renderAll = () =>
    render(
      <>
        <Folders />
        <IdleMinutes />
        <ProjectLimit />
      </>,
    );
  const controls = () => ({
    folders: screen.getByRole("listbox", { name: "Folders" }).closest("[inert]"),
    idle: screen.getByRole("textbox", { name: "Unload after" }),
    limit: screen.getByRole("textbox", { name: "Project limit" }),
  });

  it("turns off the folders, the idle time and the limit while the mode is Off", () => {
    configure({ enabled: true, backgroundProjects: "off" });
    renderAll();
    const { folders, idle, limit } = controls();
    expect(folders).not.toBeNull();
    expect(idle).toBeDisabled();
    expect(limit).toBeDisabled();
  });

  it.each(["trusted", "listed"])("leaves them editable in the %s mode", (backgroundProjects) => {
    configure({ enabled: true, backgroundProjects });
    renderAll();
    const { folders, idle, limit } = controls();
    expect(folders).toBeNull();
    expect(idle).toBeEnabled();
    expect(limit).toBeEnabled();
  });

  it("follows the staged mode before Apply", () => {
    renderAll();
    expect(controls().idle).toBeEnabled();
    act(() => stage("agents.mcpServer", "global", "mcpServer.backgroundProjects", "off"));
    const { folders, idle, limit } = controls();
    expect(folders).not.toBeNull();
    expect(idle).toBeDisabled();
    expect(limit).toBeDisabled();
  });

  it("keeps the folders listed while they are turned off", () => {
    configure({ enabled: true, backgroundProjects: "off", backgroundProjectPaths: ["/projects/inventory"] });
    render(<Folders />);
    expect(screen.getByText("/projects/inventory")).toBeInTheDocument();
  });
});

describe("Folders option", () => {
  it("shows the staged folders in the list editor and says so when there are none", () => {
    render(<Folders />);
    expect(screen.getByText("No folders listed")).toBeInTheDocument();
    cleanup();
    withFolders(["/projects/inventory", "/projects/billing"]);
    render(<Folders />);
    const list = screen.getByRole("listbox", { name: "Folders" });
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["/projects/inventory", "/projects/billing"]);
  });

  it("asks for a folder", async () => {
    mocks.choose.mockResolvedValue(null);
    render(<Folders />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add" })));
    expect(mocks.choose).toHaveBeenCalledWith(
      expect.objectContaining({ directory: true, title: "Choose Folder to Serve" }),
    );
  });

  it("stages the folder picked and sends nothing to the backend before Apply", async () => {
    mocks.choose.mockResolvedValue("/projects/billing");
    withFolders(["/projects/inventory"]);
    render(<Folders />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add" })));
    expect(stagedPaths()).toEqual(["/projects/inventory", "/projects/billing"]);
    expect(screen.getByText("/projects/billing")).toBeInTheDocument();
    expect(mocks.unload).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });
});

describe("Open now option", () => {
  const mount = async () => {
    render(<OpenNow />);
    await act(async () => {});
  };

  it("says no project is loaded when the server and the mode are on and the list is empty", async () => {
    mocks.list.mockResolvedValue(ok([]));
    await mount();
    expect(screen.getByText("No background projects are loaded")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Unload/ })).toBeNull();
  });

  it("says background projects are off when the staged mode is off", async () => {
    mocks.list.mockResolvedValue(ok([]));
    stage("agents.mcpServer", "global", "mcpServer.backgroundProjects", "off");
    await mount();
    expect(screen.getByText("Background projects are off")).toBeInTheDocument();
    expect(screen.queryByText("No background projects are loaded")).toBeNull();
  });

  it("says the server is off when it is disabled, whatever the mode", async () => {
    mocks.list.mockResolvedValue(ok([]));
    configure({ enabled: false, backgroundProjects: "listed" });
    await mount();
    expect(screen.getByText("The MCP server is off")).toBeInTheDocument();
    expect(screen.queryByText("No background projects are loaded")).toBeNull();
    cleanup();
    configure({ enabled: false, backgroundProjects: "off" });
    await mount();
    expect(screen.getByText("The MCP server is off")).toBeInTheDocument();
  });

  it("lists a loaded project while the mode is staged off, as it is still loaded", async () => {
    mocks.list.mockResolvedValue(ok([project()]));
    stage("agents.mcpServer", "global", "mcpServer.backgroundProjects", "off");
    await mount();
    expect(screen.getByText("/projects/inventory")).toBeInTheDocument();
    expect(screen.queryByText("Background projects are off")).toBeNull();
  });

  it("shows a project's folder name, its path and its state", async () => {
    mocks.list.mockResolvedValue(ok([project({ idleSeconds: 720, unloadsInSeconds: 1080 })]));
    await mount();
    expect(screen.getByText("inventory")).toBeInTheDocument();
    expect(screen.getByText("/projects/inventory")).toBeInTheDocument();
    expect(screen.getByText("Idle 12 min, unloads in 18 min")).toBeInTheDocument();
    expect(screen.queryByText("No background projects are loaded")).toBeNull();
  });

  it("shows one row per project with its own state line", async () => {
    mocks.list.mockResolvedValue(
      ok([
        project({ keptOpenBy: { kind: "request" } }),
        project({ root: "/projects/billing", keptOpenBy: { kind: "run", name: "dev server" } }),
        project({ root: "/projects/reports", idleSeconds: 5 }),
        project({ root: "/projects/archive", idleSeconds: 3600 }),
      ]),
    );
    await mount();
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Answering a request"),
      expect.stringContaining("Kept open by the run dev server"),
      expect.stringContaining("Last request just now"),
      expect.stringContaining("Idle 60 min"),
    ]);
  });

  it("unloads the project of the row at once", async () => {
    mocks.list.mockResolvedValue(ok([project(), project({ root: "/projects/billing" })]));
    await mount();
    const row = screen.getByText("/projects/billing").closest("li")!;
    await act(async () => fireEvent.click(within(row).getByRole("button", { name: "Unload /projects/billing" })));
    expect(mocks.unload).toHaveBeenCalledTimes(1);
    expect(mocks.unload).toHaveBeenCalledWith("/projects/billing");
  });

  it("names each Unload button by the whole folder, so folders with one name stay apart", async () => {
    mocks.list.mockResolvedValue(
      ok([project({ root: "/projects/clients/billing" }), project({ root: "/projects/internal/billing" })]),
    );
    await mount();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Unload /projects/internal/billing" })));
    expect(screen.getAllByRole("button", { name: /^Unload / })).toHaveLength(2);
    expect(mocks.unload).toHaveBeenCalledWith("/projects/internal/billing");
  });

  it("does not change the staged settings when a project is unloaded", async () => {
    mocks.list.mockResolvedValue(ok([project()]));
    await mount();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Unload /projects/inventory" })));
    expect(useSettingsDialog.getState().staged).toEqual({});
  });
});
