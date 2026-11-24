import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Commit } from "@/bindings";
import {
  annotateAtRevision,
  annotatePreviousRevision,
  previousRevisionDiffData,
  revisionDiffData,
  showRevisionDiff,
} from "../annotateRevision";
import { activateRevisionAnnotations } from "../annotateRevisionProvider";
import { createDiffViewerContributions, type DiffViewerHost } from "../diffViewerProviders";
import { useVcs } from "../store";

const mocks = vi.hoisted(() => ({
  openDiff: vi.fn(),
  blame: vi.fn(),
  log: vi.fn(),
  commitFiles: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("../diffInput", async (original) => ({
  ...(await original<typeof import("../diffInput")>()),
  openDiff: mocks.openDiff,
}));
vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    commands: { ...actual.commands, vcsBlame: mocks.blame, vcsLog: mocks.log, vcsCommitFiles: mocks.commitFiles },
  };
});
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  notifications: () => ({ notify: mocks.notify }),
}));

const sha = "f122f5afd61fa24a16a5e1c76c7ed6cbad833c93";
const parent = "12852f79a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";

const commit = (parents: string[]): Commit => ({
  id: sha,
  shortId: sha.slice(0, 8),
  parents,
  author: "Ann",
  email: "ann@x",
  timeMs: Date.UTC(2026, 7, 3, 22, 20),
  summary: "change it",
  message: "change it",
  refs: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  useVcs.setState({ available: true, root: "/repo", repo: "/repo", roots: ["/repo"] });
  mocks.openDiff.mockResolvedValue(undefined);
  mocks.log.mockResolvedValue({ status: "ok", data: [commit([parent])] });
  mocks.commitFiles.mockResolvedValue({ status: "ok", data: [{ path: "a.py", kind: "modified", oldPath: null }] });
  mocks.blame.mockResolvedValue({
    status: "ok",
    data: [
      { commit: sha, author: "Ann", timeMs: 0, summary: "change it" },
      { commit: sha, author: "Ann", timeMs: 0, summary: "change it" },
    ],
  });
});

describe("annotate previous revision", () => {
  it("has no previous revision for a root commit", () => {
    expect(previousRevisionDiffData("/repo/a.py", commit([]))).toBeNull();
  });

  it("shows the file at the first parent against the commit", () => {
    expect(previousRevisionDiffData("/repo/a.py", commit([parent]))).toEqual({
      path: "/repo/a.py",
      left: { type: "rev", rev: parent, label: parent.slice(0, 8) },
      right: { type: "rev", rev: sha, label: sha.slice(0, 8) },
      annotateLeft: true,
    });
  });

  it("opens that diff, asking the viewer to annotate the previous side", async () => {
    await annotatePreviousRevision("/repo/a.py", sha);
    expect(mocks.log).toHaveBeenCalledWith("/repo", expect.objectContaining({ branch: sha, limit: 1 }));
    expect(mocks.openDiff).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/repo/a.py",
        annotateLeft: true,
        left: expect.objectContaining({ rev: parent }),
      }),
      { preview: false },
    );
  });

  it.each([undefined, "old/a.py"])("annotates the historical left pane once (%s)", async (historyPath) => {
    activateRevisionAnnotations();
    const data = historyPath
      ? revisionDiffData("/repo/a.py", "/repo", { id: parent, shortId: parent.slice(0, 8), historyPath })
      : previousRevisionDiffData("/repo/a.py", commit([parent]))!;
    const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: "old one\nold two" }) });
    const host = {
      panes: () => [{ side: "left" as const, view }],
      doc: () => view.state.doc,
    } as unknown as DiffViewerHost;
    const [contribution] = createDiffViewerContributions(data);
    expect(contribution).toBeDefined();
    contribution!.attach?.(host);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.blame).toHaveBeenCalledWith(historyPath ? "/repo/old/a.py" : "/repo/a.py", "old one\nold two", parent);
    // A second attach (panes rebuilt) must not reopen annotations the user closed.
    contribution!.attach?.(host);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.blame).toHaveBeenCalledTimes(1);
    view.destroy();
  });
});

describe("annotate at a chosen revision", () => {
  it("shows the revision against the working file, following a rename", () => {
    expect(revisionDiffData("/repo/a.py", "/repo", { id: sha, shortId: "f122f5af", historyPath: "old/a.py" })).toEqual({
      path: "/repo/a.py",
      left: { type: "rev", rev: sha, label: "f122f5af", path: "/repo/old/a.py" },
      right: { type: "worktree" },
      annotateLeft: true,
    });
  });

  it("opens that diff in a tab", async () => {
    await annotateAtRevision("/repo/a.py", { id: sha, shortId: "f122f5af" });
    expect(mocks.openDiff).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/repo/a.py", right: { type: "worktree" }, annotateLeft: true }),
      { preview: false },
    );
  });
});

