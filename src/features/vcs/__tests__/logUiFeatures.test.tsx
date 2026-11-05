import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Commit } from "@/bindings";
import { ContextMenuHost, hideContextMenu } from "@/ui";

const api = vi.hoisted(() => ({ commits: [] as Commit[], details: vi.fn(), diff: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  const ok = <T,>(data: T) => Promise.resolve({ status: "ok" as const, data });
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsLog: () => ok(api.commits),
      vcsLogRefs: () => ok({}),
      vcsBranches: () => ok([]),
      vcsTags: () => ok([]),
      vcsBranchInfo: () => ok({ upstream: null }),
      vcsConfigGet: () => ok(null),
      vcsCommitFiles: () => ok([{ path: "src/a.ts", kind: "modified", oldPath: null }]),
      vcsLogDetails: () => api.details(),
      vcsLogDetailsBatch: async (_repo: string, ids: string[]) => ({
        status: "ok",
        data: await Promise.all(ids.map(async () => (await api.details()).data)),
      }),
      vcsDiffRevisions: (...args: unknown[]) => api.diff(...args),
    },
  };
});

import { CommitDetails, LogView } from "../GitLog";
import { useVcs } from "../store";
import { commitKey } from "../multiRoot";
import { emptyFilters, openLogTab, reloadLog, selectGitTab, useGitLog } from "../logStore";
import { LogScope } from "../LogScope";
import { DEFAULT_LOG_OPTIONS, useLogOptions } from "../logOptions";
import { VcsDialogHost } from "../dialogs";

const c = (id: string, parents: string[] = [], refs: string[] = []): Commit => ({
  id,
  shortId: id,
  parents,
  refs,
  author: "Author",
  email: "a@example.com",
  summary: id,
  message: id,
  timeMs: 0,
});

beforeEach(() => {
  api.commits = [c("tip", ["middle"], ["HEAD"]), c("middle", ["base"]), c("base")];
  api.details.mockReset().mockResolvedValue({
    status: "ok",
    data: {
      message: "tip\n\nFull body loaded on demand",
      containingBranches: ["main"],
      signature: "G",
      signer: "Author",
      key: "key",
      fingerprint: "fingerprint",
    },
  });
  api.diff.mockReset().mockResolvedValue({
    status: "ok",
    data: [
      { path: "src/a.ts", kind: "modified", oldPath: null, before: "p1", after: "merge" },
      { path: "elsewhere/b.ts", kind: "renamed", oldPath: "src/b.ts", before: "p1", after: "merge" },
      { path: "unrelated/c.ts", kind: "added", oldPath: null, before: null, after: "merge" },
    ],
  });
  useVcs.setState({
    root: "/repo",
    repo: "/repo",
    roots: ["/repo"],
    available: true,
    branchesLoaded: true,
    branches: [],
    branch: { head: "main", headCommit: "tip", upstream: null, ahead: 0, behind: 0, operation: null },
  });
  useGitLog.setState({
    shownLog: "log",
    tab: "log",
    logTabs: [],
    commits: [],
    rows: [],
    filters: emptyFilters(),
    selection: [],
    selected: null,
    done: false,
    branchScope: "/repo",
    generation: useGitLog.getState().generation + 1,
  });
  useLogOptions.setState({ ...DEFAULT_LOG_OPTIONS, showBranches: false, showDetails: false });
});

afterEach(async () => {
  hideContextMenu();
  api.commits = [];
  await reloadLog();
});

