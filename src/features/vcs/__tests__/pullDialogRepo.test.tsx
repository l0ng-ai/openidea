import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RemoteOp } from "@/bindings";

const mocks = vi.hoisted(() => ({
  ops: [] as Array<{ repo: string | null; op: RemoteOp }>,
  noMatchingBranch: false,
  upstreamOnPrefixRemote: false,
  detached: [] as string[],
  finishedBatches: [] as Array<{ batch: string; roots: string[] }>,
  gitVersion: "git version 2.49.0.windows.1",
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage: (line: string) => void = () => {};
  },
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  const ok = (data: unknown) => Promise.resolve({ status: "ok" as const, data });
  const head = (repo: string | null) => (mocks.noMatchingBranch ? "local-only" : repo === "/p/b" ? "dev" : "main");
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsBranchInfo: (repo: string | null) =>
        ok({
          head: repo && mocks.detached.includes(repo) ? null : head(repo),
          headCommit: "c1",
          upstream: mocks.noMatchingBranch ? null : `${repo === "/p/b" ? "upstream/team" : "origin"}/${head(repo)}`,
          upstreamTracking: mocks.upstreamOnPrefixRemote ? { remote: "upstream", branch: "team/dev" } : undefined,
          ahead: 0,
          behind: 0,
          operation: null,
        }),
      vcsBranches: (repo: string | null) =>
        ok(
          (repo === "/p/b"
            ? ["upstream/default", "upstream/team/dev", "upstream/team/main"]
            : ["origin/main", ...(mocks.ops.some(({ op }) => op.op === "fetchRemote") ? ["origin/arrived"] : [])]
          ).map((name) => ({
            name,
            remote: true,
            current: false,
          })),
        ),
      vcsRemotes: (repo: string | null) =>
        ok(
          (repo === "/p/c" ? [] : repo === "/p/b" ? ["upstream", "upstream/team"] : ["archive", "origin"]).map(
            (name) => ({ name, url: "/r" }),
          ),
        ),
      vcsRemote: (repo: string | null, _request: number, op: RemoteOp) => {
        mocks.ops.push({ repo, op });
        return ok(null);
      },
      vcsFinishShelfBatch: (batch: string, roots: string[]) => {
        mocks.finishedBatches.push({ batch, roots });
        return ok(null);
      },
      vcsGitVersion: () => ok({ version: mocks.gitVersion, path: "git" }),
      cancelRequest: () => ok(null),
    },
  };
});

import { VcsDialogHost } from "../dialogs";
import { registerVcsActions } from "../actions";
import { executeAction } from "@/platform/actions";
import { getContext, setContext } from "@/platform/context";
import { commonBranchMenu } from "../branchMenu";
import { showPullDialog } from "../gitMenuDialogs";
import { useVcs } from "../store";

beforeEach(() => {
  mocks.ops = [];
  mocks.noMatchingBranch = false;
  mocks.upstreamOnPrefixRemote = false;
  mocks.detached = [];
  mocks.finishedBatches = [];
  mocks.gitVersion = "git version 2.49.0.windows.1";
  localStorage.removeItem("openidea.vcs.pullOptions:/p");
  useVcs.setState({
    root: "/p",
    roots: ["/p/a", "/p/b"],
    repo: "/p/a",
    branch: { head: "main", headCommit: "c1", upstream: "origin/main", ahead: 0, behind: 0, operation: null },
    remoteBusy: null,
    available: false,
  });
});

afterEach(() => {
  for (const button of screen.queryAllByRole("button", { name: "Cancel" })) fireEvent.click(button);
});

it("runs a common branch pull on just the menu's repositories, resolving the remote independently", async () => {
  const roots = ["/p/a", "/p/b"];
  useVcs.setState({ roots: [...roots, "/p/c"], repo: "/p/c" });
  const active = getContext().vcsAvailable;
  setContext("vcsAvailable", true);
  const unregister = registerVcsActions();
  try {
    const branch = { name: "upstream/team/dev", remote: true, current: false, favorite: false, upstream: false };
    const item = commonBranchMenu(branch, roots).find(
      (item) => "label" in item && item.label?.endsWith("Using Rebase"),
    );
    if (!item || !("run" in item)) throw new Error("Missing rebase action");
    item.run?.();
    await waitFor(() => expect(mocks.finishedBatches).toHaveLength(1));
    expect(mocks.ops).toEqual([
      { repo: roots[0], op: { op: "pullFrom", remote: "upstream", branches: ["team/dev"], rebase: true, options: {} } },
      { repo: roots[1], op: { op: "pullFrom", remote: "upstream/team", branches: ["dev"], rebase: true, options: {} } },
    ]);
    expect(mocks.finishedBatches[0]?.roots).toEqual(roots);
    await waitFor(() => expect(useVcs.getState().remoteBusy).toBeNull());
    expect(useVcs.getState().repo).toBe("/p/c");
  } finally {
    unregister();
    setContext("vcsAvailable", active);
  }
});

it("leaves detached repositories at their revision during a common branch pull", async () => {
  const roots = ["/p/a", "/p/b"];
  mocks.detached = [roots[1]!];
  const active = getContext().vcsAvailable;
  setContext("vcsAvailable", true);
  const unregister = registerVcsActions();
  try {
    await executeAction("vcs.pullRemoteBranch", { branch: "origin/review", repositories: roots, rebase: false });
    expect(mocks.ops).toEqual([
      { repo: roots[0], op: { op: "pullFrom", remote: "origin", branches: ["review"], rebase: false, options: {} } },
    ]);
  } finally {
    unregister();
    setContext("vcsAvailable", active);
  }
});