describe("show diff from the annotate gutter", () => {
  const absent = (label: string) => ({ type: "text", text: "", label, absent: true });

  it("opens the commit's change to the file against its first parent, not annotated", async () => {
    await showRevisionDiff("/repo/a.py", sha);
    expect(mocks.log).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({ branch: sha, path: "/repo/a.py", follow: true, limit: 1 }),
    );
    expect(mocks.commitFiles).toHaveBeenCalledWith("/repo", sha);
    expect(mocks.openDiff).toHaveBeenCalledWith(
      {
        path: "/repo/a.py",
        left: { type: "rev", rev: parent, path: undefined, label: parent.slice(0, 8) },
        right: { type: "rev", rev: sha, label: sha.slice(0, 8) },
      },
      { preview: false },
    );
  });

  it("shows the file as added when the commit added it", async () => {
    mocks.commitFiles.mockResolvedValue({ status: "ok", data: [{ path: "a.py", kind: "added", oldPath: null }] });
    await showRevisionDiff("/repo/a.py", sha);
    expect(mocks.openDiff).toHaveBeenCalledWith(
      expect.objectContaining({ left: absent("(does not exist)"), right: expect.objectContaining({ rev: sha }) }),
      { preview: false },
    );
  });

  it("shows the old name on the left when the commit renamed the file", async () => {
    mocks.commitFiles.mockResolvedValue({
      status: "ok",
      data: [
        { path: "b.py", kind: "modified", oldPath: null },
        { path: "a.py", kind: "renamed", oldPath: "old/a.py" },
      ],
    });
    await showRevisionDiff("/repo/a.py", sha);
    expect(mocks.openDiff).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/repo/a.py",
        left: expect.objectContaining({ rev: parent, path: "/repo/old/a.py" }),
      }),
      { preview: false },
    );
  });

  it("has an empty left side for a root commit", async () => {
    mocks.log.mockResolvedValue({ status: "ok", data: [commit([])] });
    await showRevisionDiff("/repo/a.py", sha);
    expect(mocks.openDiff).toHaveBeenCalledWith(expect.objectContaining({ left: absent("(does not exist)") }), {
      preview: false,
    });
  });

  it("asks the line's repository, not the selected one", async () => {
    useVcs.setState({ repo: "/repo", roots: ["/repo", "/other"] });
    mocks.commitFiles.mockResolvedValue({
      status: "ok",
      data: [{ path: "src/b.go", kind: "modified", oldPath: null }],
    });
    await showRevisionDiff("/other/src/b.go", sha);
    expect(mocks.log).toHaveBeenCalledWith("/other", expect.anything());
    expect(mocks.commitFiles).toHaveBeenCalledWith("/other", sha);
    expect(mocks.openDiff).toHaveBeenCalledWith(expect.objectContaining({ path: "/other/src/b.go" }), {
      preview: false,
    });
  });

  it("uses the file's name at the commit when it was renamed later", async () => {
    mocks.log.mockResolvedValue({ status: "ok", data: [{ ...commit([parent]), historyPath: "old.py" }] });
    mocks.commitFiles.mockResolvedValue({ status: "ok", data: [{ path: "old.py", kind: "modified", oldPath: null }] });
    await showRevisionDiff("/repo/a.py", sha);
    expect(mocks.log).toHaveBeenCalledTimes(1);
    expect(mocks.openDiff).toHaveBeenCalledWith(
      {
        path: "/repo/old.py",
        left: { type: "rev", rev: parent, path: undefined, label: parent.slice(0, 8) },
        right: { type: "rev", rev: sha, label: sha.slice(0, 8) },
      },
      { preview: false },
    );
  });

  it("reads the commit itself when the file's history doesn't list it (a merge)", async () => {
    const merge = { ...commit([parent, "abcdef0123456789abcdef0123456789abcdef01"]) };
    mocks.log
      .mockResolvedValueOnce({ status: "ok", data: [{ ...commit([]), id: parent, historyPath: "old.py" }] })
      .mockResolvedValueOnce({ status: "ok", data: [merge] });
    await showRevisionDiff("/repo/a.py", sha);
    expect(mocks.log).toHaveBeenLastCalledWith("/repo", expect.objectContaining({ branch: sha, path: null }));
    expect(mocks.openDiff).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/repo/a.py",
        left: expect.objectContaining({ type: "rev", rev: parent }),
        right: expect.objectContaining({ type: "rev", rev: sha }),
      }),
      { preview: false },
    );
  });

  it("falls back to the current path when the commit doesn't list the file", async () => {
    mocks.commitFiles.mockResolvedValue({ status: "ok", data: [{ path: "b.py", kind: "modified", oldPath: null }] });
    await showRevisionDiff("/repo/a.py", sha);
    expect(mocks.openDiff).toHaveBeenCalledWith(expect.objectContaining({ path: "/repo/a.py" }), { preview: false });
  });

  it("reports a failure instead of opening a diff", async () => {
    mocks.commitFiles.mockResolvedValue({ status: "error", error: "bad revision" });
    await showRevisionDiff("/repo/a.py", sha);
    expect(mocks.openDiff).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", title: "Could not show diff" }),
    );
  });
});
