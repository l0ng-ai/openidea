import { EditorState } from "@codemirror/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAction, isActionEnabled } from "@/platform/actions";
import { registerVcsActions } from "../actions";
import { showCurrentRevision } from "../fileRevisions";
import { useVcs } from "../store";

const mocks = vi.hoisted(() => ({
  files: vi.fn(),
  cursor: vi.fn(),
  snapshot: vi.fn(),
  active: vi.fn(),
  editors: vi.fn(),
  open: vi.fn(),
  blame: vi.fn(),
  reveal: vi.fn(),
  show: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("@/editor/api", async (original) => ({
  ...(await original<typeof import("@/editor/api")>()),
  activeEditor: mocks.active,
  editorsFor: mocks.editors,
}));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  maybeEditorService: () => ({ activePath: () => "/repo/file.txt" }),
  editorService: () => ({ openFile: mocks.open, activeCursor: mocks.cursor }),
  toolWindowService: () => ({ show: mocks.show }),
  notifications: () => ({ notify: mocks.notify }),
}));
vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    commands: { ...actual.commands, vcsBlame: mocks.blame, vcsRevisionFiles: mocks.files, docSnapshot: mocks.snapshot },
  };
});
vi.mock("../logStore", async (original) => ({
  ...(await original<typeof import("../logStore")>()),
  revealCommit: mocks.reveal,
}));

let dispose: () => void;
beforeEach(async () => {
  vi.clearAllMocks();
  useVcs.setState({ roots: ["/repo", "/repo/nested"], statusLoaded: true, heads: {}, byPath: new Map() });
  mocks.files.mockResolvedValue({ status: "ok", data: ["file.txt", "other.txt"] });
  dispose = registerVcsActions();
  await vi.waitFor(() =>
    expect(isActionEnabled(getAction("vcs.compareWithRevision")!, { vcsAvailable: true })).toBe(true),
  );
  mocks.active.mockReturnValue({
    ctx: { path: "/repo/file.txt" },
    view: { state: EditorState.create({ doc: "first\nsecond\nunsaved", selection: { anchor: 7 } }) },
  });
});
afterEach(() => dispose());

for (const id of ["vcs.compareWithRevision", "vcs.showCurrentRevision"]) {
  describe(id, () => {
    it("requires Git and a file with committed history, including explicit menu targets", () => {
      const action = getAction(id)!;
      expect(isActionEnabled(action, { vcsAvailable: false })).toBe(false);
      expect(isActionEnabled(action, { vcsAvailable: true })).toBe(true);
      expect(isActionEnabled(action, { vcsAvailable: true }, { path: "/outside/file.txt" })).toBe(false);
      expect(isActionEnabled(action, { vcsAvailable: true }, "/repo/ignored.txt")).toBe(false);
      expect(isActionEnabled(action, { vcsAvailable: true }, "/repo/folder")).toBe(false);
      for (const kind of ["untracked", "ignored", "added", "deleted"] as const) {
        for (const side of ["staged", "unstaged"] as const) {
          useVcs.setState({
            byPath: new Map([
              [
                "/repo/other.txt",
                {
                  path: "/repo/other.txt",
                  relPath: "other.txt",
                  renamedFrom: null,
                  staged: null,
                  unstaged: null,
                  [side]: kind,
                },
              ],
            ]),
          });
          expect(isActionEnabled(action, { vcsAvailable: true }, "/repo/other.txt")).toBe(false);
          expect(isActionEnabled(action, { vcsAvailable: true })).toBe(true);
        }
      }
      useVcs.setState({ statusLoaded: false });
      expect(isActionEnabled(action, { vcsAvailable: true })).toBe(false);
    });
  });
}

it("blames the caret line with unsaved text and selects its commit, not HEAD or the first line", async () => {
  mocks.blame.mockResolvedValue({ status: "ok", data: [{ commit: "aaa" }, { commit: "bbb" }] });
  await getAction("vcs.showCurrentRevision")!.run({ ctx: {}, arg: { path: "/repo/file.txt" } });
  expect(mocks.blame).toHaveBeenCalledWith("/repo/file.txt", "first\nsecond\nunsaved", null);
  expect(mocks.show).toHaveBeenCalledWith("git", true);
  expect(mocks.reveal).toHaveBeenCalledWith("bbb", "/repo");
});

it("opens a project-view file and reveals its commit in its own repository", async () => {
  mocks.editors.mockReturnValue([
    { ctx: { path: "/repo/nested/other.txt" }, view: { state: EditorState.create({ doc: "other" }) } },
  ]);
  mocks.blame.mockResolvedValue({ status: "ok", data: [{ commit: "ccc" }] });
  await showCurrentRevision("/repo/nested/other.txt");
  expect(mocks.open).toHaveBeenCalledWith("/repo/nested/other.txt", { focus: true });
  expect(mocks.reveal).toHaveBeenCalledWith("ccc", "/repo/nested");
});

it.each([{ lines: [] }, { lines: [{ commit: "aaa" }, { commit: "0".repeat(40) }] }])(
  "does not select a commit for an uncommitted caret line",
  async ({ lines }) => {
    mocks.blame.mockResolvedValue({ status: "ok", data: lines });
    await showCurrentRevision("/repo/file.txt");
    expect(mocks.reveal).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalled();
  },
);

it("ignores blame that finishes after switching projects", async () => {
  mocks.blame.mockImplementation(async () => {
    useVcs.setState({ roots: ["/other"] });
    return { status: "ok", data: [{ commit: "aaa" }, { commit: "bbb" }] };
  });
  await showCurrentRevision("/repo/file.txt");
  expect(mocks.reveal).not.toHaveBeenCalled();
});

it("refreshes tracked-file enablement when HEAD changes", async () => {
  mocks.files.mockResolvedValue({ status: "ok", data: ["new.txt"] });
  useVcs.setState({ heads: { "/repo": { head: "main", headCommit: "new-head" } } });
  const action = getAction("vcs.compareWithRevision")!;
  expect(isActionEnabled(action, { vcsAvailable: true })).toBe(false);
  await vi.waitFor(() => expect(isActionEnabled(action, { vcsAvailable: true }, "/repo/new.txt")).toBe(true));
  expect(mocks.files).toHaveBeenCalledWith("/repo", "new-head");
});

it("reports blame failures", async () => {
  mocks.blame.mockRejectedValue(new Error("Cannot read repository"));
  await showCurrentRevision("/repo/file.txt");
  expect(mocks.reveal).not.toHaveBeenCalled();
  expect(mocks.notify).toHaveBeenCalledWith(
    expect.objectContaining({ level: "error", body: "Cannot read repository" }),
  );
});

it("blames a newly opened project-view file before its view mounts", async () => {
  mocks.editors.mockReturnValue([]);
  mocks.cursor.mockReturnValue({ path: "/repo/nested/other.txt", doc: 7, line: 0 });
  mocks.snapshot.mockResolvedValue({ status: "ok", data: { text: "newly opened" } });
  mocks.blame.mockResolvedValue({ status: "ok", data: [{ commit: "ccc" }] });
  await showCurrentRevision("/repo/nested/other.txt");
  expect(mocks.snapshot).toHaveBeenCalledWith(7);
  expect(mocks.blame).toHaveBeenCalledWith("/repo/nested/other.txt", "newly opened", null);
  expect(mocks.reveal).toHaveBeenCalledWith("ccc", "/repo/nested");
});
