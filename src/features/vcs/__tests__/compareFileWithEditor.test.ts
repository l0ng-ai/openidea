import { EditorState } from "@codemirror/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ kind: vi.fn(), notify: vi.fn(), openDiff: vi.fn() }));
vi.mock("../diffInput", () => ({ openDiff: mocks.openDiff, openVcsDiff: mocks.openDiff }));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  commands: { fsEntryKind: mocks.kind },
}));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  notifications: () => ({ notify: mocks.notify }),
}));
import { useEditorRegistry, type TextEditorHandle } from "@/editor/api";
import { getAction } from "@/platform/actions";
import { clearContext, setContext } from "@/platform/context";
import { provideProjectViewSelection, setProjectViewLead } from "@/workbench/contributions";
import { registerCompareActions } from "../compare";

const run = (arg?: unknown, ctx: Record<string, unknown> = {}) =>
  getAction("diff.compareFileWithEditor")!.run({ ctx, arg } as never);

function openEditor(path: string, doc: string, caret: number) {
  setContext("editorPath", path);
  const state = EditorState.create({ doc, selection: { anchor: caret } });
  useEditorRegistry.setState({ active: { ctx: { path }, view: { state } } as unknown as TextEditorHandle });
}

const notified = () => mocks.notify.mock.calls.map(([n]) => (n as { title: string }).title);

let dispose: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  dispose = registerCompareActions();
  mocks.kind.mockImplementation((path: string) =>
    Promise.resolve({ status: "ok", data: path.endsWith("/dir") ? "dir" : "file" }),
  );
});
afterEach(() => {
  dispose();
  clearContext("editorPath");
  setProjectViewLead(null);
  useEditorRegistry.setState({ active: null });
});

describe("Compare File with Editor", () => {
  it("is a Find Action entry titled as in IDEA", () => {
    const action = getAction("diff.compareFileWithEditor")!;
    expect(action.title).toBe("Compare File with Editor");
    expect(action.hidden).not.toBe(true);
  });

  it("diffs the selected file (left) with the editor's file (right) at the editor caret line", async () => {
    openEditor("/p/b.txt", "one\ntwo\nthree\n", 9);
    await run("/p/a.txt");
    expect(mocks.openDiff).toHaveBeenCalledWith({
      path: "/p/b.txt",
      left: { type: "file", path: "/p/a.txt", label: "/p/a.txt" },
      right: { type: "worktree", label: "/p/b.txt" },
      line: 2,
      col: 1,
      swappable: true,
    });
  });

  it("uses the Project view selection while the tree owns the context", async () => {
    openEditor("/p/b.txt", "x", 0);
    const unselect = provideProjectViewSelection(() => ["/p/a.txt"]);
    try {
      await run(undefined, { projectViewFocus: true });
      expect(mocks.openDiff).toHaveBeenLastCalledWith(expect.objectContaining({ path: "/p/b.txt", line: 0 }));
      expect(mocks.openDiff.mock.calls[0]![0].left.path).toBe("/p/a.txt");
      setProjectViewLead({ path: "/p/a.txt", dir: false });
      await run(undefined, {});
      expect(mocks.openDiff).toHaveBeenCalledTimes(2);
    } finally {
      unselect();
    }
  });

  it("ignores a stale Project view selection when invoked over the editor", async () => {
    openEditor("/p/b.txt", "x", 0);
    const unselect = provideProjectViewSelection(() => ["/p/a.txt"]);
    try {
      await run(undefined, {});
      expect(mocks.openDiff).not.toHaveBeenCalled();
      expect(notified()).toEqual(["Select a file in the Project view to compare with the editor"]);
    } finally {
      unselect();
    }
  });

  it("leaves the line unset when the active text editor is not the editor file", async () => {
    openEditor("/p/c.txt", "x\ny", 2);
    setContext("editorPath", "/p/b.txt");
    await run("/p/a.txt");
    expect(mocks.openDiff).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/p/b.txt", line: undefined, col: undefined }),
    );
  });

  it("does nothing but explain for the editor's own file, folders, several files or no editor", async () => {
    await run("/p/a.txt");
    openEditor("jdt://contents/rt.jar/java.lang/String.class", "x", 0);
    await run("/p/a.txt");
    openEditor("/p/a.txt", "x", 0);
    await run("/p/a.txt");
    await run("/p/dir");
    await run("/p/dir/");
    await run(["/p/b.txt", "/p/c.txt"]);
    await run([]);
    expect(mocks.openDiff).not.toHaveBeenCalled();
    expect(notified()).toEqual([
      "Open a file in the editor to compare with",
      "Open a file in the editor to compare with",
      "The selected file is the one open in the editor",
      "Select a file in the Project view to compare with the editor",
      "Select a file in the Project view to compare with the editor",
      "Select a file in the Project view to compare with the editor",
      "Select a file in the Project view to compare with the editor",
    ]);
  });
});
