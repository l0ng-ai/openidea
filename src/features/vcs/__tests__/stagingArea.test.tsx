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
import { buildChangeTree, planCommit } from "../changes";
import { useChangelists } from "../changelists";
import { useCommit } from "../commitStore";
import { inclusionChecks, isCommitAll, stagingChecks } from "../staging";
import { useVcs } from "../store";

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

  it("is not Commit All when only unversioned files changed", () => {
    expect(isCommitAll([untracked])).toBe(false);
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
