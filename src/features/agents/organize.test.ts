import { beforeEach, describe, expect, it } from "vitest";
import type { AgentTask } from "@/bindings";
import {
  EMPTY_ORGANIZE,
  groupMembers,
  groupNameError,
  loadOrganize,
  parseOrganize,
  pinnedMembers,
  pruneOrganize,
  saveOrganize,
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
});
