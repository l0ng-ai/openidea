import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { RemoteEntry, Settings } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useRemoteProgress } from "@/platform/remote";
import { ConnectHost } from "./ConnectDialog";
import { closeConnectDialog, openConnectDialog, useConnectDialog } from "./model";

const { list, distros, openRemote, executeAction } = vi.hoisted(() => ({
  list: vi.fn(),
  distros: vi.fn(),
  openRemote: vi.fn(),
  executeAction: vi.fn(),
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, commands: { ...real.commands, remoteBootstrapList: list, wslDistros: distros } };
});
vi.mock("@/workbench/projectWindow", () => ({ openRemoteProject: openRemote }));
vi.mock("@/platform/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/actions")>()),
  executeAction,
}));

const entry = (path: string, isDir = true): RemoteEntry => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  isDir,
  isSymlink: false,
  size: 0,
  mtime: null,
  permissions: "rwxr-xr-x",
});

beforeEach(() => {
  vi.resetAllMocks();
  distros.mockResolvedValue({ status: "ok", data: [] });
  useProject.setState({
    project: null,
    opening: false,
    settings: {
      ssh: {
        configs: [
          { id: "first", name: "First host", host: "first.example", user: "dev" },
          { id: "selected", name: "Selected host", host: "selected.example", user: "dev" },
        ],
      },
    } as Settings,
  });
  useRemoteProgress.setState({ progress: null, location: null });
  openConnectDialog();
});

afterEach(() => closeConnectDialog());

it("browses the selected SSH host, navigates folders and opens one without a current project", async () => {
  let finish!: (result: { status: "ok"; data: RemoteEntry[] }) => void;
  list.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  openRemote.mockResolvedValue(true);
  render(<ConnectHost />);
  fireEvent.click(screen.getByRole("button", { name: "SSH configuration" }));
  fireEvent.click(screen.getByRole("option", { name: /Selected host/ }));
  fireEvent.click(screen.getByRole("button", { name: "Browse" }));
  expect(list).toHaveBeenCalledWith("selected", "~");
  expect(screen.getByRole("button", { name: "Browse" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Open" })).toBeDisabled();
  finish({
    status: "ok",
    data: [entry("/home/dev/.cache"), entry("/home/dev/projects"), entry("/home/dev/README.md", false)],
  });
  const folders = await screen.findByRole("list", { name: "Remote folders" });
  expect(
    within(folders)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["..", "projects", ".cache"]);
  expect(screen.getByLabelText("Project directory:")).toHaveValue("/home/dev");
  list.mockResolvedValueOnce({ status: "ok", data: [entry("/home/dev/projects/demo")] });
  fireEvent.click(within(folders).getByRole("button", { name: "projects" }));
  await screen.findByRole("button", { name: "demo" });
  expect(list).toHaveBeenLastCalledWith("selected", "/home/dev/projects");
  list.mockResolvedValueOnce({ status: "ok", data: [entry("/home/dev/projects")] });
  fireEvent.click(within(folders).getByRole("button", { name: ".." }));
  await waitFor(() => expect(screen.getByLabelText("Project directory:")).toHaveValue("/home/dev"));
  expect(list).toHaveBeenLastCalledWith("selected", "/home/dev");
  list.mockResolvedValueOnce({ status: "ok", data: [] });
  fireEvent.click(within(folders).getByRole("button", { name: "projects" }));
  await waitFor(() => expect(screen.getByLabelText("Project directory:")).toHaveValue("/home/dev/projects"));
  expect(within(folders).getAllByRole("button")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  await waitFor(() =>
    expect(openRemote).toHaveBeenCalledWith({ kind: "ssh", config: "selected" }, "/home/dev/projects"),
  );
  expect(useConnectDialog.getState().open).toBe(false);
  expect(useProject.getState().project).toBeNull();
});

it("shows a connection error and lets the welcome window retry Browse", async () => {
  list.mockRejectedValueOnce(new Error("Connection refused"));
  render(<ConnectHost />);
  fireEvent.change(screen.getByLabelText("Project directory:"), { target: { value: "  /srv/projects  " } });
  fireEvent.click(screen.getByRole("button", { name: "Browse" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Connection refused");
  expect(list).toHaveBeenCalledWith("first", "/srv/projects");
  expect(screen.getByRole("button", { name: "Browse" })).toBeEnabled();
  list.mockResolvedValueOnce({ status: "ok", data: [] });
  fireEvent.click(screen.getByRole("button", { name: "Browse" }));
  await screen.findByRole("list", { name: "Remote folders" });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(openRemote).not.toHaveBeenCalled();
});

it("offers SSH configuration from the welcome window and disables Browse until one exists", () => {
  useProject.setState({ settings: { ssh: { configs: [] } } as unknown as Settings });
  render(<ConnectHost />);
  expect(screen.getByRole("button", { name: "Browse" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Open" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Configure…" }));
  expect(executeAction).toHaveBeenCalledWith("file.settings", "tools.sshConfigurations");
  expect(list).not.toHaveBeenCalled();
});

it("hides the WSL choice when no distribution is installed", async () => {
  render(<ConnectHost />);
  await waitFor(() => expect(distros).toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: "Connect through" })).toBeNull();
});

it("opens a folder of the chosen WSL distribution, without browsing over SFTP", async () => {
  const installed = ["Ubuntu-24.04", "Debian"];
  distros.mockResolvedValue({ status: "ok", data: installed });
  openRemote.mockResolvedValue(true);
  render(<ConnectHost />);
  fireEvent.click(await screen.findByRole("button", { name: "Connect through" }));
  fireEvent.click(screen.getByRole("option", { name: "WSL" }));
  expect(screen.queryByRole("button", { name: "Browse" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "WSL distribution" }));
  fireEvent.click(screen.getByRole("option", { name: installed[1] }));
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  await waitFor(() => expect(openRemote).toHaveBeenCalledWith({ kind: "wsl", distro: installed[1] }, "~"));
  expect(list).not.toHaveBeenCalled();
});