it("offers no repository choice when the project has one repository", async () => {
  useVcs.setState({ roots: ["/p"], repo: null });
  render(<VcsDialogHost />);
  await act(() => showPullDialog());
  await waitFor(() => expect(screen.getByRole("button", { name: "Remote" })).toHaveTextContent("origin"));
  expect(screen.queryByRole("button", { name: "Repository" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Pull" }));
  await waitFor(() => expect(mocks.ops).toHaveLength(1));
  expect(mocks.ops[0]).toMatchObject({ repo: null, op: { op: "pullFrom", remote: "origin", branches: ["main"] } });
});

it("pulls into the repository picked in the dialog, with that repository's remote and branch", async () => {
  render(<VcsDialogHost />);
  await act(() => showPullDialog());
  expect(await screen.findByText("Pull to main")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Repository" }));
  fireEvent.click(await screen.findByRole("option", { name: "b" }));

  expect(await screen.findByText("Pull to dev")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: "Remote" })).toHaveTextContent("upstream/team"));
  await waitFor(() => expect(screen.getByRole("button", { name: "Remote branch" })).toHaveTextContent("dev"));

  fireEvent.click(screen.getByRole("button", { name: "Pull" }));
  await waitFor(() => expect(mocks.ops).toHaveLength(1));
  expect(mocks.ops[0]).toMatchObject({
    repo: "/p/b",
    op: { op: "pullFrom", remote: "upstream/team", branches: ["dev"], rebase: null },
  });
});

it("prefers configured upstream metadata when remote names overlap", async () => {
  mocks.upstreamOnPrefixRemote = true;
  render(<VcsDialogHost />);
  await act(() => showPullDialog("/p/b"));
  await waitFor(() => expect(screen.getByRole("button", { name: "Remote" })).toHaveTextContent(/^upstream$/));
  expect(screen.getByRole("button", { name: "Remote branch" })).toHaveTextContent("team/dev");
  fireEvent.click(screen.getByRole("button", { name: "Pull" }));
  await waitFor(() =>
    expect(mocks.ops[0]?.op).toMatchObject({ op: "pullFrom", remote: "upstream", branches: ["team/dev"] }),
  );
});

it("requires a branch and refreshes only the chosen remote without closing Pull", async () => {
  mocks.noMatchingBranch = true;
  const previous = getContext().vcsAvailable;
  const unregister = registerVcsActions();
  setContext("vcsAvailable", true);
  try {
    render(<VcsDialogHost />);
    await act(() => showPullDialog());
    await waitFor(() => expect(screen.getByRole("button", { name: "Remote" })).toHaveTextContent("origin"));
    expect(screen.getByRole("button", { name: "Pull" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Fetch remote branches" }));
    await waitFor(() =>
      expect(mocks.ops).toEqual([{ repo: "/p/a", op: { op: "fetchRemote", remote: "origin", report: true } }]),
    );
    expect(screen.getByRole("dialog", { name: "Pull to local-only" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remote branch" }));
    fireEvent.click(await screen.findByRole("option", { name: "arrived" }));
    fireEvent.click(screen.getByRole("button", { name: "Pull" }));
    await waitFor(() =>
      expect(mocks.ops[1]).toMatchObject({ repo: "/p/a", op: { op: "pullFrom", branches: ["arrived"] } }),
    );
  } finally {
    setContext("vcsAvailable", previous);
    unregister();
  }
});

it("remembers compatible Pull flags only after confirming the dialog", async () => {
  render(<VcsDialogHost />);
  await act(() => showPullDialog());
  const choose = async (flag: string) => {
    fireEvent.click(screen.getByRole("button", { name: "Modify options" }));
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: flag }));
  };
  await choose("--rebase");
  await choose("--no-verify");
  fireEvent.click(screen.getByRole("button", { name: "Pull" }));
  await waitFor(() =>
    expect(mocks.ops[0]?.op).toMatchObject({ op: "pullFrom", rebase: true, options: { noVerify: true } }),
  );

  await act(() => showPullDialog());
  const selected = () => screen.getByRole("group", { name: "Options:" });
  expect(selected()).toHaveTextContent("--rebase");
  expect(selected()).toHaveTextContent("--no-verify");
  await choose("--no-verify");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await act(() => showPullDialog());
  expect(selected()).toHaveTextContent("--no-verify");
});

it("omits --no-verify when the configured Git cannot run it", async () => {
  mocks.gitVersion = "git version 2.23.0";
  localStorage.setItem("openidea.vcs.pullOptions:/p", JSON.stringify(["noVerify"]));
  render(<VcsDialogHost />);
  await act(() => showPullDialog());
  fireEvent.click(screen.getByRole("button", { name: "Modify options" }));
  expect(await screen.findByRole("menuitemcheckbox", { name: "--rebase" })).toBeInTheDocument();
  expect(screen.queryByRole("menuitemcheckbox", { name: "--no-verify" })).toBeNull();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "Pull" }));
  await waitFor(() => expect(mocks.ops[0]?.op).toMatchObject({ options: { noVerify: false } }));
});

it("keeps the repository choice when the picked repository has no remotes", async () => {
  useVcs.setState({ roots: ["/p/a", "/p/b", "/p/c"] });
  render(<VcsDialogHost />);
  await act(() => showPullDialog());
  await waitFor(() => expect(screen.getByRole("button", { name: "Remote" })).toHaveTextContent("origin"));

  fireEvent.click(screen.getByRole("button", { name: "Repository" }));
  fireEvent.click(await screen.findByRole("option", { name: "c" }));
  expect(await screen.findByText(/No remotes are configured/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Pull" })).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: "Repository" }));
  fireEvent.click(await screen.findByRole("option", { name: "a" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Remote" })).toHaveTextContent("origin"));
  expect(await screen.findByText("Pull to main")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Pull" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(mocks.ops).toEqual([]);
});