describe("log controls", () => {
  it("keeps a pending text edit with its original view when focus changes before the debounce", async () => {
    const other = openLogTab("log", "Other");
    selectGitTab("log");
    render(
      <>
        <LogScope id="log">
          <LogView />
        </LogScope>
        <LogScope id={other}>
          <LogView />
        </LogScope>
      </>,
    );
    const [main, second] = screen.getAllByRole("textbox", { name: "Filter by message" });
    fireEvent.change(main!, { target: { value: "pending" } });
    fireEvent.pointerDown(second!);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(useGitLog.getState().shownLog).toBe(other);
    expect(useGitLog.getState().filters.text).toBe("");
    fireEvent.pointerDown(main!);
    await waitFor(() => expect(useGitLog.getState().filters.text).toBe("pending"));
  });

  it("expands a single collapsed fragment from its node without changing the global option", async () => {
    useLogOptions.setState({ collapseLinear: true });
    render(<LogView />);
    const list = await screen.findByRole("listbox", { name: "Commits" });
    await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(2));
    const tip = within(list).getAllByRole("option")[0]!;
    fireEvent.click(within(tip).getByRole("button", { name: "Collapse or expand this branch" }));
    await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(3));
    expect(useLogOptions.getState().collapseLinear).toBe(true);
  });

  it("keeps the selected middle commit visible under collapse and supports speed search", async () => {
    useLogOptions.setState({ collapseLinear: true });
    useGitLog.setState({ selected: "/repo\0middle", selection: ["/repo\0middle"] });
    render(<LogView />);
    const list = await screen.findByRole("listbox", { name: "Commits" });
    await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(3));
    fireEvent.keyDown(list, { key: "b" });
    expect(useGitLog.getState().selected).toBe("/repo\0base");
    expect(screen.getByRole("status")).toHaveTextContent("b");
  });

  it("hides the column headers unless View Options shows them", async () => {
    render(<LogView />);
    await screen.findByRole("listbox", { name: "Commits" });
    expect(screen.queryByRole("separator", { name: "Resize Author column" })).toBeNull();
  });

  it("resizes and reorders columns using the keyboard", async () => {
    useLogOptions.setState({ showColumnHeaders: true });
    render(<LogView />);
    const author = await screen.findByRole("separator", { name: "Resize Author column" });
    fireEvent.keyDown(author, { key: "ArrowRight" });
    expect(useLogOptions.getState().columnWidths.author).toBe(140);
    fireEvent.keyDown(author, { key: "ArrowRight", altKey: true });
    expect(useLogOptions.getState().columnOrder).toEqual(["date", "author"]);
  });
});

describe("commit details", () => {
  it("loads a full body, containing branches, and signature only when details are visible", async () => {
    useGitLog.setState({ selected: "/repo\0tip", selection: ["/repo\0tip"] });
    render(
      <>
        <LogView />
        <VcsDialogHost />
      </>,
    );
    await screen.findByRole("listbox", { name: "Commits" });
    expect(api.details).not.toHaveBeenCalled();
    await act(async () => {
      useLogOptions.setState({ showDetails: true });
    });
    expect(await screen.findByText("Full body loaded on demand")).toBeInTheDocument();
    expect(screen.getByText(/Signature.*Verified/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand Commit Message" }));
    expect(await screen.findByRole("dialog", { name: "Commit tip" })).toHaveTextContent("Full body loaded on demand");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  });

  it("compares real merge parents and retains renamed files under affected-path filtering", async () => {
    const merge = { ...c("merge", ["p1", "p2"]), repo: "/repo", graphParents: ["filtered-base"] };
    useGitLog.setState({
      commits: [merge],
      selected: commitKey(merge),
      selection: [commitKey(merge)],
      filters: { ...emptyFilters(), paths: ["/repo/src"] },
    });
    useLogOptions.setState({ changesFromParents: true, showOnlyAffected: true });
    render(
      <>
        <CommitDetails commits={[merge]} />
        <ContextMenuHost />
      </>,
    );
    expect(await screen.findByText("4 files")).toBeInTheDocument();
    expect(api.diff).toHaveBeenCalledWith("/repo", "p1", "merge");
    expect(screen.queryByText("c.ts")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All Parents" }));
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Parent 2: p2" }));
    await waitFor(() => expect(api.diff).toHaveBeenLastCalledWith("/repo", "p2", "merge"));
  });
});
