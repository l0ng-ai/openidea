import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { open } from "@tauri-apps/plugin-dialog";
import { commands, type ProjectDiscovery } from "@/platform/ipc";
import { provideProjectTrustPrompt } from "@/platform/projectTrust";
import { invokeLocal } from "@/platform/tauriCore";
import { useProject } from "@/platform/project";
import { WorkspaceDialogHost, showWorkspaceDialog } from "../WorkspaceDialog";
import { openProjectWithPolicy } from "../windows";

vi.mock("../windows", () => ({ openProjectWithPolicy: vi.fn(async () => {}) }));
vi.mock("@/platform/remote", () => ({ isRemoteWindow: () => false }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/platform/tauriCore", async (original) => ({
  ...(await original<typeof import("@/platform/tauriCore")>()),
  invokeLocal: vi.fn(async () => {}),
}));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(openProjectWithPolicy).mockClear();
  vi.mocked(open).mockReset();
  vi.spyOn(commands, "projectTrustStatus").mockResolvedValue({
    status: "ok",
    data: { root: "/work", trusted: true, decided: true },
  });
  vi.mocked(invokeLocal).mockClear();
  useProject.setState({ project: null, settings: null, lightEdit: false });
});

const discovered = (path: string, root: string) => ({ path, root, relative_path: path.slice(root.length + 1) });

