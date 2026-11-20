import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpBackgroundProject } from "@/bindings";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  unload: vi.fn(),
  execute: vi.fn(async (_id: string, _arg?: unknown) => {}),
}));
vi.mock("@/platform/actions", async (original) => ({
  ...(await original<object>()),
  executeAction: mocks.execute,
}));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: { ...real.commands, mcpBackgroundProjects: mocks.list, mcpUnloadBackgroundProject: mocks.unload },
  };
});

const { emitLocalIdeEvent } = await import("@/platform/ipc");
const { useRemote } = await import("@/platform/remote");
const { BackgroundStatus } = await import("./BackgroundStatus");

const ok = <T,>(data: T) => ({ status: "ok" as const, data });
const project = (root: string, patch: Partial<McpBackgroundProject> = {}): McpBackgroundProject => ({
  root,
  idleSeconds: 0,
  ...patch,
});
const inventory = project("/projects/inventory");
const billing = project("/projects/billing", { keptOpenBy: { kind: "request" } });

async function show(projects: McpBackgroundProject[]) {
  mocks.list.mockResolvedValue(ok(projects));
  render(<BackgroundStatus />);
  await act(async () => {});
}
const openPopup = async () => {
  fireEvent.click(screen.getByRole("button", { name: /Background Projects/ }));
  await act(async () => {});
  return screen.getByRole("dialog", { name: "Background Projects" });
};

beforeEach(() => {
  mocks.list.mockReset();
  mocks.unload.mockReset().mockResolvedValue(ok(null));
  mocks.execute.mockClear();
});
afterEach(() => {
  cleanup();
  useRemote.setState({ session: null });
});

describe("background projects in the status bar", () => {
  it("renders nothing while no project is loaded", async () => {
    await show([]);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows how many projects are loaded", async () => {
    await show([inventory, billing]);
    expect(screen.getByRole("button", { name: /Background Projects/ })).toHaveTextContent("2");
  });

  it("lists each project with its name, path and state", async () => {
    await show([inventory, billing]);
    const popup = await openPopup();
    expect(within(popup).getByText("inventory")).toBeInTheDocument();
    expect(within(popup).getByText("/projects/billing")).toBeInTheDocument();
    expect(within(popup).getByText("Answering a request")).toBeInTheDocument();
    expect(within(popup).getByText("Last request just now")).toBeInTheDocument();
  });

  it("opens with the focus on the list, so no row's state gives way to its actions", async () => {
    await show([inventory]);
    const popup = await openPopup();
    expect(popup.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBeInstanceOf(HTMLButtonElement);
  });

  it("stays hidden in a remote window, whose server serves no background projects", async () => {
    useRemote.setState({
      session: { root: "/srv/app" } as NonNullable<ReturnType<typeof useRemote.getState>["session"]>,
    });
    await show([inventory]);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("names a project at the file system root by its path", async () => {
    await show([project("/")]);
    const popup = await openPopup();
    expect(within(popup).getAllByText("/").length).toBe(2);
  });

  it("opens a project in its own window from its row", async () => {
    await show([inventory, billing]);
    const popup = await openPopup();
    fireEvent.click(within(popup).getByRole("button", { name: "Open /projects/billing in a new window" }));
    expect(mocks.execute).toHaveBeenCalledWith("file.openInNewWindow", "/projects/billing");
  });

  it("unloads the project of the row", async () => {
    await show([inventory, billing]);
    const popup = await openPopup();
    fireEvent.click(within(popup).getByRole("button", { name: "Unload /projects/inventory" }));
    expect(mocks.unload).toHaveBeenCalledTimes(1);
    expect(mocks.unload).toHaveBeenCalledWith("/projects/inventory");
  });

  it("unloads every listed project once with Unload All", async () => {
    await show([inventory, billing]);
    const popup = await openPopup();
    fireEvent.click(within(popup).getByRole("button", { name: "Unload All" }));
    expect(mocks.unload.mock.calls.map((c) => c[0])).toEqual(["/projects/inventory", "/projects/billing"]);
  });

  it("closes the popup before it opens the MCP server settings", async () => {
    await show([inventory]);
    const popup = await openPopup();
    mocks.execute.mockImplementationOnce(async () => {
      expect(popup.isConnected).toBe(false);
    });
    fireEvent.click(within(popup).getByRole("button", { name: "MCP Server Settings…" }));
    expect(mocks.execute).toHaveBeenCalledWith("file.settings", "agents.mcpServer");
    expect(screen.queryByRole("dialog", { name: "Background Projects" })).toBeNull();
  });

  it("closes the popup and hides the item when the last project unloads", async () => {
    await show([inventory]);
    await openPopup();
    mocks.list.mockResolvedValue(ok([]));
    await act(async () => emitLocalIdeEvent({ type: "mcpBackgroundProjectsChanged" }));
    expect(screen.queryByRole("dialog", { name: "Background Projects" })).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
