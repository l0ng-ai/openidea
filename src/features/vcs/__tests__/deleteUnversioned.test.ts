import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileStatus } from "@/bindings";
import type { MenuItem } from "@/ui";
import type { ChangeNode } from "../changes";

const mocks = vi.hoisted(() => ({ confirm: vi.fn(), fsDelete: vi.fn(), call: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return { ...real, call: mocks.call, commands: { ...real.commands, fsDelete: mocks.fsDelete } };
});
vi.mock("../dialogs", async (original) => ({
  ...(await original<typeof import("../dialogs")>()),
  confirmDialog: mocks.confirm,
}));

const { deletableUnversioned, nodeMenu } = await import("../CommitView");
const { deleteUnversioned } = await import("../changeOps");

const file = (rel: string, unstaged: FileStatus["unstaged"]): ChangeNode => {
  const f: FileStatus = { path: `/p/${rel}`, relPath: rel, staged: null, unstaged, renamedFrom: null };
  return { key: f.path, type: "file", label: rel, group: "unversioned", files: [f], path: f.path };
};
const deleteItem = (menu: MenuItem[]) =>
  menu.find((i) => i.kind !== "separator" && "label" in i && i.label === "Delete…");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fsDelete.mockImplementation((path: string) => path);
  mocks.call.mockResolvedValue(null);
});

describe("Delete… for unversioned files", () => {
  it("is offered only when every selected file is unversioned", () => {
    expect(deleteItem(nodeMenu([file("a.txt", "untracked"), file("b.txt", "untracked")], ["/p"]))).toBeDefined();
    expect(deleteItem(nodeMenu([file("a.txt", "untracked"), file("c.txt", "modified")], ["/p"]))).toBeUndefined();
    expect(deleteItem(nodeMenu([file("c.txt", "modified")], ["/p"]))).toBeUndefined();
  });

  it("shows the Delete key and gives the key handler the same paths", () => {
    expect(deleteItem(nodeMenu([file("a.txt", "untracked")], ["/p"]))).toMatchObject({ shortcut: "⌫" });
    expect(deletableUnversioned([file("a.txt", "untracked"), file("b.txt", "untracked")])).toEqual([
      "/p/a.txt",
      "/p/b.txt",
    ]);
    expect(deletableUnversioned([file("a.txt", "untracked"), file("c.txt", "modified")])).toEqual([]);
    expect(deletableUnversioned([])).toEqual([]);
  });

  it("asks first, then deletes each file", async () => {
    mocks.confirm.mockResolvedValueOnce(false);
    await deleteUnversioned(["/p/a.txt"]);
    expect(mocks.fsDelete).not.toHaveBeenCalled();

    mocks.confirm.mockResolvedValueOnce(true);
    await deleteUnversioned(["/p/a.txt", "/p/b.txt"]);
    expect(mocks.fsDelete.mock.calls.map((c) => c[0])).toEqual(["/p/a.txt", "/p/b.txt"]);
  });
});
