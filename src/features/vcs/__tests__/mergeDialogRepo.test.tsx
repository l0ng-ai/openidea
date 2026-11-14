import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MergeOptions } from "@/bindings";

const mocks = vi.hoisted(() => ({
  merges: [] as Array<{ repo: string | null; branches: string[]; options: MergeOptions }>,
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  const ok = (data: unknown) => Promise.resolve({ status: "ok" as const, data });
  const head = (repo: string | null) => (repo === "/p/b" ? "dev" : "main");
  const local = (repo: string | null) =>
    repo === "/p/b" ? ["dev", "feature-b", "shared"] : ["main", "feature-a", "shared"];
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsBranchInfo: (repo: string | null) =>
        ok({ head: head(repo), headCommit: "c1", upstream: null, ahead: 0, behind: 0, operation: null }),
      vcsBranches: (repo: string | null) =>
        ok(local(repo).map((name) => ({ name, remote: false, current: name === head(repo) }))),
      vcsMergeWith: (repo: string | null, branches: string[], options: MergeOptions) => {
        mocks.merges.push({ repo, branches, options });
        return ok(null);
      },
    },
  };
});

import { VcsDialogHost } from "../dialogs";
import { showMergeDialog } from "../gitMenuDialogs";
import { useVcs } from "../store";

beforeEach(() => {
  mocks.merges = [];
  useVcs.setState({
    root: "/p",
    roots: ["/p/a", "/p/b"],
    repo: "/p/a",
    branch: { head: "main", headCommit: "c1", upstream: null, ahead: 0, behind: 0, operation: null },
    available: false,
  });
});

const pick = async (combo: string, option: string) => {
  fireEvent.click(screen.getByRole("button", { name: combo }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
};

it("offers no repository choice when the project has one repository", async () => {
  useVcs.setState({ roots: ["/p"], repo: null });
  render(<VcsDialogHost />);
  await act(() => showMergeDialog());
  expect(await screen.findByText("Merge into main")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Repository" })).toBeNull();

  await pick("Branch to merge", "feature-a");
  fireEvent.click(screen.getByRole("button", { name: "Merge" }));
  await waitFor(() => expect(mocks.merges).toHaveLength(1));
  expect(mocks.merges[0]).toMatchObject({ repo: null, branches: ["feature-a"] });
});

it("merges into the repository picked in the dialog, offering that repository's branches", async () => {
  render(<VcsDialogHost />);
  await act(() => showMergeDialog());
  expect(await screen.findByText("Merge into main")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Repository" })).toHaveTextContent("a");

  await pick("Repository", "b");
  expect(await screen.findByText("Merge into dev")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Branch to merge" }));
  expect(await screen.findByRole("option", { name: "feature-b" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "feature-a" })).toBeNull();
  // The current branch of the picked repository is not offered.
  expect(screen.queryByRole("option", { name: "dev" })).toBeNull();
  fireEvent.click(screen.getByRole("option", { name: "feature-b" }));

  fireEvent.click(screen.getByRole("button", { name: "Merge" }));
  await waitFor(() => expect(mocks.merges).toHaveLength(1));
  expect(mocks.merges[0]).toMatchObject({ repo: "/p/b", branches: ["feature-b"] });
});

it("clears the chosen branch when another repository is picked", async () => {
  render(<VcsDialogHost />);
  await act(() => showMergeDialog());
  expect(await screen.findByText("Merge into main")).toBeInTheDocument();

  // A branch name both repositories have still has to be chosen again for the new one.
  await pick("Branch to merge", "shared");
  expect(screen.getByRole("button", { name: "Merge" })).toBeEnabled();

  await pick("Repository", "b");
  expect(await screen.findByText("Merge into dev")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Branch to merge" })).not.toHaveTextContent("shared");

  // Picking the repository that is already selected keeps the choice.
  await pick("Branch to merge", "shared");
  await pick("Repository", "b");
  expect(screen.getByRole("button", { name: "Merge" })).toBeEnabled();

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(mocks.merges).toEqual([]);
});
