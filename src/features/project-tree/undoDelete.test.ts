import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const history = vi.hoisted(() => ({
  restored: [] as Array<[string, string]>,
  snapshots: [] as Array<{ id: string; path: string }>,
}));

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
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  const ok = <T>(data: T) => Promise.resolve({ status: "ok" as const, data });
  return {
    ...real,
    commands: {
      ...real.commands,
      // Local History as the backend keeps it: deleted files' snapshots, newest first.
      historyListDir: (dir: string) => {
        const entries = history.snapshots
          .filter((s) => s.path === dir || s.path.startsWith(`${dir}/`))
          .map((s) => ({ ...s, timestampMs: 0, label: "Deleted", size: 1, kind: "snapshot" }));
        return ok({ entries, deleted: [...new Set(entries.map((e) => e.path))] });
      },
      historyRestore: (path: string, id: string) => {
        history.restored.push([path, id]);
        return fs.createFile(path).then(() => ok(null));
      },
    },
  };
});

const { MemoryFs, setProjectFsForTests } = await import("./fs");
const { currentModel, initProjectTree, loadDir } = await import("./store");
const { deleteSelection, undoLastFileOperation } = await import("./operations");
let fs: InstanceType<typeof MemoryFs>;

describe("Undo in the Project view", () => {
  beforeEach(() => {
    fs = new MemoryFs({ "/p/a.txt": "a", "/p/lib/x.ts": "x", "/p/lib/empty/": null }, "/p");
    setProjectFsForTests(fs, "/p");
    initProjectTree("/p", "proj");
    history.restored.length = 0;
    history.snapshots = [
      { id: "new-a", path: "/p/a.txt" },
      { id: "old-a", path: "/p/a.txt" },
      { id: "x1", path: "/p/lib/x.ts" },
    ];
  });
  afterEach(() => {
    setProjectFsForTests(null);
    initProjectTree(null);
  });

  const labels = (dir: string) => (currentModel().children.get(dir) ?? []).map((n) => n.label);

  it("brings deleted files and folders back from their latest Local History snapshots", async () => {
    await loadDir("/p");
    expect(labels("/p")).toEqual(["lib", "a.txt"]);
    await deleteSelection([currentModel().byKey.get("/p/a.txt")!, currentModel().byKey.get("/p/lib")!]);
    expect(labels("/p")).toEqual([]);

    expect(undoLastFileOperation()).toBe(true);
    await vi.waitFor(() => expect(labels("/p")).toEqual(["lib", "a.txt"]));
    expect(history.restored).toEqual([
      ["/p/a.txt", "new-a"],
      ["/p/lib/x.ts", "x1"],
    ]);
    // Undone once: nothing left to undo.
    expect(undoLastFileOperation()).toBe(false);
  });
});
