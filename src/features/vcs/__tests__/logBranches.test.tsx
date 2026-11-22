import type { Branch, BranchInfo } from "@/bindings";
import { isMacHost } from "@/platform/keymap";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const repoData = vi.hoisted(() => ({
  branches: {} as Record<string, unknown[]>,
  tags: {} as Record<string, string[]>,
}));
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsBranches: (root: string) => Promise.resolve({ status: "ok", data: repoData.branches[root] ?? [] }),
      vcsTags: (root: string) => Promise.resolve({ status: "ok", data: repoData.tags[root] ?? [] }),
      vcsLog: () => Promise.resolve({ status: "ok", data: [] }),
      vcsConfigGet: () => Promise.resolve({ status: "ok", data: null }),
    },
  };
});

const execute = vi.hoisted(() => vi.fn());
vi.mock("@/platform/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/actions")>()),
  executeAction: execute,
}));

import { ContextMenuHost } from "@/ui";
import syncStyles from "../BranchSync.module.css";
import { BranchesPanel } from "../log/BranchesPanel";
import { useBranchesPane } from "../logPaneActions";
import { emptyFilters, useGitLog } from "../logStore";
import { useVcs } from "../store";

const b = (name: string, opts: Partial<Branch> = {}): Branch => ({
  name,
  remote: false,
  current: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  lastCommitMs: 0,
  commit: "",
  ...opts,
});

const branches = [b("main", { current: true, commit: "1" }), b("feature", { commit: "2" })];

const head: BranchInfo = {
  head: "main",
  headCommit: "1",
  upstream: null,
  ahead: 0,
  behind: 0,
  operation: null,
};

const writeText = vi.fn().mockResolvedValue(undefined);
/** The copy modifier on this host: ⌘ on macOS, Ctrl elsewhere. */
const cmd = () => (isMacHost() ? { metaKey: true } : { ctrlKey: true });

beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  useVcs.setState({ root: "/p", repo: "/p", branches, branchesLoaded: true, branch: head });
  useGitLog.setState({ filters: emptyFilters() });
});

