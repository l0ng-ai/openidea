import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { FileStatus, ProjectInfo } from "@/bindings";
import { useProject } from "@/platform/project";
import { showConflictsDialog } from "../conflictsUi";
import { VcsDialogHost } from "../dialogs";
import { trackMergeCompletion } from "../mergeCompletion";
import { useVcs } from "../store";

const { mergeBase, log, operation, cancelled } = vi.hoisted(() => ({
  mergeBase: vi.fn(),
  log: vi.fn(),
  operation: vi.fn(),
  cancelled: vi.fn(),
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const ipc = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...ipc,
    commands: {
      ...ipc.commands,
      vcsMergeBase: async (...args: unknown[]) => ({ status: "ok", data: mergeBase(...args) }),
      vcsLog: async (...args: unknown[]) => ({ status: "ok", data: log(...args) }),
      vcsOperation: async (...args: unknown[]) => ({ status: "ok", data: operation(...args) }),
    },
  };
});

vi.mock("../ops", async (importOriginal) => {
  const ops = await importOriginal<typeof import("../ops")>();
  return {
    ...ops,
    runGitOperationWith: async (
      _description: string,
      _options: unknown,
      invoke: Parameters<typeof ops.runGitOperationWith>[2],
    ) => invoke({ request: 1, output: vi.fn<Parameters<typeof invoke>[0]["output"]>(), cancelled }),
  };
});

const project = { root: "/project" } as ProjectInfo;
const roots = ["/a", "/b"];

function publish(a: string, b: string, operations: Record<string, string>) {
  useVcs.setState({
    operations,
    heads: { "/a": { head: "main", headCommit: a }, "/b": { head: "main", headCommit: b } },
  });
}

function conflict(path: string): FileStatus {
  return { path, relPath: path.slice(1), staged: null, unstaged: "conflicted", renamedFrom: null };
}

describe("the completion of a conflicted branch merge", () => {
  beforeEach(() => {
    useProject.setState({ project });
    useVcs.setState({
      root: "/project",
      repo: "/c",
      roots: ["/a", "/b", "/c"],
      status: [],
      resolvedConflicts: new Set(),
    });
    publish("a-before", "b-before", { "/a": "merge", "/b": "merge" });
    mergeBase.mockReset().mockImplementation((repo: string) => `${repo}-source`);
    log
      .mockReset()
      .mockImplementation((repo: string, { branch }: { branch: string }) => [
        { id: branch, parents: [`${repo.slice(1)}-before`, `${repo}-source`] },
      ]);
    cancelled.mockReset().mockReturnValue(false);
    operation.mockReset().mockImplementation((root: string) => {
      const { heads, operations } = useVcs.getState();
      const remaining = { ...operations };
      delete remaining[root];
      publish(
        root === "/a" ? "a-merge" : heads["/a"]!.headCommit!,
        root === "/b" ? "b-merge" : heads["/b"]!.headCommit!,
        remaining,
      );
      return null;
    });
  });

  afterEach(() => {
    useProject.setState({ project: null });
    const close = screen.queryByText("Close", { selector: "button" });
    if (close) fireEvent.click(close);
    useVcs.setState({ operations: {}, heads: {}, status: [] });
  });

  it("waits for all repositories and recognizes the actual merge commits", async () => {
    const success = vi.fn();
    await trackMergeCompletion(roots, project, success);
    expect(mergeBase.mock.calls).toEqual([
      ["/a", "MERGE_HEAD", "MERGE_HEAD"],
      ["/b", "MERGE_HEAD", "MERGE_HEAD"],
    ]);
    publish("a-merge", "b-before", { "/a": "merge", "/b": "merge" });
    expect(success).not.toHaveBeenCalled();
    publish("a-merge", "b-before", { "/b": "merge" });
    expect(success).not.toHaveBeenCalled();
    publish("a-newer", "b-merge", {});
    await vi.waitFor(() => expect(success).toHaveBeenCalledTimes(1));
    expect(log.mock.calls.map(([root, query]) => [root, query.branch])).toEqual([
      ["/a", "a-merge"],
      ["/b", "b-merge"],
    ]);
  });

  it.each(["abort", "unrelated commit", "project switch"])("drops the notification after %s", async (reason) => {
    const success = vi.fn();
    await trackMergeCompletion(roots, project, success);
    if (reason === "project switch") useProject.setState({ project: { root: "/other" } as ProjectInfo });
    if (reason === "unrelated commit") log.mockReturnValueOnce([{ id: "a-unrelated", parents: ["a-before"] }]);
    publish(reason === "abort" ? "a-before" : "a-unrelated", "b-merge", {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(success).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(reason === "unrelated commit" ? 2 : 0);
  });

  it("finishes only this merge after all of its files are resolved", async () => {
    const success = vi.fn();
    await trackMergeCompletion(roots, project, success);
    useVcs.setState({ status: [conflict("/b/remaining.txt"), conflict("/c/unrelated.txt")] });
    render(createElement(VcsDialogHost));
    act(() => showConflictsDialog({ mergeRepo: "/a" }));
    const dialog = within(screen.getByRole("dialog", { name: "Conflicts" }));
    expect(dialog.getByText("remaining.txt")).toBeInTheDocument();
    expect(dialog.queryByText("unrelated.txt")).toBeNull();
    const finish = dialog.getByRole("button", { name: "Accept and Finish" });
    expect(finish).toBeDisabled();
    act(() => useVcs.setState({ status: [conflict("/c/unrelated.txt")] }));
    expect(finish).toBeEnabled();
    await act(async () => fireEvent.click(finish));
    await vi.waitFor(() => expect(success).toHaveBeenCalledExactlyOnceWith());
    expect(operation.mock.calls.map(([root, , op]) => [root, op])).toEqual([
      ["/a", { op: "finishMerge", branch: "main", head: "a-before", target: "/a-source" }],
      ["/b", { op: "finishMerge", branch: "main", head: "b-before", target: "/b-source" }],
    ]);
  });

  it("can finish the remaining repository after cancelling partway", async () => {
    const success = vi.fn();
    const session = await trackMergeCompletion(roots, project, success);
    cancelled.mockReturnValueOnce(false).mockReturnValueOnce(true);
    await session?.finish();
    expect(operation.mock.calls.map(([root]) => root)).toEqual(["/a"]);
    expect(success).not.toHaveBeenCalled();

    await session?.finish();
    await vi.waitFor(() => expect(success).toHaveBeenCalledExactlyOnceWith());
    expect(operation.mock.calls.map(([root]) => root)).toEqual(["/a", "/b"]);
  });
});
