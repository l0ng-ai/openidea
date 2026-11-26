import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { FileStatus } from "@/bindings";
import { VcsDialogHost } from "../dialogs";
import { reviewLocalChanges, type AffectedFiles } from "../LocalChangesReviewDialog";
import { useVcs } from "../store";

const mocks = vi.hoisted(() => ({ openDiff: vi.fn(), rollback: vi.fn() }));
vi.mock("../diffDialog", () => ({ openDiffDialog: mocks.openDiff }));
vi.mock("../changeOps", async (original) => ({
  ...(await original<typeof import("../changeOps")>()),
  showRollbackDialog: mocks.rollback,
}));

const change = (repo: string, staged: FileStatus["staged"], unstaged: FileStatus["unstaged"]): FileStatus => ({
  path: `${repo}/same.txt`,
  relPath: "same.txt",
  staged,
  unstaged,
  renamedFrom: null,
});
const a = change("/p/repo-a", null, "modified");
const b = change("/p/repo-b", "modified", "modified");
const affected: AffectedFiles[] = [
  ["/p/repo-a", ["same.txt"]],
  ["/p/repo-b", ["same.txt"]],
];

beforeEach(() => {
  mocks.openDiff.mockReset();
  mocks.rollback.mockReset();
  useVcs.setState({
    available: false,
    root: "/p",
    roots: ["/p/repo-a", "/p/repo-b"],
    status: [a, b],
  });
});

it("opens the selected repository's diff and preserves both sides of a partial stage", async () => {
  render(<VcsDialogHost />);
  const review = reviewLocalChanges("checkout", affected, true);
  const prompt = await screen.findByRole("dialog", { name: "Git Checkout Problem" });
  const tree = within(prompt).getByRole("tree", { name: "Changed files" });
  fireEvent.mouseDown(within(tree).getAllByRole("treeitem", { name: "same.txt" })[1]!, { button: 0 });
  fireEvent.click(within(prompt).getByRole("button", { name: "Show Diff" }));
  await vi.waitFor(() =>
    expect(mocks.openDiff).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        path: b.path,
        right: { type: "rev", rev: ":0", label: "Index" },
      }),
    ),
  );
  fireEvent.click(within(prompt).getByRole("button", { name: "Don't Checkout" }));
  expect(await review).toBeNull();
});

it("waits for rollback and approves only the files still listed", async () => {
  let finish!: () => void;
  mocks.rollback.mockImplementation((_files, done: () => void) => (finish = done));
  render(<VcsDialogHost />);
  const decision = reviewLocalChanges("checkout", affected, true);
  const prompt = await screen.findByRole("dialog", { name: "Git Checkout Problem" });
  fireEvent.click(within(prompt).getByRole("button", { name: "Rollback…" }));
  expect(mocks.rollback).toHaveBeenCalledExactlyOnceWith([a], expect.any(Function));
  expect(within(prompt).getByRole("button", { name: "Force Checkout" })).toBeDisabled();
  await act(async () => {
    useVcs.setState({ status: [b] });
    finish();
  });
  expect(within(prompt).queryByRole("treeitem", { name: "repo-a" })).toBeNull();
  fireEvent.click(within(prompt).getByRole("button", { name: "Force Checkout" }));
  expect(await decision).toEqual({ mode: "force", files: [affected[1]] });
});