describe("Git Log branches pane", () => {
  it("offers Manage Remotes… on the Remote node and on each remote, like IDEA", async () => {
    useVcs.setState({ branches: [...branches, b("origin/main", { remote: true, commit: "1" })] });
    render(
      <>
        <BranchesPanel />
        <ContextMenuHost />
      </>,
    );
    fireEvent.contextMenu(screen.getByText("Remote"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Manage Remotes…" }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("vcs.manageRemotes"));
    execute.mockClear();
    // Expand Remote, then the remote itself.
    fireEvent.mouseDown(screen.getByText("Remote"));
    fireEvent.keyDown(screen.getByRole("tree", { name: "Branches" }), { key: "ArrowRight" });
    fireEvent.contextMenu(await screen.findByText("origin"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Manage Remotes…" }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("vcs.manageRemotes"));
  });

  it("one click only selects the branch", () => {
    render(<BranchesPanel />);
    fireEvent.mouseDown(screen.getByText("feature"));
    expect(useGitLog.getState().filters.branches).toEqual([]);
    expect(screen.getByText("feature").closest("[data-row]")).toHaveAttribute("aria-selected", "true");
  });

  it("passes the selected branch to New Worktree", async () => {
    render(
      <>
        <BranchesPanel />
        <ContextMenuHost />
      </>,
    );
    fireEvent.contextMenu(screen.getByText("feature"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "New Worktree from 'feature'…" }));
    expect(execute).toHaveBeenCalledWith("vcs.newWorktree", { repo: "/p", branch: branches[1] });
  });

  it.each([
    [2, 0],
    [0, 3],
    [2, 3],
    [0, 0],
  ])("renders shared branch markers for ahead %i / behind %i", (ahead, behind) => {
    useVcs.setState({ branches: [b("main", { current: true, ahead, behind })] });
    render(<BranchesPanel />);
    const incoming = screen.queryByLabelText("3 incoming commits");
    const outgoing = screen.queryByLabelText("2 outgoing commits");
    if (behind) expect(incoming).toHaveClass(syncStyles.incoming!);
    else expect(incoming).toBeNull();
    if (ahead) expect(outgoing).toHaveClass(syncStyles.outgoing!);
    else expect(outgoing).toBeNull();
  });

  it("double click switches the log to that branch", () => {
    render(<BranchesPanel />);
    fireEvent.doubleClick(screen.getByText("feature"));
    expect(useGitLog.getState().filters.branches).toEqual(["feature"]);
  });

  it("double click on the current branch switches to its log too", () => {
    render(<BranchesPanel />);
    fireEvent.doubleClick(screen.getByText("main"));
    expect(useGitLog.getState().filters.branches).toEqual(["main"]);
  });

  it("double click on HEAD shows HEAD's log", () => {
    render(<BranchesPanel />);
    fireEvent.doubleClick(screen.getByText("HEAD (Current Branch)"));
    expect(useGitLog.getState().filters.branches).toEqual(["HEAD"]);
  });

  it("Enter switches the log to every selected branch, in tree order", () => {
    useVcs.setState({ branches: [b("main", { current: true }), b("beta"), b("alpha")] });
    render(<BranchesPanel />);
    fireEvent.mouseDown(screen.getByText("beta"));
    fireEvent.mouseDown(screen.getByText("alpha"), cmd());
    expect(useGitLog.getState().filters.branches).toEqual([]);
    fireEvent.keyDown(screen.getByRole("tree", { name: "Branches" }), { key: "Enter" });
    expect(useGitLog.getState().filters.branches).toEqual(["alpha", "beta"]);
  });

  it("follows the log filter when it changes elsewhere", () => {
    render(<BranchesPanel />);
    fireEvent.mouseDown(screen.getByText("main"));
    act(() => useGitLog.setState({ filters: { ...emptyFilters(), branches: ["feature"] } }));
    expect(screen.getByText("feature").closest("[data-row]")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("main").closest("[data-row]")).toHaveAttribute("aria-selected", "false");
  });

  it("copies the selected branch name", async () => {
    render(<BranchesPanel />);
    fireEvent.mouseDown(screen.getByText("feature"));
    fireEvent.keyDown(screen.getByText("feature"), { key: "c", ...cmd() });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("feature"));
  });

  it("copies HEAD as HEAD", async () => {
    render(<BranchesPanel />);
    fireEvent.mouseDown(screen.getByText("HEAD (Current Branch)"));
    fireEvent.keyDown(screen.getByText("HEAD (Current Branch)"), { key: "c", ...cmd() });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("HEAD"));
  });

  it("copies the folder path along with the branch name", async () => {
    useVcs.setState({
      branches: [b("feat/idea-parity", { current: true, commit: "1" })],
      branch: { ...head, head: "feat/idea-parity" },
    });
    render(<BranchesPanel />);
    fireEvent.mouseDown(screen.getByText("idea-parity"));
    fireEvent.keyDown(screen.getByText("idea-parity"), { key: "c", ...cmd() });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("feat/idea-parity"));
  });

  it("copies every selected branch, one per line, in tree order", async () => {
    useVcs.setState({ branches: [b("main", { current: true }), b("beta"), b("alpha")] });
    render(<BranchesPanel />);
    fireEvent.mouseDown(screen.getByText("beta"), cmd());
    fireEvent.mouseDown(screen.getByText("alpha"), cmd());
    fireEvent.keyDown(screen.getByText("alpha"), { key: "c", ...cmd() });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("alpha\nbeta"));
  });

  it("leaves Cmd/Ctrl+C in the branch search field alone", async () => {
    render(<BranchesPanel />);
    fireEvent.mouseDown(screen.getByText("feature"));
    fireEvent.keyDown(screen.getByLabelText("Filter branches and tags"), { key: "c", ...cmd() });
    await Promise.resolve();
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("Git Log branches pane with several repositories", () => {
  const aBranches = [b("main", { current: true }), b("dev"), b("solo")];
  const bBranches = [b("main"), b("dev", { current: true }), b("other")];
  beforeEach(() => {
    localStorage.removeItem("openidea.vcs.branchesPane.groupByRepository");
    repoData.branches = { "/p/a": aBranches, "/p/b": bBranches };
    repoData.tags = {};
    useVcs.setState({
      root: "/p",
      repo: "/p/a",
      roots: ["/p/a", "/p/b"],
      heads: { "/p/a": { head: "main", headCommit: "1" }, "/p/b": { head: "dev", headCommit: "2" } },
      branches: aBranches,
    });
  });
  afterEach(() => useVcs.setState({ roots: [], branchRoots: {}, heads: {} }));

  it("lists branches once, naming the repositories of partial ones", async () => {
    render(<BranchesPanel />);
    const solo = await screen.findByText("solo");
    expect(solo.closest("[data-row]")).toHaveTextContent("(a)");
    expect(screen.getAllByText("dev")).toHaveLength(1);
    expect(screen.getByText("dev").closest("[data-row]")).not.toHaveTextContent("(");
  });

  it("shows only branches of the repository selected by Paths", async () => {
    render(<BranchesPanel />);
    expect(await screen.findByText("solo")).toBeInTheDocument();
    expect(screen.getByText("other")).toBeInTheDocument();

    act(() => useGitLog.setState({ filters: { ...emptyFilters(), paths: ["/p/b"] } }));
    expect(screen.queryByText("solo")).toBeNull();
    expect(screen.getByText("other")).toBeInTheDocument();
    expect(screen.getByText("dev").closest("[data-row]")).toHaveTextContent("current");

    act(() => useGitLog.setState({ filters: { ...emptyFilters(), repositories: ["/p/a"] } }));
    expect(screen.getByText("solo")).toBeInTheDocument();
    expect(screen.queryByText("other")).toBeNull();

    act(() => useGitLog.setState({ filters: emptyFilters() }));
    expect(screen.getByText("solo")).toBeInTheDocument();
    expect(screen.getByText("other")).toBeInTheDocument();
  });

  it("groups linked worktrees together and honors an explicit worktree path filter", async () => {
    const linked = "/p/linked";
    const worktreeBranches = aBranches.map((branch) => ({ ...branch, current: branch.name === "dev" }));
    repoData.branches[linked] = worktreeBranches;
    useVcs.setState({ roots: [linked, "/p/a", "/p/b"], branchRoots: { [linked]: "/p/a" } });
    render(
      <>
        <BranchesPanel />
        <ContextMenuHost />
      </>,
    );
    expect((await screen.findByText("solo")).closest("[data-row]")).toHaveTextContent("(a)");
    expect(screen.queryByText("(a, linked)")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Group by Repository" }));
    expect(await screen.findAllByText("dev")).toHaveLength(2);
    expect(screen.queryByText("linked")).toBeNull();

    act(() => useGitLog.setState({ filters: { ...emptyFilters(), paths: [linked] } }));
    expect(await screen.findByText("solo")).toBeInTheDocument();
    expect(screen.queryByText("other")).toBeNull();
    expect(screen.getByText("dev").closest("[data-row]")).toHaveTextContent(/dev\s*current/);
    fireEvent.doubleClick(screen.getByText("dev"));
    expect(useGitLog.getState().filters).toMatchObject({ branches: ["dev"], paths: [linked], repositories: [linked] });
  });

  it("keeps the current marker ahead of the repository names, which may be cut off", async () => {
    repoData.branches = { "/p/a": [b("main", { current: true }), b("dev")], "/p/b": [b("dev", { current: true })] };
    render(<BranchesPanel />);
    const row = (await screen.findByText("main")).closest("[data-row]")!;
    expect(row.textContent).toMatch(/main.*current.*\(a\)/);
  });

  it("Group by Repository switches to per-repository subtrees and is remembered", async () => {
    render(<BranchesPanel />);
    await screen.findByText("solo");
    fireEvent.click(screen.getByRole("button", { name: "Group by Repository" }));
    expect(await screen.findAllByText("a")).not.toHaveLength(0);
    expect(screen.getAllByText("dev")).toHaveLength(2);
    expect(localStorage.getItem("openidea.vcs.branchesPane.groupByRepository")).toBe("true");
  });

  it("double click filters the log to the repositories that have the branch within the visible scope", async () => {
    render(<BranchesPanel />);
    fireEvent.doubleClick(await screen.findByText("solo"));
    expect(useGitLog.getState().filters).toMatchObject({ branches: ["solo"], repositories: ["/p/a"] });
    fireEvent.doubleClick(screen.getByText("dev"));
    expect(useGitLog.getState().filters).toMatchObject({ branches: ["dev"], repositories: ["/p/a"] });
  });

  it("a branch in several repositories gets the common menu", async () => {
    render(
      <>
        <BranchesPanel />
        <ContextMenuHost />
      </>,
    );
    fireEvent.contextMenu(await screen.findByText("dev"));
    expect(await screen.findByRole("menuitem", { name: "Merge 'dev' into Current" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Rename…" })).toBeInTheDocument();
  });

  it("a merged branch's menu keeps favorites and history", async () => {
    render(
      <>
        <BranchesPanel />
        <ContextMenuHost />
      </>,
    );
    fireEvent.contextMenu(await screen.findByText("dev"));
    expect(await screen.findByRole("menuitem", { name: "Add to Favorites" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Show History" })).toBeInTheDocument();
  });

  it("a remote branch in several repositories can be deleted in each", async () => {
    const origin = b("origin/main", { remote: true });
    repoData.branches = { "/p/a": [...aBranches, origin], "/p/b": [...bBranches, origin] };
    render(
      <>
        <BranchesPanel />
        <ContextMenuHost />
      </>,
    );
    fireEvent.mouseDown(await screen.findByText("origin"));
    fireEvent.keyDown(screen.getByRole("tree", { name: "Branches" }), { key: "ArrowRight" });
    const mains = await screen.findAllByText("main");
    expect(mains).toHaveLength(2);
    fireEvent.contextMenu(mains[1]!);
    expect(await screen.findByRole("menuitem", { name: "Merge 'origin/main' into Current" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
  });

  it("a multi-selection keeps the menu acting on every selected branch", async () => {
    render(
      <>
        <BranchesPanel />
        <ContextMenuHost />
      </>,
    );
    fireEvent.mouseDown(await screen.findByText("dev"));
    fireEvent.mouseDown(screen.getByText("solo"), cmd());
    fireEvent.contextMenu(screen.getByText("dev"));
    expect(await screen.findByRole("menuitem", { name: "Update Selected" })).toBeInTheDocument();
    // The right-clicked branch's own actions still act in every repository that has it.
    expect(screen.getByRole("menuitem", { name: "Merge 'dev' into Current" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Merge 'dev' into 'main'" })).toBeNull();
  });

  it("selecting a merged branch targets each repository's own branch", async () => {
    render(<BranchesPanel />);
    fireEvent.mouseDown(await screen.findByText("dev"));
    await waitFor(() =>
      expect(useBranchesPane.getState().selected).toEqual([
        { ref: "dev", repo: "/p/a", branch: aBranches[1] },
        { ref: "dev", repo: "/p/b", branch: bBranches[1] },
      ]),
    );
  });
});
