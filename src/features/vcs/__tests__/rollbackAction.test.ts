/**
 * The `vcs.rollback` action's targets: the change tree's selection while the Commit
 * window has focus, the checked changes when the selection holds nothing
 * rollbackable (unversioned files, stale paths), and the fall-throughs otherwise.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAction } from "@/platform/actions";
import type { FileStatus } from "@/bindings";

const mocks = vi.hoisted(() => ({ notify: vi.fn(), showDialog: vi.fn() }));

vi.mock("@/platform/context", () => ({ getContext: () => ({ activeToolWindow: toolWindow }) }));
vi.mock("@/editor/api", async (orig) => {
  const actual = await orig<typeof import("@/editor/api")>();
  return { ...actual, activeEditor: () => undefined };
});
vi.mock("@/workbench/contributions", async (orig) => {
  const actual = await orig<typeof import("@/workbench/contributions")>();
  return { ...actual, maybeEditorService: () => undefined, notifications: () => ({ notify: mocks.notify }) };
});
vi.mock("../gutter", async (orig) => {
  const actual = await orig<typeof import("../gutter")>();
  return { ...actual, rollbackSelectedLines: () => false };
});
vi.mock("../dialogs", () => ({ openDialog: vi.fn(), confirmDialog: vi.fn() }));
vi.mock("../changeOps", async (orig) => {
  const actual = await orig<typeof import("../changeOps")>();
  return { ...actual, showRollbackDialog: mocks.showDialog };
});

const { registerVcsActions } = await import("../actions");
const { useVcs } = await import("../store");
const { useCommit } = await import("../commitStore");

let toolWindow: string | null = null;

const fs = (rel: string, unstaged: FileStatus["unstaged"]): FileStatus => ({
  path: `/r/${rel}`,
  relPath: rel,
  staged: null,
  unstaged,
  renamedFrom: null,
});

/** Two modified files and two unversioned ones, as in the recorded session. */
const status = [
  fs("src/ui/icons.tsx", "modified"),
  fs("src/main.tsx", "modified"),
  fs("src/ui/fileTypeIcons.ts", "untracked"),
  fs("perf/startup-improvement-plan.md", "untracked"),
];

afterEach(() => {
  vi.clearAllMocks();
  toolWindow = null;
  useVcs.setState({ status: [], root: null, roots: [] });
  useCommit.setState({ selection: [], checks: new Map() });
});

describe("vcs.rollback targets", () => {
  it("rolls back the checked changes when the selection holds unversioned files", async () => {
    const unregister = registerVcsActions();
    try {
      useVcs.setState({ status, root: "/r", roots: ["/r"] });
      // The tree selection is the unversioned files; the modified ones are checked.
      useCommit.setState({ selection: ["/r/src/ui/fileTypeIcons.ts", "/r/perf/startup-improvement-plan.md"] });
      toolWindow = "commit";
      await getAction("vcs.rollback")!.run({ arg: undefined, ctx: { vcsAvailable: true } });
      expect(mocks.showDialog).toHaveBeenCalledWith([status[0], status[1]]);
    } finally {
      unregister();
    }
  });

  it("uses the tree selection while it holds rollbackable changes", async () => {
    const unregister = registerVcsActions();
    try {
      useVcs.setState({ status, root: "/r", roots: ["/r"] });
      useCommit.setState({ selection: ["/r/src/main.tsx"] });
      toolWindow = "commit";
      await getAction("vcs.rollback")!.run({ arg: undefined, ctx: { vcsAvailable: true } });
      expect(mocks.showDialog).toHaveBeenCalledWith([status[1]]);
    } finally {
      unregister();
    }
  });

  it("offers every change when nothing is selected or checked", async () => {
    const unregister = registerVcsActions();
    try {
      useVcs.setState({ status, root: "/r", roots: ["/r"] });
      toolWindow = "commit";
      await getAction("vcs.rollback")!.run({ arg: undefined, ctx: { vcsAvailable: true } });
      expect(mocks.showDialog).toHaveBeenCalledWith([status[0], status[1]]);
    } finally {
      unregister();
    }
  });

  it("falls through to every change when the checked set is empty too", async () => {
    const unregister = registerVcsActions();
    try {
      useVcs.setState({ status, root: "/r", roots: ["/r"] });
      // The unversioned file is selected; the modified ones are deliberately unchecked.
      useCommit.setState({
        selection: ["/r/src/ui/fileTypeIcons.ts"],
        checks: new Map([
          ["/r/src/ui/icons.tsx", "none"],
          ["/r/src/main.tsx", "none"],
        ]),
      });
      toolWindow = "commit";
      await getAction("vcs.rollback")!.run({ arg: undefined, ctx: { vcsAvailable: true } });
      expect(mocks.showDialog).toHaveBeenCalledWith([status[0], status[1]]);
    } finally {
      unregister();
    }
  });

  it("still rolls back the explicit paths of a context menu", async () => {
    const unregister = registerVcsActions();
    try {
      useVcs.setState({ status, root: "/r", roots: ["/r"] });
      useCommit.setState({ selection: ["/r/src/ui/fileTypeIcons.ts"] });
      toolWindow = "commit";
      await getAction("vcs.rollback")!.run({ arg: { path: "/r/src/main.tsx" }, ctx: { vcsAvailable: true } });
      expect(mocks.showDialog).toHaveBeenCalledWith([status[1]]);
    } finally {
      unregister();
    }
  });

  it("explains a nested repository entry chosen explicitly", async () => {
    const unregister = registerVcsActions();
    try {
      const status = [fs("app.txt", "modified"), fs("libs/core", "modified"), fs("libs/core/core.txt", "modified")];
      useVcs.setState({ status, root: "/r", roots: ["/r", "/r/libs/core"] });
      toolWindow = "commit";
      await getAction("vcs.rollback")!.run({ arg: { path: "/r/libs/core" }, ctx: { vcsAvailable: true } });
      expect(mocks.showDialog).not.toHaveBeenCalled();
      expect(mocks.notify).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Submodule changes cannot be rolled back here" }),
      );
    } finally {
      unregister();
    }
  });
});
