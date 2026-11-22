import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileStatus } from "@/bindings";

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, call: vi.fn(async () => null) };
});

vi.mock("../DiffEditor", () => ({ DiffEditor: () => <div /> }));

import { call, commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useContextMenuStore, type MenuItem } from "@/ui/Menu";
import { ChangesTree, nodeMenu, stageOperation } from "../CommitView";
import { buildChangeTree, changeFileNodes, planCommit, stagingPatchEntries } from "../changes";
import { useChangelists } from "../changelists";
import { useCommit } from "../commitStore";
import {
  bulkStagePaths,
  inclusionChecks,
  isCommitAll,
  ROLLBACK_UNSTAGED,
  STAGE_WITHOUT_CONTENT,
  stagingChecks,
} from "../staging";
import { changeNodeDiff, oneSided } from "../diffInput";
import { useVcs } from "../store";
import { provideEditorService } from "@/workbench/contributions";

const file = (rel: string, staged: FileStatus["staged"], unstaged: FileStatus["unstaged"]): FileStatus => ({
  path: `/p/${rel}`,
  relPath: rel,
  staged,
  unstaged,
  renamedFrom: null,
});

const stagedOnly = file("src/Staged.kt", "modified", null);
const partial = file("src/Partial.kt", "modified", "modified");
const unstagedOnly = file("src/Unstaged.kt", null, "modified");
const untracked = file("src/New.kt", null, "untracked");

function useSettings(stagingArea: boolean, nonModal = true) {
  useProject.setState({
    project: { name: "p", root: "/p", trusted: true, isGit: true, settings: {} } as never,
    settings: { vcs: { git: { stagingArea }, commit: { nonModal } } } as never,
  });
}

describe("staging area inclusion", () => {
  it("commits what is staged, the staged part of a partially staged file, and nothing else", () => {
    const status = [stagedOnly, partial, unstagedOnly, untracked];
    expect(isCommitAll(status)).toBe(false);
    const plan = planCommit(status, stagingChecks(status));
    expect(plan.included.map((f) => f.relPath)).toEqual(["src/Staged.kt", "src/Partial.kt"]);
    // Nothing is added to the index, and nothing staged is left out.
    expect(plan.stage).toEqual([]);
    expect(plan.exclude).toEqual([]);
    expect(plan.partial).toEqual([]);
  });

  it("with nothing staged, Commit All takes every tracked change but not unversioned files", () => {
    const status = [unstagedOnly, file("src/Gone.kt", null, "deleted"), untracked];
    expect(isCommitAll(status)).toBe(true);
    const plan = planCommit(status, stagingChecks(status));
    expect(plan.included.map((f) => f.relPath)).toEqual(["src/Unstaged.kt", "src/Gone.kt"]);
    expect(plan.stage).toEqual(["/p/src/Unstaged.kt", "/p/src/Gone.kt"]);
  });

  it("lists and commits a staged addition deleted from disk; the change lists leave it out", () => {
    const gone = file("src/New.txt", "added", "deleted");
    const status = [gone, unstagedOnly];
    expect(isCommitAll(status)).toBe(false);
    const plan = planCommit(status, stagingChecks(status));
    expect(plan.included.map((f) => f.relPath)).toEqual(["src/New.txt"]);
    expect(plan.exclude).toEqual([]);
    // Staged shows the addition, Unstaged the deletion.
    const tree = buildChangeTree(status, "/p", false, undefined, [], true);
    const kinds = (group: string) =>
      tree.find((n) => n.group === group)?.children?.flatMap((n) => (n.label === "New.txt" ? [n.kind] : []));
    expect(kinds("staged")).toEqual(["added"]);
    expect(kinds("unstaged")).toEqual(["deleted"]);
    // Without the staging area it is no change against HEAD: listed nowhere, never committed.
    expect(buildChangeTree(status, "/p", false).flatMap((n) => n.files.map((f) => f.relPath))).toEqual([
      "src/Unstaged.kt",
    ]);
    expect(planCommit(status, new Map([[unstagedOnly.path, "all" as const]])).exclude).toEqual(["/p/src/New.txt"]);
  });

  it("is not Commit All when only unversioned files changed", () => {
    expect(isCommitAll([untracked])).toBe(false);
  });

  it("requires index changes in staging mode when Commit All is disabled", () => {
    expect(planCommit([unstagedOnly, untracked], stagingChecks([unstagedOnly, untracked], false)).included).toEqual([]);
    expect(planCommit([stagedOnly, unstagedOnly], stagingChecks([stagedOnly, unstagedOnly], false)).included).toEqual([
      stagedOnly,
    ]);
  });

  it("ignores the checkboxes and change lists", () => {
    const status = [stagedOnly, unstagedOnly];
    const lists = {
      active: "a",
      lists: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
      files: { "src/Staged.kt": "b" },
    };
    const checks = new Map([[unstagedOnly.path, "all" as const]]);
    const staging = planCommit(status, inclusionChecks(status, "/p", lists as never, checks, true));
    expect(staging.included.map((f) => f.relPath)).toEqual(["src/Staged.kt"]);
    const lists_ = planCommit(status, inclusionChecks(status, "/p", lists as never, checks, false));
    expect(lists_.included.map((f) => f.relPath)).toEqual(["src/Unstaged.kt"]);
  });
});

