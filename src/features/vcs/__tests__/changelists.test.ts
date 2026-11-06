import { describe, expect, it } from "vitest";
import type { ChangelistState, FileStatus } from "@/bindings";
import { buildChangeTree, planCommit, type ChangeNode } from "../changes";
import {
  addList,
  checksForList,
  editList,
  initialChangelists,
  listOf,
  localChangelists,
  moveFiles,
  removeList,
  setActiveList,
  syncAssignments,
  validateListName,
  withListDefaults,
} from "../changelists";

const fs = (rel: string, staged: FileStatus["staged"], unstaged: FileStatus["unstaged"]): FileStatus => ({
  path: `/r/${rel}`,
  relPath: rel,
  staged,
  unstaged,
  renamedFrom: null,
});

const status = [
  fs("src/a.ts", null, "modified"),
  fs("src/b.ts", null, "modified"),
  fs("README.md", "modified", null),
  fs("notes.txt", null, "untracked"),
];

function twoLists(): { state: ChangelistState; feature: string } {
  const { state, id } = addList(initialChangelists(), "Feature");
  return { state: moveFiles(state, ["src/b.ts"], id), feature: id };
}

const shape = (nodes: ChangeNode[], depth = 0): string[] =>
  nodes.flatMap((n) => [`${"  ".repeat(depth)}${n.label}`, ...shape(n.children ?? [], depth + 1)]);

describe("change list model", () => {
  it("publishes each list with its files (unversioned left out, deletions marked)", () => {
    const { state, feature } = twoLists();
    const lists = localChangelists(
      [...status, fs("gone.ts", null, "deleted"), fs("c.ts", "conflicted", null)],
      "/r",
      state,
    );
    expect(lists.map((l) => [l.id, l.active, l.files])).toEqual([
      [
        "default",
        true,
        [{ path: "/r/src/a.ts" }, { path: "/r/README.md" }, { path: "/r/gone.ts", deleted: true }, { path: "/r/c.ts" }],
      ],
      [feature, false, [{ path: "/r/src/b.ts" }]],
    ]);
  });

  it("assigns new changes to the active list and forgets unchanged files", () => {
    const { state, feature } = twoLists();
    const synced = syncAssignments(state, ["src/a.ts", "src/b.ts", "README.md"])!;
    expect(synced.files).toEqual({ "src/a.ts": "default", "src/b.ts": feature, "README.md": "default" });
    expect(syncAssignments(synced, ["src/a.ts", "src/b.ts", "README.md"])).toBeNull();

    const active = setActiveList(synced, feature);
    const next = syncAssignments(active, ["src/b.ts", "new.ts"])!;
    expect(next.files).toEqual({ "src/b.ts": feature, "new.ts": feature });
  });

  it("keeps the lists of files whose changes a merge, rebase or update put aside", () => {
    const { state, feature } = twoLists();
    // The rebase stashed every change: nothing looks changed until they come back.
    const aside = syncAssignments(state, [], true);
    expect(aside?.files ?? state.files).toEqual(state.files);
    const back = syncAssignments(aside ?? state, ["src/b.ts"]);
    expect((back ?? aside ?? state).files).toEqual({ "src/b.ts": feature });
  });

  it("files without an assignment belong to the active list", () => {
    const { state, feature } = twoLists();
    expect(listOf(state, "src/b.ts")).toBe(feature);
    expect(listOf(state, "other.ts")).toBe("default");
    expect(listOf({ ...state, files: { "x.ts": "gone" } }, "x.ts")).toBe("default");
  });

  it("creates, edits, activates and removes lists", () => {
    const { state, feature } = twoLists();
    expect(validateListName(state, "feature")).toMatch(/already exists/);
    expect(validateListName(state, "  ")).toMatch(/empty/);
    expect(validateListName(state, "Feature", feature)).toBeNull();

    const edited = editList(state, feature, "Feature X", "ticket 42");
    expect(edited.lists[1]).toMatchObject({ name: "Feature X", comment: "ticket 42" });

    // The active list cannot be removed.
    const active = setActiveList(edited, feature);
    expect(removeList(active, feature)).toBe(active);
    // Removing a list moves its files to the active one.
    const removed = removeList(edited, feature);
    expect(removed.lists.map((l) => l.id)).toEqual(["default"]);
    expect(removed.files).toEqual({ "src/b.ts": "default" });

    const made = addList(state, "Hotfix", { makeActive: true });
    expect(made.state.active).toBe(made.id);
    expect(setActiveList(state, "nope")).toBe(state);
    expect(moveFiles(state, ["src/a.ts"], "nope")).toBe(state);
  });

  it("splits Changes into one group per list, the active one first in state order", () => {
    const { state } = twoLists();
    expect(shape(buildChangeTree(status, "/r", false, state))).toEqual([
      "Changes",
      "  a.ts",
      "  README.md",
      "Feature",
      "  b.ts",
      "Unversioned Files",
      "  notes.txt",
    ]);
    const tree = buildChangeTree(status, "/r", true, state);
    const feature = tree.find((n) => n.label === "Feature")!;
    expect(feature.changelist).toBe(state.lists[1]!.id);
    expect(feature.children!.every((c) => c.changelist === feature.changelist)).toBe(true);
    // Directory keys stay unique across lists.
    const keys = new Set<string>();
    const walk = (ns: ChangeNode[]) =>
      ns.forEach((n) => {
        expect(keys.has(n.key)).toBe(false);
        keys.add(n.key);
        walk(n.children ?? []);
      });
    walk(tree);
  });

  it("shows empty user lists but hides an empty default list when it is the only one", () => {
    const { state } = addList(initialChangelists(), "Empty");
    expect(shape(buildChangeTree([], "/r", false, state))).toEqual(["Changes", "Empty"]);
    expect(buildChangeTree([], "/r", false, initialChangelists())).toEqual([]);
  });

  it("includes only the active list in a commit by default", () => {
    const { state, feature } = twoLists();
    const checks = withListDefaults(status, "/r", state, new Map());
    expect(checks.get("/r/src/b.ts")).toBe("none");
    expect(planCommit(status, checks).included.map((f) => f.relPath)).toEqual(["src/a.ts", "README.md"]);
    // An explicit checkbox wins.
    const explicit = withListDefaults(status, "/r", state, new Map([["/r/src/b.ts", "all" as const]]));
    expect(explicit.get("/r/src/b.ts")).toBe("all");

    const only = checksForList(status, "/r", state, feature);
    expect(planCommit(status, only).included.map((f) => f.relPath)).toEqual(["src/b.ts"]);
  });
});
