import { beforeEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const { list } = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return { ...real, commands: { ...real.commands, vcsWorktrees: list } };
});

import { WorktreesPanel } from "../gitMenuDialogs";
import { useVcs } from "../store";

const worktrees = [
  { path: "/work/app", branch: "main", head: "12345678", main: true, locked: false, prunable: false },
  { path: "/work/app-feature", branch: "feature", head: "12345678", main: false, locked: false, prunable: false },
];

beforeEach(() => {
  list.mockReset().mockResolvedValue({ status: "ok", data: worktrees });
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
