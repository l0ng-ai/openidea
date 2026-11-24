import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Commit } from "@/bindings";
import { getAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { installKeyboardDispatcher, useKeymap } from "@/platform/keymap";
import { useGitLog } from "../logStore";
import { toLogChanges, useLogChanges } from "../logChanges";
import { registerLogPaneActions } from "../logPaneActions";
import { useVcs } from "../store";
import { registerVcsActions } from "../actions";

const mocks = vi.hoisted(() => ({
  openVcsDiff: vi.fn(),
  openRevisionFile: vi.fn(),
  showWorktreeComparison: vi.fn(),
  openDialog: vi.fn(),
  notify: vi.fn(),
  toggleCommitBookmark: vi.fn(),
}));

vi.mock("../logStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logStore")>()),
  toggleCommitBookmark: mocks.toggleCommitBookmark,
}));

vi.mock("../diffInput", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../diffInput")>()),
  openVcsDiff: mocks.openVcsDiff,
}));
vi.mock("../revisionInput", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../revisionInput")>()),
  openRevisionFile: mocks.openRevisionFile,
}));
vi.mock("../compareTool", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../compareTool")>()),
  showWorktreeComparison: mocks.showWorktreeComparison,
}));
vi.mock("../dialogs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dialogs")>()),
  openDialog: mocks.openDialog,
}));
vi.mock("@/workbench/contributions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/workbench/contributions")>()),
  notifications: () => ({ notify: mocks.notify }),
}));

import { showCompareVersions, showCompareWithLocal, showFileAtRevision } from "../operations";
import { registerHistoryActions, type FileHistoryCommitArg, type FileHistoryCommitsArg } from "../historyActions";

const commit: Commit & { historyPath: string } = {
  id: "1234567890abcdef1234567890abcdef12345678",
  shortId: "12345678",
  parents: ["p".repeat(40)],
  author: "A",
  email: "a@example.com",
  timeMs: 0,
  summary: "Rename file",
  message: "Rename file",
  refs: [],
  historyPath: "old/name.ts",
};

const originalLog = useGitLog.getState();
const originalVcs = useVcs.getState();
let unregister: (() => void) | undefined;
let unregisterPane: (() => void) | undefined;

beforeEach(() => {
  mocks.openVcsDiff.mockReset();
  mocks.openRevisionFile.mockReset();
  mocks.showWorktreeComparison.mockReset();
  mocks.openDialog.mockReset();
  mocks.notify.mockReset();
  mocks.toggleCommitBookmark.mockReset();
  useGitLog.setState({ commits: [], selected: null, selection: [], shownLog: "log", logTabs: [] });
  useVcs.setState({ root: "/repo", repo: "/repo", roots: ["/repo"], branchesLoaded: true });
  setContext("vcsAvailable", true);
  unregister = registerHistoryActions();
  unregisterPane = registerLogPaneActions();
});

afterEach(() => {
  unregister?.();
  unregister = undefined;
  unregisterPane?.();
  unregisterPane = undefined;
  useLogChanges.setState({ commits: [], all: [], selected: [] });
  useGitLog.setState(originalLog);
  useVcs.setState(originalVcs);
  setContext("vcsAvailable", false);
});

