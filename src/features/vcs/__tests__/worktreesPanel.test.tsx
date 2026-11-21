import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const { list, add, branches, move, remove, open, confirm, windowOpenRemote } = vi.hoisted(() => ({
  list: vi.fn(),
  add: vi.fn(),
  branches: vi.fn(),
  move: vi.fn(),
  remove: vi.fn(),
  open: vi.fn(),
  confirm: vi.fn(),
  windowOpenRemote: vi.fn(),
}));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsWorktrees: list,
      vcsAddWorktree: add,
      vcsBranches: branches,
      vcsMoveWorktree: move,
      vcsRemoveWorktree: remove,
      windowOpenRemote,
    },
  };
});
vi.mock("@/platform/dialog", () => ({ open }));
vi.mock("../dialogs", async (original) => ({
  ...(await original<typeof import("../dialogs")>()),
  confirmDialog: confirm,
}));

import { showNewWorktree, WorktreesPanel } from "../gitMenuDialogs";
import { VcsDialogHost } from "../dialogs";
import { useVcs } from "../store";
import { useProject } from "@/platform/project";
import { useRemote } from "@/platform/remote";
import { registerAction } from "@/platform/actions";

const worktrees = [
  { path: "/work/app", branch: "main", head: "12345678", main: true, locked: false, prunable: false },
  { path: "/work/app-feature", branch: "feature", head: "12345678", main: false, locked: false, prunable: false },
];
const ssh = { kind: "ssh", config: "test-linux" } as const;
const wsl = { kind: "wsl", distro: "Ubuntu" } as const;
const ok = <T,>(data: T) => ({ status: "ok" as const, data });
const fail = (message: string) => ({ status: "error", error: { kind: "invalidInput", message, detail: null } });

const rowAt = async (path: string) =>
  within((await screen.findByText(path)).closest<HTMLElement>('[role="treeitem"]')!);

beforeEach(() => {
  useProject.setState({ project: { root: "/work/app-feature" } as never });
  list.mockReset().mockResolvedValue(ok(worktrees));
  add.mockReset().mockResolvedValue(ok(null));
  branches.mockReset().mockResolvedValue(ok([]));
  move.mockReset();
  remove.mockReset();
  open.mockReset();
  confirm.mockReset().mockResolvedValue(true);
  useVcs.setState({ root: "/work/app-feature", roots: ["/work/app-feature"], repo: null });
});

it("creates and opens a worktree from the selected branch, requiring a new branch when it is already checked out", async () => {
  const run = vi.fn();
  const dispose = registerAction({ id: "file.openProjectPath", title: "Open Project Path", run });
  try {
    render(<VcsDialogHost />);
    act(() =>
      showNewWorktree({
        repo: "/work/app",
        branch: { name: "feature", current: false, remote: false },
        open: true,
      }),
    );
    expect(await screen.findByRole("dialog", { name: "New Worktree" })).toBeInTheDocument();
    const newBranch = screen.getByRole("checkbox", { name: "Create a new branch" });
    await waitFor(() => expect(newBranch).toBeDisabled());
    expect(newBranch).toBeChecked();
    expect(screen.getByRole("textbox", { name: "New branch name" })).toHaveAttribute("placeholder", "feature-wt");
    expect(screen.getByRole("textbox", { name: "Folder" })).toHaveValue("/work/app-feature-wt");
    fireEvent.click(screen.getByRole("button", { name: "Create and Open Worktree" }));
    await waitFor(() =>
      expect(run).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          arg: { path: "/work/app-feature-wt", newWindow: true },
        }),
      ),
    );
    expect(add).toHaveBeenCalledExactlyOnceWith(
      "/work/app",
      "/work/app-feature-wt",
      "refs/heads/feature",
      "feature-wt",
    );
  } finally {
    dispose();
  }
});

it("marks the linked project root current when its main worktree is also listed", async () => {
  render(<WorktreesPanel />);
  expect((await rowAt("/work/app-feature")).getByRole("img", { name: "current" })).toBeInTheDocument();
  expect((await rowAt("/work/app")).queryByRole("img", { name: "current" })).toBeNull();
});

it("marks both opened roots current while grouping their repository once", async () => {
  useVcs.setState({ roots: ["/work/app-feature", "/work/app"] });
  render(<WorktreesPanel />);
  expect((await rowAt("/work/app-feature")).getByRole("img", { name: "current" })).toBeInTheDocument();
  expect((await rowAt("/work/app")).getByRole("img", { name: "current" })).toBeInTheDocument();
  expect(screen.getAllByRole("treeitem")).toHaveLength(3);
});

it.each(["/work/app-feature", "/work/app-feature/src"])(
  "disables removal of the worktree containing project %s",
  async (root) => {
    useProject.setState({ project: { root } as never });
    render(<WorktreesPanel />);
    fireEvent.mouseDown(await screen.findByText("feature"));
    const remove = screen.getByRole("button", { name: "Remove Worktree" });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAttribute("data-tooltip", "Cannot remove a worktree containing the open project.");
  },
);

