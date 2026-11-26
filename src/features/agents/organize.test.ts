import { beforeEach, describe, expect, it } from "vitest";
import type { AgentTask } from "@/bindings";
import {
  EMPTY_ORGANIZE,
  PINNED_SECTION,
  customSection,
  groupMembers,
  groupNameError,
  loadOrganize,
  parseOrganize,
  pinnedMembers,
  pruneOrganize,
  reorderGroupsInOrganize,
  reorderTaskInOrganize,
  saveOrganize,
  statusGroups,
  statusSection,
  ungroupedMembers,
} from "./organize";

function task(id: string, status: AgentTask["status"] = "ready", updatedMs = 0): AgentTask {
  return {
    id,
    title: id,
    status,
    isolation: "local",
    provider: "claude",
    model: null,
    cwd: "/p",
    branch: null,
    base: null,
    baseCommit: null,
    error: null,
    createdMs: 0,
    updatedMs,
    config: [],
    commands: [],
    usage: null,
    queue: [],
  };
}

beforeEach(() => localStorage.clear());

describe("task organize", () => {
  it("drops saved values of the wrong shape", () => {
    expect(
      parseOrganize({
        groups: [{ id: "g1", name: "Docs" }, { id: 2, name: "Bad" }, null],
        groupOf: { a: "g1", b: "gone", c: 1 },
        pinned: ["a", 3, null],
      }),
    ).toEqual({ groups: [{ id: "g1", name: "Docs" }], groupOf: { a: "g1" }, pinned: ["a"] });
  });

  it("keeps the saved state per project", () => {
    const organize = { groups: [{ id: "g1", name: "Docs" }], groupOf: { a: "g1" }, pinned: ["b"] };
    saveOrganize("/one", organize);
    expect(loadOrganize("/one")).toEqual(organize);
    expect(loadOrganize("/two")).toBe(EMPTY_ORGANIZE);
    expect(loadOrganize(null)).toBe(EMPTY_ORGANIZE);
  });

  it("forgets tasks that no longer exist, keeping empty groups", () => {
    const organize = { groups: [{ id: "g1", name: "Docs" }], groupOf: { a: "g1", gone: "g1" }, pinned: ["b", "gone"] };
    expect(pruneOrganize(organize, [task("a"), task("b")])).toEqual({
      groups: [{ id: "g1", name: "Docs" }],
      groupOf: { a: "g1" },
      pinned: ["b"],
    });
    const clean = { groups: [{ id: "g1", name: "Docs" }], groupOf: { a: "g1" }, pinned: [] };
    expect(pruneOrganize(clean, [task("a")])).toBe(clean);
  });

  it("orders a group by what needs attention, then by activity, leaving pinned tasks out", () => {
    const tasks = [
      task("slow", "running", 30),
      task("ask", "needsInput", 10),
      task("pinned", "ready", 99),
      task("done", "ready", 20),
    ];
    const organize = {
      groups: [{ id: "g1", name: "Docs" }],
      groupOf: Object.fromEntries(tasks.map((t) => [t.id, "g1"])),
      pinned: ["pinned"],
    };
    expect(groupMembers(tasks, organize, "g1").map((t) => t.id)).toEqual(["ask", "slow", "done"]);
  });

  it("shows pinned tasks by activity, and the others under the status groups", () => {
    const tasks = [task("a", "ready", 10), task("b", "running", 30), task("c", "ready", 20)];
    const organize = { groups: [{ id: "g1", name: "Docs" }], groupOf: { c: "g1" }, pinned: ["a", "b"] };
    expect(pinnedMembers(tasks, organize).map((t) => t.id)).toEqual(["b", "a"]);
    expect(ungroupedMembers(tasks, organize).map((t) => t.id)).toEqual([]);
    expect(ungroupedMembers([...tasks, task("d")], organize).map((t) => t.id)).toEqual(["d"]);
  });

  it("takes a group name as typed, unless it is blank or already there", () => {
    const groups = [{ id: "g1", name: "Docs" }];
    expect(groupNameError(" Work ", groups)).toBeNull();
    expect(groupNameError("Docs", groups)).toBe("A group named 'Docs' already exists");
    expect(groupNameError("Docs", groups, "Docs")).toBeNull();
    expect(groupNameError("  ", groups)).toBe("Enter a group name");
  });

  it("parses and prunes saved manual section orders", () => {
    const parsed = parseOrganize({
      groups: [{ id: "g1", name: "Docs" }],
      groupOf: { a: "g1" },
      pinned: ["b"],
      order: {
        pinned: ["b", "b", 123],
        "ug:g1": ["a"],
        "ug:missing": ["a"],
        "g:ready": ["c", "d"],
        "g:unknown": ["c"],
        "g:running": [],
      },
    });
    expect(parsed).toEqual({
      groups: [{ id: "g1", name: "Docs" }],
      groupOf: { a: "g1" },
      pinned: ["b"],
      order: { pinned: ["b"], "ug:g1": ["a"], "g:ready": ["c", "d"] },
    });

    const pruned = pruneOrganize(parsed, [task("a"), task("b"), task("c")]);
    expect(pruned.order).toEqual({ pinned: ["b"], "ug:g1": ["a"], "g:ready": ["c"] });
    expect(pruneOrganize(pruned, [task("a"), task("b"), task("c")])).toBe(pruned);
    // When all ordered tasks are gone, `order` is omitted cleanly.
    expect(pruneOrganize(parsed, [task("x")])).toEqual({
      groups: [{ id: "g1", name: "Docs" }],
      groupOf: {},
      pinned: [],
    });
  });

  it("keeps manual order stable across activity updates and places new tasks on top", () => {
    const initial = [task("a", "ready", 10), task("b", "ready", 20), task("c", "ready", 30)];
    const organize = {
      groups: [],
      groupOf: {},
      pinned: ["a", "b", "c"],
      order: { [PINNED_SECTION]: ["a", "c", "b"] },
    };
    // `b` becomes the most recently active, yet manual order holds.
    const bumped = [task("a", "ready", 10), task("b", "ready", 999), task("c", "ready", 30)];
    expect(pinnedMembers(bumped, organize).map((t) => t.id)).toEqual(["a", "c", "b"]);
    // A newly pinned task not in `order` appears above the manually ordered ones.
    const withNew = [...initial, task("d", "ready", 5)];
    const organizeWithNew = { ...organize, pinned: [...organize.pinned, "d"] };
    expect(pinnedMembers(withNew, organizeWithNew).map((t) => t.id)).toEqual(["d", "a", "c", "b"]);
  });

  it("reorders tasks within a section, across compatible sections, and rejects incompatible status groups", () => {
    const tasks = [task("a", "ready", 30), task("b", "ready", 20), task("c", "ready", 10), task("r", "running", 40)];
    // Reorder within status group `g:ready`.
    const reordered = reorderTaskInOrganize(EMPTY_ORGANIZE, tasks, "c", "a", "before");
    expect(
      statusGroups(tasks, reordered)
        .find((g) => g.status === "ready")
        ?.tasks.map((t) => t.id),
    ).toEqual(["c", "a", "b"]);
    // Dropping in the same effective slot is a no-op.
    expect(reorderTaskInOrganize(reordered, tasks, "a", "c", "after")).toBe(reordered);

    // Move `b` into Pinned before `a` (when `a` is pinned), then into a custom group after `c`.
    const withPinned = {
      groups: [{ id: "g1", name: "Docs" }],
      groupOf: { c: "g1" },
      pinned: ["a"],
      order: { [statusSection("ready")]: ["b"] },
    };
    const pinnedB = reorderTaskInOrganize(withPinned, tasks, "b", "a", "before");
    expect(pinnedB.pinned).toEqual(["a", "b"]);
    expect(pinnedMembers(tasks, pinnedB).map((t) => t.id)).toEqual(["b", "a"]);
    expect(pinnedB.order?.[statusSection("ready")]).toBeUndefined();

    const groupedB = reorderTaskInOrganize(pinnedB, tasks, "b", "c", "after");
    expect(groupedB.pinned).toEqual(["a"]);
    expect(groupedB.groupOf.b).toBe("g1");
    expect(groupMembers(tasks, groupedB, "g1").map((t) => t.id)).toEqual(["c", "b"]);
    expect(groupedB.order?.[PINNED_SECTION]).toEqual(["a"]);

    // Returning a ready task from a custom group to `g:ready` succeeds; a running task cannot land in `g:ready`.
    const withReady = {
      groups: [{ id: "g1", name: "Docs" }],
      groupOf: { b: "g1" },
      pinned: ["r"],
    };
    const returned = reorderTaskInOrganize(withReady, tasks, "b", "a", "after");
    expect(returned.groupOf.b).toBeUndefined();
    expect(returned.order?.[statusSection("ready")]).toEqual(["a", "b", "c"]);
    expect(reorderTaskInOrganize(withReady, tasks, "r", "a", "before")).toBe(withReady);
  });

  it("reorders custom groups", () => {
    const organize = {
      groups: [
        { id: "g1", name: "One" },
        { id: "g2", name: "Two" },
        { id: "g3", name: "Three" },
      ],
      groupOf: {},
      pinned: [],
      order: { [customSection("g1")]: ["a"] },
    };
    const moved = reorderGroupsInOrganize(organize, "g3", "g1", "before");
    expect(moved.groups.map((g) => g.id)).toEqual(["g3", "g1", "g2"]);
    expect(reorderGroupsInOrganize(moved, "g1", "g3", "after")).toBe(moved);
  });
});