describe("staging operations of the tree's nodes", () => {
  const roots = buildChangeTree([stagedOnly, partial, unstagedOnly, untracked], "/p", false, undefined, [], true);
  const group = (id: string) => roots.find((n) => n.group === id)!;

  it("bulk-stages the working side, with untracked paths only for Stage All", () => {
    const removed = file("src/Removed.kt", null, "deleted");
    const renamed = { ...file("src/Renamed.kt", null, "renamed"), renamedFrom: "src/Old.kt" };
    const intent = file("src/Intent.kt", null, "added");
    const status = [
      stagedOnly,
      partial,
      removed,
      renamed,
      intent,
      untracked,
      file("conflict", "conflicted", "conflicted"),
      file("ignored", null, "ignored"),
    ];
    const tracked = [partial.path, removed.path, renamed.path, "/p/src/Old.kt", intent.path];
    expect(bulkStagePaths(status, false)).toEqual(tracked);
    expect(bulkStagePaths(status, true)).toEqual([...tracked, untracked.path]);
  });

  it("preserves rename paths only for the selected side of a patch", () => {
    const renamed = { ...file("src/Renamed.kt", "renamed", "modified"), renamedFrom: "src/Old.kt" };
    const tree = buildChangeTree([renamed], "/p", true, undefined, [], true);
    const unstaged = tree.find((node) => node.group === "unstaged")!;
    expect(stagingPatchEntries([unstaged])).toEqual([{ path: renamed.path, renamedFrom: null, side: "unstaged" }]);
    expect(stagingPatchEntries(tree)).toEqual([{ path: renamed.path, renamedFrom: "/p/src/Old.kt", side: "both" }]);
  });

  it("unstages under Staged and stages under Unstaged and Unversioned Files", () => {
    const op = (id: string) => {
      const o = stageOperation(group(id))!;
      return [o.label, [...o.paths].sort()];
    };
    expect(op("staged")).toEqual(["Unstage", ["/p/src/Partial.kt", "/p/src/Staged.kt"]]);
    expect(op("unstaged")).toEqual(["Stage", ["/p/src/Partial.kt", "/p/src/Unstaged.kt"]]);
    expect(op("unversioned")).toEqual(["Stage", ["/p/src/New.kt"]]);
  });

  it("offers only Unstage for a partially staged file under Staged, only Stage under Unstaged", () => {
    const enabled = (items: MenuItem[], label: string) =>
      !(items.find((i) => "label" in i && i.label === label) as { disabled?: boolean }).disabled;
    const underStaged = group("staged").children!.find((n) => n.label === "Partial.kt")!;
    const underUnstaged = group("unstaged").children!.find((n) => n.label === "Partial.kt")!;
    expect([enabled(nodeMenu([underStaged], []), "Stage"), enabled(nodeMenu([underStaged], []), "Unstage")]).toEqual([
      false,
      true,
    ]);
    expect([
      enabled(nodeMenu([underUnstaged], []), "Stage"),
      enabled(nodeMenu([underUnstaged], []), "Unstage"),
    ]).toEqual([true, false]);
  });

  it("shows HEAD ↔ index under Staged and index ↔ working copy under Unstaged", async () => {
    useSettings(true);
    const openInput = vi.fn(async () => undefined);
    provideEditorService({ openInput } as never);
    const show = (node: (typeof roots)[number]) => {
      const menu = nodeMenu([node], [], { roots });
      (menu.find((m) => "label" in m && m.label === "Show Diff") as { run: () => void }).run();
    };
    const sides = () => {
      const data = (openInput.mock.calls.at(-1) as unknown as [{ data: { left: unknown; right: unknown } }])[0].data;
      return [data.left, data.right];
    };
    show(group("staged").children!.find((n) => n.label === "Partial.kt")!);
    await vi.waitFor(() => expect(openInput).toHaveBeenCalledTimes(1));
    expect(sides()).toEqual([
      { type: "rev", rev: "HEAD", label: "HEAD" },
      { type: "rev", rev: ":0" },
    ]);
    show(group("unstaged").children!.find((n) => n.label === "Partial.kt")!);
    await vi.waitFor(() => expect(openInput).toHaveBeenCalledTimes(2));
    expect(sides()).toEqual([
      { type: "rev", rev: ":0" },
      { type: "worktree", label: "Local Version" },
    ]);
  });

  it("compares additions, deletions, and renames against the selected index side", () => {
    useSettings(true);
    const added = file("src/Added.kt", "added", null);
    const removed = file("src/Removed.kt", null, "deleted");
    const renamed = { ...file("src/Renamed.kt", "renamed", null), renamedFrom: "src/Before.kt" };
    const nodes = changeFileNodes(buildChangeTree([added, removed, renamed], "/p", false, undefined, [], true));
    const diff = (path: string) => changeNodeDiff(nodes.find((node) => node.path === path)!);
    expect(oneSided(diff(added.path))).toBe(true);
    expect(diff(added.path).right).toMatchObject({ type: "rev", rev: ":0" });
    expect(oneSided(diff(removed.path))).toBe(true);
    expect(diff(removed.path).left).toMatchObject({ type: "rev", rev: ":0" });
    expect(diff(renamed.path).left).toMatchObject({ type: "rev", rev: "HEAD", path: "/p/src/Before.kt" });
    expect(stageOperation(nodes.find((node) => node.path === renamed.path)!)?.paths).toEqual([
      renamed.path,
      "/p/src/Before.kt",
    ]);
  });

  it("offers index-preserving Rollback for eligible unstaged rows and intent-to-add for new files", () => {
    useSettings(true);
    const removedAddition = file("src/StagedAndRemoved.kt", "added", "deleted");
    const intent = file("src/Intent.kt", null, "added");
    const nodes = changeFileNodes(
      buildChangeTree([partial, untracked, removedAddition, intent], "/p", false, undefined, [], true),
    );
    const actions = nodeMenu(nodes, []).filter((item) => item.kind === "action");
    expect(actions).toContainEqual(
      expect.objectContaining({
        action: ROLLBACK_UNSTAGED,
        arg: expect.arrayContaining([partial.path, removedAddition.path]),
      }),
    );
    expect(actions.find((item) => item.action === ROLLBACK_UNSTAGED)?.arg).not.toContain(intent.path);
    expect(actions).toContainEqual(expect.objectContaining({ action: STAGE_WITHOUT_CONTENT, arg: [untracked.path] }));
    expect(actions.some((item) => item.action === "vcs.rollback")).toBe(false);
  });

  it("has no Commit File…: a commit takes the whole index", () => {
    useSettings(true);
    const labels = (items: MenuItem[]) => items.map((i) => ("label" in i ? i.label : null));
    for (const node of [group("staged").children![0]!, group("unstaged").children![0]!])
      expect(labels(nodeMenu([node], []))).not.toContain("Commit File…");
    useSettings(false);
    expect(labels(nodeMenu([group("unstaged").children![0]!], []))).toContain("Commit File…");
  });

  it.each([false, true])("groups the change menu for staging area = %s", (staging) => {
    useSettings(staging);
    const underUnstaged = group("unstaged").children!.find((n) => n.label === "Unstaged.kt")!;
    const node = staging ? underUnstaged : { ...underUnstaged, group: "changes" as const, changelist: "a" };
    const groups: string[][] = [[]];
    for (const item of nodeMenu([node], [], { roots })) {
      if (item.kind === "separator") groups.push([]);
      else groups.at(-1)!.push(item.kind === "action" ? item.action : item.label);
    }
    expect(groups[0]).toEqual(
      staging
        ? ["Stage", "Unstage", "vcs.stashSelected", "vcs.rollbackUnstaged", "Delete…"]
        : ["Commit File…", "vcs.rollback", "vcs.changelist.move"],
    );
    expect(groups[1]).toEqual([
      "Show Diff",
      "vcs.showDiffInNewWindow",
      ...(staging ? ["vcs.showThreeSideDiff"] : []),
      "Jump to Source",
      "Copy Path",
      "Copy File Name",
    ]);
    expect(groups).toContainEqual([
      "vcs.createPatch",
      "vcs.copyPatch",
      "vcs.shelve",
      ...(staging ? [] : ["vcs.stashSelected"]),
    ]);
  });
});

