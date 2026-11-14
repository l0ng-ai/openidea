import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Commit } from "@/bindings";

const ipc = vi.hoisted(() => ({ log: vi.fn(), files: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return { ...real, commands: { ...real.commands, vcsLog: ipc.log, vcsCommitFiles: ipc.files } };
});

const execute = vi.hoisted(() => vi.fn());
vi.mock("@/platform/actions", async (original) => ({
  ...(await original<typeof import("@/platform/actions")>()),
  executeAction: execute,
}));

const diff = vi.hoisted(() => ({ show: vi.fn(), changes: vi.fn(() => []) }));
vi.mock("../logChanges", () => ({ showChangesDiff: diff.show, toLogChanges: diff.changes }));

import { showSyncCommits, SyncCommitsPopupHost, useSyncCommits } from "../SyncCommitsPopup";

const commit = (id: string, summary: string, author = "Ada Lovelace"): Commit => ({
  id,
  shortId: id.slice(0, 7),
  parents: [],
  author,
  email: "ada@example.com",
  committer: author,
  committerEmail: "ada@example.com",
  timeMs: 1_700_000_000_000,
  summary,
  message: `${summary}\n\nBody.`,
  messageTruncated: false,
  refs: [],
  commitTimeMs: 1_700_000_000_000,
});

const incoming = commit("a".repeat(40), "Incoming fix");
const outgoing = commit("b".repeat(40), "Outgoing feature", "Grace Hopper");

const open = (overrides: Partial<Parameters<typeof showSyncCommits>[0]> = {}) =>
  act(() =>
    showSyncCommits({
      repo: "/p",
      branch: { branch: "main", upstream: "origin/main", ahead: 1, behind: 2 },
      ...overrides,
    }),
  );

beforeEach(() => {
  ipc.log.mockReset().mockImplementation(async (_repo: string | null, query: { range?: string | null }) => ({
    status: "ok",
    data: query.range === "main..origin/main" ? [incoming] : [outgoing],
  }));
  ipc.files
    .mockReset()
    .mockResolvedValue({ status: "ok", data: [{ path: "src/a.ts", kind: "modified", oldPath: null }] });
  diff.show.mockReset().mockResolvedValue(undefined);
  execute.mockReset();
  useSyncCommits.setState({ source: null });
});

describe("incoming and outgoing commits popup", () => {
  it("lists both sides newest first, with the range git returns for each", async () => {
    render(<SyncCommitsPopupHost />);
    open();
    expect(await screen.findByRole("dialog", { name: "Incoming and outgoing commits" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    const rows = screen.getAllByRole("option");
    expect(rows[0]).toHaveTextContent("aaaaaaa");
    expect(rows[0]).toHaveTextContent("Incoming fix");
    expect(rows[0]).toHaveTextContent("Ada Lovelace");
    expect(rows[1]).toHaveTextContent("bbbbbbb");
    expect(rows[1]).toHaveTextContent("Outgoing feature");
    expect(rows[1]).toHaveTextContent("Grace Hopper");
    expect(ipc.log).toHaveBeenCalledWith("/p", expect.objectContaining({ range: "main..origin/main" }));
    expect(ipc.log).toHaveBeenCalledWith("/p", expect.objectContaining({ range: "origin/main..main" }));
  });

  it("asks only for the side whose marker was clicked", async () => {
    render(<SyncCommitsPopupHost />);
    open({ direction: "outgoing" });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    expect(screen.queryByText("Incoming commits")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Outgoing commits" })).toBeInTheDocument();
    expect(ipc.log).toHaveBeenCalledTimes(1);
    expect(ipc.log).toHaveBeenCalledWith("/p", expect.objectContaining({ range: "origin/main..main" }));
  });

  it("opens a commit's diff from its row and closes the popup", async () => {
    render(<SyncCommitsPopupHost />);
    open();
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    fireEvent.click(screen.getByText("Incoming fix"));
    await waitFor(() => expect(diff.show).toHaveBeenCalledTimes(1));
    expect(ipc.files).toHaveBeenCalledWith("/p", incoming.id);
    expect(useSyncCommits.getState().source).toBeNull();
  });

  it("opens the active commit in the Git log", async () => {
    render(<SyncCommitsPopupHost />);
    open();
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Open in Git Log" }));
    expect(execute).toHaveBeenCalledWith("vcs.showCommit", expect.objectContaining({ id: incoming.id, repo: "/p" }));
    expect(useSyncCommits.getState().source).toBeNull();
  });

  it("opens the active commit with the arrow keys and Enter", async () => {
    render(<SyncCommitsPopupHost />);
    open();
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    const list = screen.getByRole("listbox");
    expect(document.activeElement).toBe(list);
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "Enter" });
    await waitFor(() => expect(diff.show).toHaveBeenCalledTimes(1));
    expect(ipc.files).toHaveBeenCalledWith("/p", outgoing.id);
  });

  it("closes on Escape", async () => {
    render(<SyncCommitsPopupHost />);
    open();
    await screen.findByRole("dialog", { name: "Incoming and outgoing commits" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(useSyncCommits.getState().source).toBeNull();
  });

  it("explains a branch without an upstream instead of listing nothing", async () => {
    render(<SyncCommitsPopupHost />);
    open({ branch: { branch: "feature", upstream: null, ahead: 0, behind: 0 } });
    expect(
      await screen.findByText("This branch has no upstream. Push it to compare with a remote branch."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(ipc.log).not.toHaveBeenCalled();
  });

  it("says the branch is up to date when there is nothing on either side", async () => {
    render(<SyncCommitsPopupHost />);
    open({ branch: { branch: "main", upstream: "origin/main", ahead: 0, behind: 0 } });
    expect(await screen.findByText("Up to date with origin/main")).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
