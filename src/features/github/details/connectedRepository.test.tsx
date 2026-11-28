import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

/** `isTauri()`: on only while a test reads the local repositories' remotes. */
const ipc = vi.hoisted(() => ({ tauri: false }));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  const ok = <T,>(data: T) => Promise.resolve({ status: "ok" as const, data });
  return {
    ...real,
    isTauri: () => ipc.tauri,
    commands: {
      ...real.commands,
      vcsRoots: () => ok([{ root: "/p" }, { root: "/p/wt" }]),
      vcsRemotes: () => ok([{ name: "origin", url: "git@github.com:o/r.git" }]),
      ghAvailability: () => ok({ kind: "notInstalled" }),
      // Only the connected repository B has the pull request's branch checked out.
      vcsBranchInfo: (root: string | null) =>
        ok(
          root === "/b"
            ? { head: "review-7", headCommit: "old", upstream: "origin/feature", ahead: 0, behind: 1, operation: null }
            : { head: "main", headCommit: "m", upstream: "origin/main", ahead: 0, behind: 0, operation: null },
        ),
      vcsLog: () => ok([]),
    },
  };
});

const menu = vi.hoisted(() => vi.fn());
vi.mock("@/ui", async (original) => ({ ...(await original<typeof import("@/ui")>()), showContextMenu: menu }));

import { useVcs } from "@/features/vcs/store";
import { provideEditorService, type EditorService } from "@/workbench/contributions";
import type { GHCommitFile, GHPullRequest, GHRepository, GHUser } from "../api/types";
import { clearPullRequests, setPullRequestData } from "../data/pullRequest";
import { refreshConnection, resetConnection, useGhRepository } from "../data/repository";
import { ChangesTree } from "./ChangesTree";
import { DetailsPanel } from "./DetailsPanel";

const file: GHCommitFile = {
  sha: "s",
  filename: "src/a.ts",
  status: "modified",
  additions: 1,
  deletions: 0,
  changes: 1,
  patch: null,
  previousFilename: null,
};

const repository = { id: "R1", nameWithOwner: "o/r", viewerPermission: "READ" } as GHRepository;

beforeEach(() => {
  // Repository A (selected in the VCS widgets) has no GitHub remote; the pull requests are B's.
  useVcs.setState({
    root: "/a",
    roots: ["/a", "/b"],
    repo: "/a",
    branchRoot: "/a",
    branch: { head: "main", headCommit: "m", upstream: "origin/main", ahead: 0, behind: 0, operation: null },
    heads: {
      "/a": { head: "main", headCommit: "m", shallow: false, interactiveRebase: false },
      "/b": { head: "review-7", headCommit: "old", shallow: false, interactiveRebase: false },
    },
    operations: {},
  });
  useGhRepository.setState({
    connection: {
      coordinates: { owner: "o", name: "r" },
      repository,
      currentUser: { login: "me" } as GHUser,
      root: "/b",
      remotes: [{ owner: "o", name: "r", remote: "origin", url: "git@github.com:o/r.git", root: "/b" }],
    },
  });
});

afterEach(() => {
  cleanup();
  clearPullRequests();
  provideEditorService(undefined as unknown as EditorService);
  resetConnection();
  useVcs.setState({ roots: [], root: null, repo: null, branchRoot: null, branch: null, heads: {}, operations: {} });
});

/** Runs Jump to Source on `src/a.ts`; returns the path opened. */
function jumpToSource(): unknown {
  const openFile = vi.fn();
  provideEditorService({ openFile } as unknown as EditorService);
  render(<ChangesTree number={1} files={[file]} commitSha="c" viewedState={undefined} threads={[]} checkedOut />);
  fireEvent.contextMenu(screen.getByText("a.ts"));
  const items = menu.mock.calls.at(-1)![1] as Array<{ label?: string; run?: () => void }>;
  items.find((i) => i.label === "Jump to Source")!.run!();
  return openFile.mock.calls.at(-1)?.[0];
}

describe("the pull request's connected repository", () => {
  it("Jump to Source opens the file in the connected repository, not the one selected in the VCS widgets", () => {
    expect(jumpToSource()).toBe("/b/src/a.ts");
  });

  it("Jump to Source opens the file in the selected checkout when it is another local repository of the connected one", async () => {
    const { connection } = useGhRepository.getState();
    useGhRepository.setState({ connection: null });
    // Reads every local repository's remotes: the clone /p and its worktree /p/wt are both o/r's.
    ipc.tauri = true;
    await refreshConnection();
    ipc.tauri = false;
    useGhRepository.setState({ connection: { ...connection!, root: "/p" } });
    useVcs.setState({ root: "/p", roots: ["/p", "/p/wt"], repo: "/p/wt", branchRoot: "/p/wt" });
    expect(jumpToSource()).toBe("/p/wt/src/a.ts");
  });

  it("the details tell whether the head branch is checked out in the connected repository", async () => {
    setPullRequestData(
      7,
      "details",
      () =>
        ({
          id: "PR1",
          number: 7,
          url: "",
          title: "T",
          state: "OPEN",
          isDraft: false,
          baseRefName: "main",
          baseRefOid: "base",
          headRefName: "feature",
          headRefOid: "head",
          headRepository: repository,
          reviewRequests: { nodes: [] },
          reviews: { nodes: [] },
          assignees: { nodes: [] },
          labels: { nodes: [] },
        }) as unknown as GHPullRequest,
    );
    setPullRequestData(7, "changes", () => []);
    render(<DetailsPanel number={7} />);
    // A checked-out head branch has no "Open in Worktree"; B's upstream loads first.
    await act(() => new Promise((r) => setTimeout(r, 0)));
    fireEvent.click(screen.getByRole("button", { name: "Branches" }));
    expect(screen.getByText("Show in Git Log")).toBeTruthy();
    expect(screen.queryByText("Open in Worktree")).toBeNull();
  });
});