describe("File History actions", () => {
  it("uses Ctrl/Cmd+D on a focused history row to diff the revision against its parent", async () => {
    const renamed = { ...commit, historyPath: "old/name.ts" };
    const unrelated = toLogChanges([{ path: "unrelated.ts", oldPath: null, kind: "modified" }], renamed, "/repo");
    const historyFile = toLogChanges(
      [{ path: "new/name.ts", oldPath: "old/name.ts", kind: "renamed" }],
      renamed,
      "/repo",
    );
    const changes = [...unrelated, ...historyFile];
    useGitLog.setState({
      commits: [renamed],
      selected: renamed.id,
      selection: [renamed.id],
      shownLog: "history",
      logTabs: [{ id: "history", kind: "history", target: "/repo/new/name.ts" } as never],
    });
    useLogChanges.setState({ commits: [renamed], all: changes, selected: changes });

    const originalOverrides = useKeymap.getState().overrides;
    const unregisterVcs = registerVcsActions();
    const uninstallDispatcher = installKeyboardDispatcher(window);
    useKeymap.setState({
      overrides: {
        ...originalOverrides,
        "vcs.showDiff": ["Ctrl+D"],
        "vcs.log.changes.showDiff": ["Ctrl+D"],
      },
    });
    setContext("vcsLogRevisionFocus", true);
    try {
      expect(getAction("vcs.log.changes.showDiff")!.keyWhen).toBe("vcsLogChangesFocus || vcsLogRevisionFocus");
      expect(getAction("vcs.showDiff")!.keyWhen).toBe(
        "!editorTextFocus && !diffEditorFocus && !vcsLogChangesFocus && !vcsLogRevisionFocus",
      );
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyD", key: "d", ctrlKey: true, bubbles: true }));
      await vi.waitFor(() => expect(mocks.openVcsDiff).toHaveBeenCalledOnce());
    } finally {
      setContext("vcsLogRevisionFocus", false);
      useKeymap.setState({ overrides: originalOverrides });
      uninstallDispatcher();
      unregisterVcs();
    }

    expect(mocks.openVcsDiff).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/repo/new/name.ts",
        left: { type: "rev", rev: commit.parents[0], path: "/repo/old/name.ts", label: commit.parents[0]!.slice(0, 8) },
        right: { type: "rev", rev: commit.id, label: commit.shortId },
      }),
      { preview: true },
    );
    expect(mocks.openVcsDiff.mock.calls[0]![0].chain).toBeUndefined();
  });

  it("uses Compare Versions for two focused File History revisions", async () => {
    const newer = { ...commit, historyPath: "new/name.ts" };
    const older = {
      ...commit,
      id: "a".repeat(40),
      shortId: "aaaaaaaa",
      parents: ["b".repeat(40)],
      historyPath: "old/name.ts",
    };
    useGitLog.setState({
      commits: [newer, older],
      selected: newer.id,
      selection: [newer.id, older.id],
      shownLog: "history",
      logTabs: [{ id: "history", kind: "history", target: "/repo/new/name.ts" } as never],
    });
    useLogChanges.setState({ commits: [newer, older], all: [], selected: [] });

    await getAction("vcs.log.changes.showDiff")!.run({ ctx: { vcsLogRevisionFocus: true } });

    expect(mocks.openVcsDiff).toHaveBeenCalledWith({
      path: "/repo/new/name.ts",
      left: { type: "rev", rev: older.id, path: "/repo/old/name.ts", label: older.shortId },
      right: { type: "rev", rev: newer.id, path: "/repo/new/name.ts", label: newer.shortId },
    });
  });

  it("does not open a stale changed-files result while the selected revision is still loading", async () => {
    const selected = { ...commit, id: "c".repeat(40) };
    useGitLog.setState({
      commits: [selected],
      selected: selected.id,
      selection: [selected.id],
      shownLog: "history",
      logTabs: [{ id: "history", kind: "history", target: "/repo/new/name.ts" } as never],
    });
    useLogChanges.setState({
      commits: [commit],
      all: toLogChanges([{ path: "stale.ts", oldPath: null, kind: "modified" }], commit, "/repo"),
      selected: [],
    });

    await getAction("vcs.log.changes.showDiff")!.run({ ctx: { vcsLogRevisionFocus: true } });

    expect(mocks.openVcsDiff).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledWith({
      group: "vcs",
      level: "info",
      title: "Revision changes are still loading",
    });
  });

  it("keeps changed-file Show Diff on the same action when the revision list is not focused", async () => {
    const changes = toLogChanges([{ path: "new/name.ts", oldPath: "old/name.ts", kind: "renamed" }], commit, "/repo");
    await getAction("vcs.log.changes.showDiff")!.run({ arg: changes, ctx: { vcsLogChangesFocus: true } });

    expect(mocks.openVcsDiff).toHaveBeenCalledWith(expect.objectContaining({ path: "/repo/new/name.ts" }), {
      preview: true,
    });
  });

  it("opens the selected snapshot, preserving the historical path after a rename", () => {
    showFileAtRevision(commit, "/repo/new/name.ts");

    expect(mocks.openRevisionFile).toHaveBeenCalledWith("/repo", commit.id, "old/name.ts", false);
  });

  it("derives a missing historical path from the scoped target using normalized Windows paths", () => {
    const { historyPath: _historyPath, ...withoutHistoryPath } = commit;
    useVcs.setState({ root: "C:/repo", repo: "C:/repo", roots: ["C:/repo"] });
    showFileAtRevision(withoutHistoryPath, "C:/repo/new/name.ts");

    expect(mocks.openRevisionFile).toHaveBeenCalledWith("C:/repo", commit.id, "new/name.ts", false);
  });

  it("compares the selected historical file directly with its current working file", () => {
    showCompareWithLocal(commit, "/repo/new/name.ts");

    expect(mocks.openVcsDiff).toHaveBeenCalledWith({
      path: "/repo/new/name.ts",
      left: { type: "rev", rev: commit.id, path: "/repo/old/name.ts", label: commit.shortId },
      right: { type: "worktree" },
    });
    expect(mocks.showWorktreeComparison).not.toHaveBeenCalled();
  });

  it("keeps ordinary Git Log Compare with Local repository-scoped", () => {
    showCompareWithLocal(commit);

    expect(mocks.openVcsDiff).not.toHaveBeenCalled();
    expect(mocks.showWorktreeComparison).toHaveBeenCalledWith(commit.id, commit.shortId);
  });

  it("compares each historical path at its revision in chronological order", () => {
    const older = { ...commit, id: "a".repeat(40), shortId: "aaaaaaaa", historyPath: "old/name.ts" };
    const newer = { ...commit, id: "b".repeat(40), shortId: "bbbbbbbb", historyPath: "renamed/name.ts" };

    showCompareVersions(older, newer, "/repo/current/name.ts");

    expect(mocks.openVcsDiff).toHaveBeenCalledWith({
      path: "/repo/current/name.ts",
      left: { type: "rev", rev: older.id, path: "/repo/old/name.ts", label: older.shortId },
      right: { type: "rev", rev: newer.id, path: "/repo/renamed/name.ts", label: newer.shortId },
    });
    expect(mocks.openDialog).not.toHaveBeenCalled();
  });

  it("falls back to the File History target when either selected revision has no historical path", () => {
    const { historyPath: _olderPath, ...older } = { ...commit, id: "a".repeat(40), shortId: "aaaaaaaa" };
    const { historyPath: _newerPath, ...newer } = { ...commit, id: "b".repeat(40), shortId: "bbbbbbbb" };

    showCompareVersions(older, newer, "/repo/current/name.ts");

    expect(mocks.openVcsDiff).toHaveBeenCalledWith({
      path: "/repo/current/name.ts",
      left: { type: "rev", rev: older.id, path: "/repo/current/name.ts", label: older.shortId },
      right: { type: "rev", rev: newer.id, path: "/repo/current/name.ts", label: newer.shortId },
    });
  });

  it("routes the revision-row Compare with Local action to the scoped file diff", async () => {
    const arg: FileHistoryCommitArg = { kind: "file-history-commit", commit, target: "/repo/new/name.ts" };
    await getAction("vcs.log.compareWithLocal")!.run({ arg, ctx: {} });

    expect(mocks.openVcsDiff).toHaveBeenCalledWith({
      path: "/repo/new/name.ts",
      left: { type: "rev", rev: commit.id, path: "/repo/old/name.ts", label: commit.shortId },
      right: { type: "worktree" },
    });
    expect(mocks.showWorktreeComparison).not.toHaveBeenCalled();
  });

  it("routes Show File at Revision through the read-only revision editor", async () => {
    const arg: FileHistoryCommitArg = { kind: "file-history-commit", commit, target: "/repo/new/name.ts" };
    await getAction("vcs.log.showFileAtRevision")!.run({ arg, ctx: {} });

    expect(mocks.openRevisionFile).toHaveBeenCalledWith("/repo", commit.id, "old/name.ts", false);
  });

  it("routes scoped Compare Versions with both selected revision paths", async () => {
    const older = { ...commit, id: "a".repeat(40), shortId: "aaaaaaaa", historyPath: "old/name.ts" };
    const newer = { ...commit, id: "b".repeat(40), shortId: "bbbbbbbb", historyPath: "renamed/name.ts" };
    const arg: FileHistoryCommitsArg = {
      kind: "file-history-commits",
      commits: [newer, older],
      target: "/repo/current/name.ts",
    };

    await getAction("vcs.log.compareVersions")!.run({ arg, ctx: {} });

    expect(mocks.openVcsDiff).toHaveBeenCalledWith({
      path: "/repo/current/name.ts",
      left: { type: "rev", rev: older.id, path: "/repo/old/name.ts", label: older.shortId },
      right: { type: "rev", rev: newer.id, path: "/repo/renamed/name.ts", label: newer.shortId },
    });
  });

  it("does not attach a parked File History path to an explicit normal-log selection", async () => {
    useGitLog.setState({
      shownLog: "history:1",
      logTabs: [
        { id: "history:1", kind: "history", target: "/repo/current/name.ts", repo: "/repo", location: "toolWindow" },
      ],
    });
    const older = { ...commit, id: "a".repeat(40), shortId: "aaaaaaaa", historyPath: "old/name.ts" };
    const newer = { ...commit, id: "b".repeat(40), shortId: "bbbbbbbb", historyPath: "renamed/name.ts" };

    await getAction("vcs.log.compareVersions")!.run({ arg: [newer, older], ctx: {} });

    expect(mocks.openVcsDiff).not.toHaveBeenCalled();
    expect(mocks.openDialog).toHaveBeenCalled();
  });

  it("keeps Compare Versions restricted to exactly two commits", async () => {
    const commits = ["a", "b", "c"].map((id) => ({
      ...commit,
      id: id.repeat(40),
      shortId: id.repeat(8),
    }));

    await getAction("vcs.log.compareVersions")!.run({ arg: commits, ctx: {} });

    expect(mocks.openVcsDiff).not.toHaveBeenCalled();
    expect(mocks.openDialog).not.toHaveBeenCalled();
  });

  it("uses the active File History scope when Compare with Local is invoked without an argument", async () => {
    useGitLog.setState({
      commits: [commit],
      selected: commit.id,
      selection: [commit.id],
      shownLog: "history:1",
      logTabs: [
        { id: "history:1", kind: "history", target: "/repo/new/name.ts", repo: "/repo", location: "toolWindow" },
      ],
    });
    await getAction("vcs.log.compareWithLocal")!.run({ ctx: {} });

    expect(mocks.openVcsDiff).toHaveBeenCalledWith({
      path: "/repo/new/name.ts",
      left: { type: "rev", rev: commit.id, path: "/repo/old/name.ts", label: commit.shortId },
      right: { type: "worktree" },
    });
  });

  it("does not apply a parked File History scope to an explicitly passed plain commit", async () => {
    useGitLog.setState({
      shownLog: "history:1",
      logTabs: [
        { id: "history:1", kind: "history", target: "/repo/new/name.ts", repo: "/repo", location: "toolWindow" },
      ],
    });
    await getAction("vcs.log.compareWithLocal")!.run({ arg: commit, ctx: {} });

    expect(mocks.openVcsDiff).not.toHaveBeenCalled();
    expect(mocks.showWorktreeComparison).toHaveBeenCalledWith(commit.id, commit.shortId);
  });

  it("keeps command-based Compare with Local repository-scoped in the normal log", async () => {
    useGitLog.setState({ commits: [commit], selected: commit.id, selection: [commit.id], shownLog: "log" });
    await getAction("vcs.log.compareWithLocal")!.run({ ctx: {} });

    expect(mocks.openVcsDiff).not.toHaveBeenCalled();
    expect(mocks.showWorktreeComparison).toHaveBeenCalledWith(commit.id, commit.shortId);
  });
});