it.each(["/work", "/work/app-feature-sibling"])(
  "allows removal when project %s is outside the worktree",
  async (root) => {
    useProject.setState({ project: { root } as never });
    render(<WorktreesPanel />);
    fireEvent.mouseDown(await screen.findByText("feature"));
    expect(screen.getByRole("button", { name: "Remove Worktree" })).toBeEnabled();
  },
);

it("keeps the main worktree protected", async () => {
  useProject.setState({ project: { root: "/work" } as never });
  render(<WorktreesPanel />);
  fireEvent.mouseDown(await screen.findByText("main"));
  expect(screen.getByRole("button", { name: "Remove Worktree" })).toBeDisabled();
});

it("keeps a failed move's error and original selection through refresh, then clears the error on success", async () => {
  const occupied = "/work/occupied/app-feature";
  const free = "/work/free/app-feature";
  const failure = `${occupied} already exists`;
  useProject.setState({ project: { root: "/work/app" } as never });
  useVcs.setState({ root: "/work/app", roots: ["/work/app"] });
  open.mockResolvedValueOnce(occupied).mockResolvedValueOnce(free);
  move.mockResolvedValueOnce(fail(failure)).mockResolvedValueOnce(ok(null));
  render(<WorktreesPanel />);
  fireEvent.mouseDown(await screen.findByText("feature"));
  const moveButton = screen.getByRole("button", { name: "Move Worktree…" });

  fireEvent.click(moveButton);
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  expect(move).toHaveBeenCalledWith("/work/app", "/work/app-feature", occupied);
  expect(await screen.findByRole("alert")).toHaveTextContent(failure);
  expect(screen.getByRole("treeitem", { name: /feature/ })).toHaveAttribute("aria-selected", "true");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh" })));
  expect(list).toHaveBeenCalledTimes(3);
  expect(screen.getByRole("alert")).toHaveTextContent(failure);

  list.mockResolvedValueOnce(ok([worktrees[0], { ...worktrees[1], path: free }]));
  fireEvent.click(moveButton);
  expect(await screen.findByText(free)).toBeVisible();
  expect(move).toHaveBeenLastCalledWith("/work/app", "/work/app-feature", free);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("keeps the error and selected worktree after force removal fails", async () => {
  const failure = "Worktree is locked";
  useProject.setState({ project: { root: "/work/app" } as never });
  useVcs.setState({ root: "/work/app", roots: ["/work/app"] });
  remove.mockResolvedValueOnce(fail("Worktree contains changes")).mockResolvedValueOnce(fail(failure));
  render(<WorktreesPanel />);
  fireEvent.mouseDown(await screen.findByText("feature"));

  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove Worktree" })));
  expect(remove.mock.calls).toEqual([
    ["/work/app", "/work/app-feature", false],
    ["/work/app", "/work/app-feature", true],
  ]);
  expect(list).toHaveBeenCalledTimes(2);
  expect(await screen.findByRole("alert")).toHaveTextContent(failure);
  expect(screen.getByRole("treeitem", { name: /feature/ })).toHaveAttribute("aria-selected", "true");
});

afterEach(() => useRemote.setState({ session: null }));

it.each([
  ["toolbar", ssh],
  ["double click", ssh],
  ["toolbar", wsl],
] as const)("opens a remote worktree via %s with the current target", async (entry, target) => {
  useRemote.setState({
    session: { target, root: "/work/app-feature", host: "demo-linux", os: "linux", commands: [] },
  });
  windowOpenRemote.mockReset().mockResolvedValue(ok({ kind: "opened", label: "git-main" }));
  render(<WorktreesPanel />);
  const row = await screen.findByRole("treeitem", { name: /main/ });
  fireEvent.mouseDown(row);
  if (entry === "toolbar") fireEvent.click(screen.getByRole("button", { name: "Open in New Window" }));
  else fireEvent.doubleClick(row);
  await waitFor(() => expect(windowOpenRemote).toHaveBeenCalledExactlyOnceWith(target, "/work/app", true));
  expect(useProject.getState().project?.root).toBe("/work/app-feature");
});

it.each(["toolbar", "double click"])("preserves the local project open via %s", async (entry) => {
  useRemote.setState({ session: null });
  windowOpenRemote.mockReset();
  const run = vi.fn();
  const dispose = registerAction({ id: "file.openProjectPath", title: "Open Project Path", run });
  try {
    render(<WorktreesPanel />);
    const row = await screen.findByRole("treeitem", { name: /main/ });
    fireEvent.mouseDown(row);
    if (entry === "toolbar") fireEvent.click(screen.getByRole("button", { name: "Open in New Window" }));
    else fireEvent.doubleClick(row);
    await waitFor(() => expect(run).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ arg: "/work/app" })));
    expect(windowOpenRemote).not.toHaveBeenCalled();
  } finally {
    dispose();
  }
});
