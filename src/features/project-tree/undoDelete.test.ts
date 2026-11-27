import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/workbench/messages", () => ({
  confirm: async () => true,
  confirmChecked: async () => ({ checked: false }),
  ask: async () => ({ button: "cancel", checked: false }),
}));

vi.mock("@/editor/refactor", () => ({
  fileUsages: async () => ({ status: "ok", usages: [] }),
  askUsagesDetected: async () => "cancel",
  viewUsages: () => {},
}));

const { MemoryFs, setProjectFsForTests } = await import("./fs");
const { currentModel, initProjectTree, loadDir } = await import("./store");
const { deleteSelection, undoLastFileOperation } = await import("./operations");

describe("Undo in the Project view", () => {
  let fs: InstanceType<typeof MemoryFs>;

  beforeEach(async () => {
    fs = new MemoryFs(
      {
        "/p/lib/current.txt": "current",
        "/p/lib/obsolete.txt": "obsolete",
        "/p/lib/empty-child/leaf": null,
        "/p/a.txt": "a",
      },
      "/p",
    );
    setProjectFsForTests(fs, "/p");
    initProjectTree("/p", "proj");
    await loadDir("/p");
    await loadDir("/p/lib");
  });

  afterEach(() => {
    setProjectFsForTests(null);
    initProjectTree(null);
  });

  const labels = (dir: string) => (currentModel().children.get(dir) ?? []).map((n) => n.label);

  it("restores a batch exactly as it was before Delete", async () => {
    await deleteSelection([currentModel().byKey.get("/p/lib/obsolete.txt")!]);
    expect(fs.nodes.has("/p/lib/obsolete.txt")).toBe(false);
    await deleteSelection([currentModel().byKey.get("/p/a.txt")!, currentModel().byKey.get("/p/lib")!]);
    expect(labels("/p")).toEqual([]);

    expect(undoLastFileOperation()).toBe(true);
    await vi.waitFor(() => expect(labels("/p")).toEqual(["lib", "a.txt"]));
    expect(fs.nodes.has("/p/lib/current.txt")).toBe(true);
    expect(fs.nodes.has("/p/lib/empty-child/leaf")).toBe(true);
    expect(fs.nodes.has("/p/lib/obsolete.txt")).toBe(false);
    expect(undoLastFileOperation()).toBe(false);
  });
});
