import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RebaseOptions } from "@/bindings";

const mocks = vi.hoisted(() => ({
  rebases: [] as Array<{ repo: string | null; upstream: string; options: RebaseOptions }>,
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
      vcsRebaseWith: (repo: string | null, upstream: string, options: RebaseOptions) => {
        mocks.rebases.push({ repo, upstream, options });
        return ok(null);
      },
    },
  };
});

import { VcsDialogHost } from "../dialogs";
import { showRebaseDialog } from "../gitMenuDialogs";
import { useVcs } from "../store";

beforeEach(() => {
  mocks.rebases = [];
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
  await act(() => showRebaseDialog());
  expect(await screen.findByText("Rebase main onto:")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Repository" })).toBeNull();

  await pick("Upstream", "feature-a");
  fireEvent.click(screen.getByRole("button", { name: "Rebase" }));
  await waitFor(() => expect(mocks.rebases).toHaveLength(1));
  expect(mocks.rebases[0]).toMatchObject({ repo: null, upstream: "feature-a" });
});

it("rebases the repository picked in the dialog, offering that repository's branches", async () => {
  render(<VcsDialogHost />);
  await act(() => showRebaseDialog());
  expect(await screen.findByText("Rebase main onto:")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Repository" })).toHaveTextContent("a");

  await pick("Repository", "b");
  expect(await screen.findByText("Rebase dev onto:")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Upstream" }));
  expect(await screen.findByRole("option", { name: "feature-b" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "feature-a" })).toBeNull();
  // The current branch of the picked repository is not offered.
  expect(screen.queryByRole("option", { name: "dev" })).toBeNull();
  fireEvent.click(screen.getByRole("option", { name: "feature-b" }));

  fireEvent.click(screen.getByRole("button", { name: "Rebase" }));
  await waitFor(() => expect(mocks.rebases).toHaveLength(1));
  expect(mocks.rebases[0]).toMatchObject({ repo: "/p/b", upstream: "feature-b" });
});

it("clears the chosen branches when another repository is picked", async () => {
  render(<VcsDialogHost />);
  await act(() => showRebaseDialog());
  expect(await screen.findByText("Rebase main onto:")).toBeInTheDocument();

  // Branch names both repositories have still have to be chosen again for the new one.
  await pick("Upstream", "shared");
  fireEvent.click(screen.getByRole("checkbox", { name: "--onto" }));
  await pick("New base", "shared");
  expect(screen.getByRole("button", { name: "Rebase" })).toBeEnabled();

  await pick("Repository", "b");
  expect(await screen.findByText("Rebase commits of dev not on:")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Rebase" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Upstream" })).not.toHaveTextContent("shared");
  expect(screen.getByRole("button", { name: "New base" })).not.toHaveTextContent("shared");

  // Picking the repository that is already selected keeps the choice.
  await pick("Upstream", "shared");
  await pick("New base", "shared");
  await pick("Repository", "b");
  expect(screen.getByRole("button", { name: "Rebase" })).toBeEnabled();

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(mocks.rebases).toEqual([]);
});