describe("Git Log commit shortcuts", () => {
  it("act on the selected commit only while the commit list has focus", async () => {
    const originalOverrides = useKeymap.getState().overrides;
    const uninstallDispatcher = installKeyboardDispatcher(window);
    useKeymap.setState({ overrides: { ...originalOverrides, "vcs.log.toggleBookmark": ["F3"] } });
    useGitLog.setState({ commits: [commit], selected: commit.id, selection: [commit.id] });
    const press = () => window.dispatchEvent(new KeyboardEvent("keydown", { code: "F3", key: "F3", bubbles: true }));
    try {
      for (const id of [
        "vcs.log.editMessage",
        "vcs.log.newBranch",
        "vcs.log.goToChild",
        "vcs.log.goToParent",
        "vcs.log.toggleBookmark",
        "vcs.log.toggleBookmarkWithMnemonic",
      ])
        expect(getAction(id)!.keyWhen, id).toBe("vcsLogCommitsFocus");
      press();
      await Promise.resolve();
      expect(mocks.toggleCommitBookmark).not.toHaveBeenCalled();
      setContext("vcsLogCommitsFocus", true);
      press();
      await vi.waitFor(() => expect(mocks.toggleCommitBookmark).toHaveBeenCalledWith(commit));
    } finally {
      setContext("vcsLogCommitsFocus", false);
      useKeymap.setState({ overrides: originalOverrides });
      uninstallDispatcher();
    }
  });
});
