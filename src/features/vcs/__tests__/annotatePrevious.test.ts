import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Commit } from "@/bindings";
import {
  annotateAtRevision,
  annotatePreviousRevision,
  previousRevisionDiffData,
  revisionDiffData,
} from "../annotatePrevious";
import { activateAnnotatePreviousRevision } from "../annotatePreviousProvider";
import type { DiffData } from "../diffInput";
import { createDiffViewerContributions, type DiffViewerHost } from "../diffViewerProviders";
import { useVcs } from "../store";

const mocks = vi.hoisted(() => ({ openDiff: vi.fn(), blame: vi.fn(), log: vi.fn() }));

vi.mock("../diffInput", async (original) => ({
  ...(await original<typeof import("../diffInput")>()),
  openDiff: mocks.openDiff,
}));
vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return { ...actual, commands: { ...actual.commands, vcsBlame: mocks.blame, vcsLog: mocks.log } };
});

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

  it("shows the file at the first parent against the commit, on the line that was annotated", () => {
    expect(previousRevisionDiffData("/repo/a.py", commit([parent]), 3)).toEqual({
      path: "/repo/a.py",
      left: { type: "rev", rev: parent, label: parent.slice(0, 8) },
      right: { type: "rev", rev: sha, label: sha.slice(0, 8) },
      line: 3,
      lineSide: "right",
      annotateLeft: true,
    });
  });

  it("opens that diff, asking the viewer to annotate the previous side", async () => {
    await annotatePreviousRevision("/repo/a.py", sha, 3);
    expect(mocks.log).toHaveBeenCalledWith("/repo", expect.objectContaining({ branch: sha, limit: 1 }));
    expect(mocks.openDiff).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/repo/a.py",
        line: 3,
        annotateLeft: true,
        left: expect.objectContaining({ rev: parent }),
      }),
      { preview: false },
    );
  });

  it("annotates the left pane of a diff that asks for it, once", async () => {
    activateAnnotatePreviousRevision();
    const data = previousRevisionDiffData("/repo/a.py", commit([parent])) as DiffData;
    const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: "old one\nold two" }) });
    const host = {
      panes: () => [{ side: "left" as const, view }],
      doc: () => view.state.doc,
    } as unknown as DiffViewerHost;
    const [contribution] = createDiffViewerContributions(data);
    expect(contribution).toBeDefined();
    contribution!.attach?.(host);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.blame).toHaveBeenCalledWith("/repo/a.py", "old one\nold two", parent);
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