describe("the Commit tool window with the staging area", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(call).mockClear();
    useCommit.setState({
      groupByDir: false,
      groupByStaging: false,
      groupByRepo: true,
      checks: new Map(),
      selection: [],
    });
    useChangelists.setState({
      state: {
        active: "a",
        lists: [
          { id: "a", name: "Changes" },
          { id: "b", name: "Feature" },
        ],
        files: {},
      } as never,
    });
    useVcs.setState({ root: "/p", repo: "/p", roots: ["/p"], status: [stagedOnly, unstagedOnly], heads: {} });
  });

  it("groups by staging state without change lists or checkboxes", () => {
    useSettings(true);
    render(<ChangesTree mode="commit" />);
    expect(screen.getByText("Staged Changes")).toBeTruthy();
    expect(screen.getByText("Unstaged Changes")).toBeTruthy();
    expect(screen.queryByText("Feature")).toBeNull();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "View Options" }));
    });
    const labels = useContextMenuStore.getState().menu!.items.map((i) => ("label" in i ? i.label : null));
    act(() => useContextMenuStore.setState({ menu: null }));
    expect(labels).not.toContain("Staging State");
  });

  it("stages a file from its row's button", async () => {
    useSettings(true);
    const stageCommand = vi.spyOn(commands, "vcsStage").mockResolvedValue({ status: "ok", data: null });
    render(<ChangesTree mode="commit" />);
    const stage = screen.getAllByRole("button", { name: "Stage" });
    await act(async () => {
      fireEvent.click(stage[stage.length - 1]!);
    });
    expect(stageCommand).toHaveBeenCalledWith(["/p/src/Unstaged.kt"]);
  });

  it("keeps change lists and checkboxes when off, or under the modal commit interface", () => {
    useSettings(true, false);
    const { unmount } = render(<ChangesTree mode="commit" />);
    expect(screen.getByText("Feature")).toBeTruthy();
    expect(screen.queryAllByRole("checkbox").length).toBeGreaterThan(0);
    unmount();
    useSettings(false);
    render(<ChangesTree mode="commit" />);
    expect(screen.queryByText("Staged Changes")).toBeNull();
  });
});
