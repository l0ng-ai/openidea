/** Show Diff for Lines: the file's diff at the changed lines under the caret. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { getAction } from "@/platform/actions";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  editor: null as null | { view: { state: EditorState }; ctx: { path: string } },
  hunks: [] as { start: number; lines: number; from: number; to: number }[],
}));

vi.mock("@/platform/actions", async (orig) => ({
  ...(await orig<typeof import("@/platform/actions")>()),
  executeAction: mocks.execute,
}));
vi.mock("@/editor/api", async (orig) => ({
  ...(await orig<typeof import("@/editor/api")>()),
  activeEditor: () => mocks.editor ?? undefined,
}));
vi.mock("../gutter", async (orig) => ({
  ...(await orig<typeof import("../gutter")>()),
  hunksInSelection: () => mocks.hunks,
}));

const { registerVcsActions } = await import("../actions");

/** "a\nb\nc\nd\n" with the caret at `pos`. */
const editorAt = (pos: number) => ({
  view: { state: EditorState.create({ doc: "a\nb\nc\nd\n", selection: EditorSelection.cursor(pos) }) },
  ctx: { path: "/r/a.ts" },
});

afterEach(() => {
  vi.clearAllMocks();
  mocks.editor = null;
  mocks.hunks = [];
});

describe("vcs.showDiffForLines", () => {
  it("is enabled only with the caret on changed lines", () => {
    const unregister = registerVcsActions();
    try {
      const action = getAction("vcs.showDiffForLines")!;
      mocks.editor = editorAt(2);
      expect(action.enabled?.({ arg: undefined, ctx: {} })).toBe(false);
      mocks.hunks = [{ start: 1, lines: 2, from: 2, to: 6 }];
      expect(action.enabled?.({ arg: undefined, ctx: {} })).toBe(true);
    } finally {
      unregister();
    }
  });

  it("opens the file's diff at the caret's line, or the change's first line", async () => {
    const unregister = registerVcsActions();
    try {
      const action = getAction("vcs.showDiffForLines")!;
      mocks.hunks = [{ start: 1, lines: 2, from: 2, to: 6 }];
      mocks.editor = editorAt(4); // line 3
      await action.run({ arg: undefined, ctx: {} });
      expect(mocks.execute).toHaveBeenLastCalledWith("vcs.showDiff", { path: "/r/a.ts", line: 2 });
      mocks.editor = editorAt(7); // a selection's head past the change
      await action.run({ arg: undefined, ctx: {} });
      expect(mocks.execute).toHaveBeenLastCalledWith("vcs.showDiff", { path: "/r/a.ts", line: 1 });
    } finally {
      unregister();
    }
  });
});
