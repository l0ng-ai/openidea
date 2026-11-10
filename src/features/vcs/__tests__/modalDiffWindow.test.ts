import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Settings } from "@/bindings";
import { getAction } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { provideEditorService } from "@/workbench/contributions";
import { registerCompareActions } from "../compare";
import { showChangesDiff, type LogChange } from "../logChanges";

const front = vi.hoisted(() => ({ diff: vi.fn(), merge: vi.fn() }));
vi.mock("../diffDialog", () => ({ openDiffDialog: front.diff, openMergeDiffDialog: front.merge }));

/** Editor tabs the diffs open in (openDiff → the editor service). */
const openInput = vi.fn(async () => undefined);
provideEditorService({ openInput } as never);
/** Settings › Version Control › Commit: "Use non-modal commit interface" unticked. */
const modal = (on: boolean) =>
  useProject.setState({ settings: on ? ({ vcs: { commit: { nonModal: false } } } as Settings) : null });

let unregister: () => void;
beforeAll(() => (unregister = registerCompareActions()));
afterAll(() => unregister());
beforeEach(() => modal(false));

const texts = { path: "/p/a.ts", left: { text: "a", label: "Expected" }, right: { text: "b", label: "Actual" } };
const merge = {
  path: "a.ts",
  repo: "/p",
  oldPath: null,
  kind: "modified",
  before: "p1",
  after: "m",
  statsFrom: "p1",
  statsTo: "m",
  mergeParents: [
    { rev: "p1", path: "a.ts" },
    { rev: "p2", path: "a.ts" },
  ],
  diff: { path: "/p/a.ts", left: { type: "rev", rev: "p1" }, right: { type: "rev", rev: "m" } },
} as LogChange;

it("opens Compare actions in the front window under the modal interface", async () => {
  modal(true);
  await getAction("diff.compareTexts")!.run({ arg: texts, ctx: {} });
  expect(front.diff).toHaveBeenCalledWith(expect.objectContaining({ path: "/p/a.ts" }));
  expect(openInput).not.toHaveBeenCalled();
});

it("keeps Compare actions in editor tabs with the non-modal interface", async () => {
  await getAction("diff.compareTexts")!.run({ arg: texts, ctx: {} });
  expect(openInput).toHaveBeenCalledTimes(1);
  expect(front.diff).not.toHaveBeenCalled();
});

it("opens a merge commit's file in the front window under the modal interface", async () => {
  modal(true);
  await showChangesDiff([merge]);
  expect(front.merge).toHaveBeenCalledWith(expect.objectContaining({ kind: "git-merge-diff" }));
  expect(openInput).not.toHaveBeenCalled();
});

it("keeps a merge commit's file in an editor tab with the non-modal interface, and previews too", async () => {
  await showChangesDiff([merge]);
  expect(openInput).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "git-merge-diff" }), {
    preview: false,
    focus: true,
  });
  modal(true);
  await showChangesDiff([merge], true);
  expect(front.merge).not.toHaveBeenCalled();
});
