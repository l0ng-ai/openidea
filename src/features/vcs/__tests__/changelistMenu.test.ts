import { describe, expect, it, vi } from "vitest";
import type { FileStatus } from "@/bindings";
import type { MenuItem } from "@/ui";

vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return { ...real, call: vi.fn(), commands: { ...real.commands, vcsStage: "vcsStage", vcsUnstage: "vcsUnstage" } };
});

const { listMenu } = await import("../CommitView");

const fs = (rel: string, staged: FileStatus["staged"], unstaged: FileStatus["unstaged"]): FileStatus => ({
  path: `/p/${rel}`,
  relPath: rel,
  staged,
  unstaged,
  renamedFrom: null,
});

type Action = Extract<MenuItem, { kind: "action" }>;
type Item = Extract<MenuItem, { kind?: "item" }>;

/** Actions in the menu, by action id. */
const actions = (items: MenuItem[]) => items.filter((i): i is Action => i.kind === "action");
/** Labelled items in the menu, by label. */
const item = (items: MenuItem[], label: string) =>
  items.find((i): i is Item => i.kind !== "separator" && i.kind !== "action" && i.label === label);

const files = [fs("a.txt", null, "modified"), fs("b.txt", "modified", null)];

describe("change list header menu", () => {
  it("rolls back, stages and unstages the whole list", () => {
    const menu = listMenu("list-1", false, files);
    const rollback = actions(menu).find((a) => a.action === "vcs.rollback");
    expect(rollback?.arg).toEqual(["/p/a.txt", "/p/b.txt"]);
    // Both operations apply to the list's files, as on a file or directory node.
    expect(item(menu, "Stage")?.disabled).toBe(false);
    expect(item(menu, "Unstage")?.disabled).toBe(false);
    expect(actions(menu).find((a) => a.action === "vcs.shelve")?.arg).toEqual(["/p/a.txt", "/p/b.txt"]);
  });

  it("keeps the change list's own actions", () => {
    const menu = listMenu("list-1", false, files);
    const actionsOf = (menu: MenuItem[]) => actions(menu).map((a) => a.action);
    expect(actionsOf(menu)).toContain("vcs.changelist.commit");
    expect(actionsOf(menu)).toContain("vcs.changelist.delete");
    // An active list is not offered Set Active / Delete.
    expect(actionsOf(listMenu("list-1", true, files))).not.toContain("vcs.changelist.delete");
  });

  it("disables the operations nothing applies to in an empty list", () => {
    const menu = listMenu("list-1", true, []);
    expect(actions(menu).find((a) => a.action === "vcs.rollback")?.disabled).toBe(true);
    expect(item(menu, "Stage")?.disabled).toBe(true);
    expect(item(menu, "Unstage")?.disabled).toBe(true);
  });
});