it.each(["create", "manage"] as const)(
  "merges folder selections and adds only checked projects in %s mode",
  async (mode) => {
    const project = {
      root: mode === "manage" ? "/work/workspace" : "/work/one/linked",
      name: "Workspace",
      trusted: true,
      isGit: false,
      settings: {},
      workspace: mode === "manage" ? { name: "Workspace", projects: ["/work/one/linked"], version: 1 } : null,
    };
    useProject.setState({ project, settings: {} } as never);
    vi.mocked(open).mockResolvedValue(["/work/one", "/work/two", "/work/empty", "/work/one/direct"]);
    const scan = vi.spyOn(commands, "workspaceDiscoverProjects").mockResolvedValue({
      status: "ok",
      data: {
        direct: ["/work/empty", "/work/one/direct"],
        projects: [
          discovered("/work/one/linked", "/work/one"),
          discovered("/work/one/direct", "/work/one"),
          discovered("/work/one/frontend", "/work/one"),
          discovered("/work/two/group/backend", "/work/two"),
        ],
        truncated: false,
      },
    });
    const create = vi.spyOn(commands, "workspaceCreate").mockResolvedValue({ status: "ok", data: "/work/workspace" });
    const update = vi.spyOn(commands, "workspaceUpdate").mockResolvedValue({ status: "ok", data: project } as never);
    showWorkspaceDialog(mode);
    render(<WorkspaceDialogHost />);
    fireEvent.click(screen.getByRole("button", { name: "Add Projects…" }));
    const linked = await screen.findByRole("checkbox", { name: "linked" });
    expect(scan).toHaveBeenCalledWith(expect.any(Number), [
      "/work/one",
      "/work/two",
      "/work/empty",
      "/work/one/direct",
    ]);
    expect(linked).toBeDisabled();
    expect(linked).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "direct" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "direct" })).not.toBeChecked();
    expect(screen.getAllByText("Already linked")).toHaveLength(2);
    expect(screen.getByRole("checkbox", { name: "frontend" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "group/backend" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Select None" }));
    expect(screen.getByRole("button", { name: "Add Selected" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Select All" }));
    expect(linked).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "group/backend" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Selected" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: mode === "create" ? /^Create$/ : /^Apply$/ }));
    const included = ["/work/one/linked", "/work/empty", "/work/one/direct", "/work/one/frontend"];
    await waitFor(() =>
      mode === "create"
        ? expect(create).toHaveBeenCalledWith("/work/one/workspace", "Workspace", included)
        : expect(update).toHaveBeenCalledWith("Workspace", included),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  },
);

it("adds direct and empty folders without a checklist and retains an entry-limit warning", async () => {
  vi.mocked(open).mockResolvedValue(["/work/direct", "/work/empty"]);
  vi.spyOn(commands, "workspaceDiscoverProjects").mockResolvedValue({
    status: "ok",
    data: { direct: ["/work/direct", "/work/empty"], projects: [], truncated: true },
  });
  showWorkspaceDialog("create");
  render(<WorkspaceDialogHost />);
  fireEvent.click(screen.getByRole("button", { name: "Add Projects…" }));
  expect(await screen.findAllByRole("listitem")).toHaveLength(2);
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Search stopped at the entry limit.");
});

it("returns from the checklist without adding unchecked projects", async () => {
  vi.mocked(open).mockResolvedValue("/work");
  vi.spyOn(commands, "workspaceDiscoverProjects").mockResolvedValue({
    status: "ok",
    data: { direct: [], projects: [discovered("/work/app", "/work")], truncated: false },
  });
  showWorkspaceDialog("create");
  render(<WorkspaceDialogHost />);
  fireEvent.click(screen.getByRole("button", { name: "Add Projects…" }));
  fireEvent.click(await screen.findByRole("button", { name: "Back" }));
  expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
});

it("cancels scanning locally on close and ignores late results", async () => {
  vi.mocked(open).mockResolvedValue("/work");
  let finish!: (result: { status: "ok"; data: ProjectDiscovery }) => void;
  const scan = vi.spyOn(commands, "workspaceDiscoverProjects").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const routedCancel = vi.spyOn(commands, "cancelRequest");
  showWorkspaceDialog("create");
  render(<WorkspaceDialogHost />);
  fireEvent.click(screen.getByRole("button", { name: "Add Projects…" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Searching for projects…");
  expect(screen.getByRole("button", { name: "Add Projects…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(invokeLocal).toHaveBeenCalledWith("cancel_request", { id: scan.mock.calls[0]![0] });
  expect(routedCancel).not.toHaveBeenCalled();
  await act(async () =>
    finish({ status: "ok", data: { direct: [], projects: [discovered("/work/app", "/work")], truncated: false } }),
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("does not scan when the native picker is cancelled", async () => {
  vi.mocked(open).mockResolvedValue(null);
  const scan = vi.spyOn(commands, "workspaceDiscoverProjects");
  showWorkspaceDialog("create");
  render(<WorkspaceDialogHost />);
  fireEvent.click(screen.getByRole("button", { name: "Add Projects…" }));
  await waitFor(() => expect(open).toHaveBeenCalled());
  expect(scan).not.toHaveBeenCalled();
});

it("creates a workspace from the pending project field without an extra Add click", async () => {
  const save = vi.spyOn(commands, "workspaceCreate").mockResolvedValue({ status: "ok", data: "/work/full" });
  showWorkspaceDialog("create");
  render(<WorkspaceDialogHost />);
  fireEvent.change(screen.getByLabelText("Workspace location"), { target: { value: "/work/full" } });
  fireEvent.change(screen.getByLabelText("Project folder path"), { target: { value: "/work/frontend" } });
  fireEvent.click(screen.getByRole("button", { name: /^Create$/ }));
  await waitFor(() => expect(save).toHaveBeenCalledWith("/work/full", "Workspace", ["/work/frontend"]));
  expect(openProjectWithPolicy).toHaveBeenCalledWith("/work/full");
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

it("uses the shared opening policy after creation from an already open project", async () => {
  useProject.setState({
    project: { root: "/work/frontend", name: "frontend", trusted: true, isGit: false, settings: {} },
    settings: { general: { openProjectIn: "ask" } },
  } as never);
  vi.spyOn(commands, "workspaceCreate").mockResolvedValue({ status: "ok", data: "/work/full" });
  showWorkspaceDialog("create");
  render(<WorkspaceDialogHost />);
  fireEvent.change(screen.getByLabelText("Workspace location"), { target: { value: "/work/full" } });
  fireEvent.click(screen.getByRole("button", { name: /^Create$/ }));
  await waitFor(() => expect(openProjectWithPolicy).toHaveBeenCalledWith("/work/full"));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

it("retains the form and linked folders when saving fails", async () => {
  vi.spyOn(commands, "workspaceCreate").mockResolvedValue({
    status: "error",
    error: { kind: "invalidArgument", message: "Folder does not exist" },
  } as never);
  showWorkspaceDialog("create");
  render(<WorkspaceDialogHost />);
  fireEvent.change(screen.getByLabelText("Workspace location"), { target: { value: "/work/full" } });
  fireEvent.change(screen.getByLabelText("Project folder path"), { target: { value: "/work/missing" } });
  fireEvent.click(screen.getByRole("button", { name: /^Create$/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Folder does not exist");
  expect(screen.getByLabelText("Project folder path")).toHaveValue("/work/missing");
  fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it.each(["restricted", "cancelled"])("retains Manage Workspace when project trust is %s", async (decision) => {
  useProject.setState({
    project: {
      root: "/work/primary",
      name: "primary",
      trusted: true,
      isGit: false,
      settings: {},
      workspace: { version: 1, name: "primary", projects: ["/work/primary"] },
    },
  } as never);
  vi.mocked(commands.projectTrustStatus).mockResolvedValue({
    status: "ok",
    data: { root: "/work/restricted", trusted: false, decided: true },
  });
  const update = vi.spyOn(commands, "workspaceUpdate");
  const dispose = provideProjectTrustPrompt(async () => decision !== "cancelled");
  try {
    showWorkspaceDialog("manage");
    render(<WorkspaceDialogHost />);
    fireEvent.change(screen.getByLabelText("Project folder path"), { target: { value: "/work/restricted" } });
    fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Apply$/ })).toBeEnabled());
    expect(update).not.toHaveBeenCalled();
    if (decision === "restricted") {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Cannot attach /work/restricted because it is restricted. Open it separately and choose Trust Project, then attach it again.",
      );
    } else expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Project folder path")).toHaveValue("/work/restricted");
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));
  } finally {
    dispose();
  }
});
