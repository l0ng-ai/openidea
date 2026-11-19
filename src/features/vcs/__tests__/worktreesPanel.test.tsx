import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { list, move, remove, open, confirm } = vi.hoisted(() => ({
  list: vi.fn(),
  move: vi.fn(),
  remove: vi.fn(),
  open: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: { ...real.commands, vcsWorktrees: list, vcsMoveWorktree: move, vcsRemoveWorktree: remove },
  };
});
vi.mock("@/platform/dialog", () => ({ open }));
vi.mock("../dialogs", async (original) => ({
  ...(await original<typeof import("../dialogs")>()),
  confirmDialog: confirm,
}));

import { WorktreesPanel } from "../gitMenuDialogs";
import { useVcs } from "../store";
import { useProject } from "@/platform/project";

const worktrees = [
  { path: "/work/app", branch: "main", head: "12345678", main: true, locked: false, prunable: false },
  { path: "/work/app-feature", branch: "feature", head: "12345678", main: false, locked: false, prunable: false },
];
const ok = <T,>(data: T) => ({ status: "ok" as const, data });
const fail = (message: string) => ({ status: "error", error: { kind: "invalidInput", message, detail: null } });

beforeEach(() => {
  useProject.setState({ project: { root: "/work/app-feature" } as never });
  list.mockReset().mockResolvedValue(ok(worktrees));
  move.mockReset();
  remove.mockReset();
  open.mockReset();
  confirm.mockReset().mockResolvedValue(true);
  useVcs.setState({ root: "/work/app-feature", roots: ["/work/app-feature"], repo: null });
});

it("marks the linked project root current when its main worktree is also listed", async () => {
  render(<WorktreesPanel />);
  expect(await screen.findByText("current /work/app-feature")).toBeInTheDocument();
  expect(screen.getByText("main /work/app")).toBeInTheDocument();
});

it("marks both opened roots current while grouping their repository once", async () => {
  useVcs.setState({ roots: ["/work/app-feature", "/work/app"] });
  render(<WorktreesPanel />);
  expect(await screen.findByText("current /work/app-feature")).toBeInTheDocument();
  expect(screen.getByText("current /work/app")).toBeInTheDocument();
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
