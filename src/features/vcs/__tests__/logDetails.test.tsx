import { commitKey } from "../multiRoot";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Commit } from "@/bindings";

const vcsCommitFiles = vi.fn();
const vcsCommitsChanges = vi.fn();

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsCommitFiles: (repo: unknown, id: string) => vcsCommitFiles(repo, id),
      vcsCommitsChanges: (repo: unknown, ids: string[]) => vcsCommitsChanges(repo, ids),
    },
  };
});

import { CommitDetails } from "../GitLog";
import { useGitLog } from "../logStore";

const commit = (summary: string, d: string): Commit => ({
  id: d.repeat(40),
  shortId: d.repeat(8),
  parents: [],
  author: "A",
  email: "a@example.com",
  timeMs: 0,
  summary,
  message: `${summary}\n\nBody of ${summary}`,
  refs: [],
});

// Log order: newest first.
const log = [commit("Third", "3"), commit("Second", "2"), commit("First", "1")];

afterEach(() => {
  useGitLog.setState({ commits: [], selection: [], selected: null });
  vcsCommitFiles.mockReset();
  vcsCommitsChanges.mockReset();
});

describe("Git Log commit details", () => {
  it("shows one commit's files and full message", async () => {
    vcsCommitFiles.mockResolvedValue({ status: "ok", data: [{ path: "a.ts", kind: "modified", oldPath: null }] });
    useGitLog.setState({ commits: log, selected: log[1]!.id, selection: [log[1]!.id] });
    render(<CommitDetails commits={log} />);
    expect(await screen.findByText("1 file")).toBeInTheDocument();
    expect(vcsCommitFiles).toHaveBeenCalledWith(null, log[1]!.id);
    expect(screen.getByText("Body of Second")).toBeInTheDocument();
  });

  it("combines the changes of several selected commits, oldest first, and lists them", async () => {
    vcsCommitsChanges.mockResolvedValue({
      status: "ok",
      data: [
        { path: "a.ts", kind: "modified", oldPath: null, before: "0".repeat(40), after: log[0]!.id },
        { path: "b.ts", kind: "added", oldPath: null, before: null, after: log[2]!.id },
      ],
    });
    // Selected in click order (Cmd-click), not log order; non-contiguous.
    useGitLog.setState({ commits: log, selected: log[0]!.id, selection: [log[2]!.id, log[0]!.id] });
    render(<CommitDetails commits={log} />);
    expect(await screen.findByText(/2 files\s*in 2 commits/)).toBeInTheDocument();
    expect(vcsCommitsChanges).toHaveBeenCalledWith(null, [log[2]!.id, log[0]!.id]);
    expect(vcsCommitFiles).not.toHaveBeenCalled();
    expect(screen.getByText("First")).toBeInTheDocument();
    expect(screen.getByText("Third")).toBeInTheDocument();
    expect(screen.queryByText("Second")).toBeNull();
  });
  it("loads the selected root even when two repositories contain the same SHA", async () => {
    const front = { ...commit("Front", "1"), repo: "/front" };
    const back = { ...commit("Back", "1"), repo: "/back" };
    vcsCommitFiles.mockResolvedValue({ status: "ok", data: [{ path: "same.ts", kind: "modified", oldPath: null }] });
    useGitLog.setState({ commits: [front, back], selected: commitKey(back), selection: [commitKey(back)] });
    render(<CommitDetails commits={[front, back]} />);
    expect(await screen.findByText("1 file")).toBeInTheDocument();
    expect(vcsCommitFiles).toHaveBeenCalledWith("/back", back.id);
    expect(screen.getByText("Body of Back")).toBeInTheDocument();
  });
});
