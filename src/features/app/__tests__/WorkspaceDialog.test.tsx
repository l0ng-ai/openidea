import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { WorkspaceDialogHost, showWorkspaceDialog } from "../WorkspaceDialog";
import { openProjectInWindow } from "../windows";

vi.mock("../windows", () => ({ openProjectInWindow: vi.fn(async () => {}) }));
vi.mock("@/platform/remote", () => ({ isRemoteWindow: () => false }));

beforeEach(() => {
  vi.restoreAllMocks();
  useProject.setState({ project: null, settings: null, lightEdit: false });
});

it("creates a workspace from the pending project field without an extra Add click", async () => {
  const save = vi.spyOn(commands, "workspaceCreate").mockResolvedValue({ status: "ok", data: "/work/full" });
  showWorkspaceDialog("create");
  render(<WorkspaceDialogHost />);
  fireEvent.change(screen.getByLabelText("Workspace location"), { target: { value: "/work/full" } });
  fireEvent.change(screen.getByLabelText("Project folder path"), { target: { value: "/work/frontend" } });
  fireEvent.click(screen.getByRole("button", { name: /^Create$/ }));
  await waitFor(() => expect(save).toHaveBeenCalledWith("/work/full", "Workspace", ["/work/frontend"]));
  expect(openProjectInWindow).toHaveBeenCalledWith("/work/full", false);
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
