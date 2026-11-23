import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RebaseOptions } from "@/bindings";

const mocks = vi.hoisted(() => ({
  rebases: [] as Array<{ repo: string | null; upstream: string | null; options: RebaseOptions }>,
  version: "git version 2.51.1.windows.1",
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
      vcsTags: (repo: string | null) => ok(repo === "/p/b" ? ["b-release"] : ["a-release"]),
      vcsHasCommit: (_repo: string | null, value: string) => ok(value !== "missing-revision"),
      vcsGitVersion: () => ok({ version: mocks.version, path: "git" }),
      vcsRebaseWith: (repo: string | null, upstream: string | null, options: RebaseOptions) => {
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
  mocks.version = "git version 2.51.1.windows.1";
  localStorage.removeItem("openidea.vcs.rebaseOptions:/p");
  useVcs.setState({
    root: "/p",
    roots: ["/p/a", "/p/b"],
    repo: "/p/a",
    branch: { head: "main", headCommit: "c1", upstream: null, ahead: 0, behind: 0, operation: null },
    available: false,
  });
});

afterEach(() => {
  for (const button of screen.queryAllByRole("button", { name: "Cancel" })) fireEvent.click(button);
});

const pick = async (combo: string, option: string) => {
  fireEvent.click(screen.getByRole("button", { name: combo }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
};
const openOptions = () => fireEvent.click(screen.getByRole("button", { name: "Modify options" }));
const flag = (name: string) => screen.findByRole("menuitemcheckbox", { name });
const chooseFlag = async (name: string) => {
  openOptions();
  fireEvent.click(await flag(name));
};
const rebase = () => screen.getByRole("button", { name: "Rebase" });

it("offers no repository choice when the project has one repository", async () => {
  useVcs.setState({ roots: ["/p"], repo: null });
  render(<VcsDialogHost />);
  await act(() => showRebaseDialog());
  expect(await screen.findByRole("dialog", { name: "Rebase main" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Repository" })).toBeNull();

  await pick("Upstream", "feature-a");
  await waitFor(() => expect(rebase()).toBeEnabled());
  fireEvent.click(rebase());
  await waitFor(() => expect(mocks.rebases).toHaveLength(1));
  expect(mocks.rebases[0]).toMatchObject({ repo: null, upstream: "refs/heads/feature-a" });
});

it("rebases the repository picked in the dialog, offering that repository's branches", async () => {
  render(<VcsDialogHost />);
  await act(() => showRebaseDialog());
  expect(await screen.findByRole("dialog", { name: "Rebase main" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Repository" })).toHaveTextContent("a");

  await pick("Repository", "b");
  expect(await screen.findByRole("dialog", { name: "Rebase dev" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Upstream" }));
  expect(await screen.findByRole("option", { name: "feature-b" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "feature-a" })).toBeNull();
  // The current branch of the picked repository is not offered.
  expect(screen.queryByRole("option", { name: "dev" })).toBeNull();
  fireEvent.click(screen.getByRole("option", { name: "feature-b" }));

  await waitFor(() => expect(rebase()).toBeEnabled());
  fireEvent.click(rebase());
  await waitFor(() => expect(mocks.rebases).toHaveLength(1));
  expect(mocks.rebases[0]).toMatchObject({ repo: "/p/b", upstream: "refs/heads/feature-b" });
});

it("clears the chosen branches when another repository is picked", async () => {
  render(<VcsDialogHost />);
  await act(() => showRebaseDialog());
  expect(await screen.findByRole("dialog", { name: "Rebase main" })).toBeInTheDocument();

  // Branch names both repositories have still have to be chosen again for the new one.
  await pick("Upstream", "shared");
  await chooseFlag("--onto");
  expect(screen.getByRole("button", { name: "New base" })).toHaveTextContent("shared");
  await pick("Old base", "shared");
  await waitFor(() => expect(rebase()).toBeEnabled());

  await pick("Repository", "b");
  expect(await screen.findByRole("dialog", { name: "Rebase dev" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Rebase" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Old base" })).not.toHaveTextContent("shared");
  expect(screen.getByRole("button", { name: "New base" })).not.toHaveTextContent("shared");

  // Picking the repository that is already selected keeps the choice.
  await pick("Old base", "shared");
  await pick("New base", "shared");
  await pick("Repository", "b");
  await waitFor(() => expect(rebase()).toBeEnabled());

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(mocks.rebases).toEqual([]);
});

it("rebases a selected local branch from its root onto a tag and remembers only the confirmed flags", async () => {
  render(<VcsDialogHost />);
  await act(() => showRebaseDialog());
  await chooseFlag("Switch to branch");
  await pick("Branch to rebase", "feature-a");
  await chooseFlag("--root");
  await chooseFlag("--onto");
  await chooseFlag("--update-refs");
  await chooseFlag("--no-autosquash");
  openOptions();
  expect(await flag("--autosquash")).toHaveAttribute("aria-disabled", "true");
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("button", { name: "Upstream" })).toBeNull();
  await pick("New base", "a-release");
  await waitFor(() => expect(rebase()).toBeEnabled());
  fireEvent.click(rebase());
  await waitFor(() =>
    expect(mocks.rebases[0]).toMatchObject({
      repo: "/p/a",
      upstream: null,
      options: { branch: "feature-a", onto: "refs/tags/a-release", updateRefs: true, autosquash: false },
    }),
  );
  await act(() => showRebaseDialog());
  expect(screen.queryByRole("button", { name: "Branch to rebase" })).toBeNull();
  expect(screen.getByRole("group", { name: "Rebase options" })).toHaveTextContent("--root");
  expect(screen.getByRole("group", { name: "Rebase options" })).toHaveTextContent("--update-refs");
  expect(screen.getByRole("group", { name: "Rebase options" })).toHaveTextContent("--no-autosquash");
});

it("validates typed commit expressions and hides update-refs on older Git", async () => {
  mocks.version = "git version 2.37.4";
  render(<VcsDialogHost />);
  await act(() => showRebaseDialog());
  const type = async (query: string) => {
    fireEvent.click(screen.getByRole("button", { name: "Upstream" }));
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: query } });
    fireEvent.click(await screen.findByRole("option", { name: query }));
  };
  await type("missing-revision");
  expect(await screen.findByText("Commit 'missing-revision' was not found.")).toBeInTheDocument();
  expect(rebase()).toBeDisabled();
  await type("HEAD~1");
  await waitFor(() => expect(rebase()).toBeEnabled());
  openOptions();
  expect(await flag("--root")).toBeInTheDocument();
  expect(screen.queryByRole("menuitemcheckbox", { name: "--update-refs" })).toBeNull();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  fireEvent.click(rebase());
  await waitFor(() => expect(mocks.rebases[0]).toMatchObject({ upstream: "HEAD~1", options: { updateRefs: false } }));
});
