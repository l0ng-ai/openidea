import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryFs, setProjectFsForTests } from "./fs";
import { visibleInfo } from "./model";
import {
  applyFsChange,
  currentModel,
  expandAll,
  initProjectTree,
  loadDir,
  revealPath,
  setExpanded,
  setSelection,
  setViewOption,
  toggleExpanded,
  useProjectTree,
} from "./store";
import { beginNew, commitEditing, copySelection, paste, transfer } from "./operations";
import { closeFileRefactorDialog, pendingFileRefactorDialog } from "./FileRefactorDialogs";

const ROOT = "/p";
let fs: MemoryFs;

beforeEach(() => {
  localStorage.clear();
  fs = new MemoryFs(
    {
      "/p/src/main/kotlin/com/acme/App.kt": "x",
      "/p/src/main/kotlin/com/acme/Util.kt": "x",
      "/p/docs/guide.md": "x",
      "/p/README.md": "x",
    },
    ROOT,
  );
  setProjectFsForTests(fs, ROOT);
  initProjectTree(ROOT, "proj");
});

afterEach(() => {
  setProjectFsForTests(null);
  initProjectTree(null);
});

const childLabels = (key: string) => (currentModel().children.get(key) ?? []).map((n) => n.label);

describe("lazy loading", () => {
  it("loads folders on demand and shares concurrent requests", async () => {
    const spy = vi.spyOn(fs, "readDir");
    await Promise.all([loadDir(ROOT), loadDir(ROOT)]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(childLabels(ROOT)).toEqual(["docs", "src", "README.md"]);
    expect(currentModel().children.has("/p/docs")).toBe(false);
  });

  it("prefetches single-folder chains for compact middle packages", async () => {
    await loadDir(ROOT);
    await loadDir("/p/src");
    await vi.waitFor(() => expect(childLabels(ROOT)).toContain("src/main/kotlin"));
    const node = currentModel().byKey.get("/p/src")!;
    expect(node.path).toBe("/p/src/main/kotlin");
  });

  it("restores the persisted expansion state per project", async () => {
    setExpanded(new Set([ROOT, "/p/docs"]));
    await new Promise((r) => setTimeout(r, 350));
    initProjectTree(null);
    initProjectTree(ROOT, "proj");
    expect([...useProjectTree.getState().expanded].sort()).toEqual(["/p", "/p/docs"]);
  });

  it("drops a folder that vanished and collapses it", async () => {
    await loadDir(ROOT);
    setExpanded(new Set([ROOT, "/p/gone"]));
    await loadDir("/p/gone");
    expect(useProjectTree.getState().expanded.has("/p/gone")).toBe(false);
  });
});

describe("refresh on fsChanged", () => {
  it("reloads affected loaded folders and keeps expansion and selection", async () => {
    await loadDir(ROOT);
    await loadDir("/p/docs");
    setExpanded(new Set([ROOT, "/p/docs"]));
    setSelection(new Set(["/p/docs/guide.md"]), "/p/docs/guide.md");
    const spy = vi.spyOn(fs, "readDir");

    await fs.createFile("/p/docs/api.md");
    await applyFsChange({ created: ["/p/docs/api.md"], modified: [], removed: [] });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("/p/docs");
    expect(childLabels("/p/docs")).toEqual(["api.md", "guide.md"]);
    const s = useProjectTree.getState();
    expect(s.expanded.has("/p/docs")).toBe(true);
    expect([...s.selected]).toEqual(["/p/docs/guide.md"]);
  });

  it("ignores changes in folders that were never loaded", async () => {
    await loadDir(ROOT);
    const spy = vi.spyOn(fs, "readDir");
    await applyFsChange({ created: ["/p/src/main/New.kt"], modified: [], removed: [] });
    expect(spy).not.toHaveBeenCalled();
  });

  it("removes deleted folders and their selection", async () => {
    await loadDir(ROOT);
    await loadDir("/p/docs");
    setSelection(new Set(["/p/docs/guide.md"]), "/p/docs/guide.md");
    await fs.delete("/p/docs");
    await applyFsChange({ created: [], modified: [], removed: ["/p/docs"] });
    expect(useProjectTree.getState().listings.has("/p/docs")).toBe(false);
    expect(childLabels(ROOT)).toEqual(["src", "README.md"]);
    expect(useProjectTree.getState().selected.size).toBe(0);
  });
});

describe("reveal and expand", () => {
  it("expands ancestors of a revealed path and loads them", async () => {
    revealPath("/p/docs/guide.md");
    await vi.waitFor(() => expect(childLabels("/p/docs")).toEqual(["guide.md"]));
    const s = useProjectTree.getState();
    expect(s.expanded.has("/p/docs")).toBe(true);
    expect(s.revealRequest?.path).toBe("/p/docs/guide.md");
    expect(visibleInfo(currentModel(), s.expanded).visible.has("/p/docs/guide.md")).toBe(true);
  });

  it("expands everything below a folder", async () => {
    await expandAll();
    const s = useProjectTree.getState();
    expect(s.expanded.has("/p/src/main/kotlin/com/acme")).toBe(true);
    expect(visibleInfo(currentModel(), s.expanded).visible.has("/p/src/main/kotlin/com/acme/App.kt")).toBe(true);
  });
});

describe("file operations", () => {
  it("creates files through the inline editor (nested paths allowed)", async () => {
    await loadDir(ROOT);
    await beginNew("file", "/p/docs");
    expect(currentModel().children.get("/p/docs")?.[0]?.placeholder).toBe("file");
    expect(await commitEditing("guide.md")).toBe(false);
    expect(await commitEditing("notes/today.md")).toBe(true);
    expect(fs.nodes.has("/p/docs/notes/today.md")).toBe(true);
    expect(useProjectTree.getState().editing).toBeNull();
    expect(childLabels("/p/docs")).toContain("notes");
  });

  it("pastes copies through the Copy dialog and cut items through the Move dialog", async () => {
    await loadDir(ROOT);
    await loadDir("/p/docs");
    setSelection(new Set(["/p/README.md"]), "/p/README.md");
    copySelection(false);
    await paste(ROOT);
    const copy = pendingFileRefactorDialog();
    expect(copy).toMatchObject({ kind: "copy", paths: ["/p/README.md"], target: ROOT });
    if (copy?.kind !== "copy") throw new Error("no copy dialog");
    expect(await copy.copy(ROOT, "NOTES.md", false)).toBe(true);
    expect(fs.nodes.has("/p/NOTES.md")).toBe(true);
    // Without a name (several items) copies get a unique name.
    expect(await transfer(["/p/README.md"], ROOT, "copy")).toBe("/p/README copy.md");
    closeFileRefactorDialog();

    setSelection(new Set(["/p/README.md"]), "/p/README.md");
    copySelection(true);
    await paste("/p/docs");
    const move = pendingFileRefactorDialog();
    expect(move).toMatchObject({ kind: "move", paths: ["/p/README.md"], target: "/p/docs" });
    if (move?.kind !== "move") throw new Error("no move dialog");
    move.onDone?.([{ from: "/p/README.md", to: "/p/docs/README.md" }]);
    expect(useProjectTree.getState().clipboard).toBeNull();
    closeFileRefactorDialog();
  });

  it("refuses to move a folder into itself", async () => {
    await loadDir(ROOT);
    expect(await transfer(["/p/docs"], "/p/docs", "move")).toBe(false);
    expect(fs.nodes.has("/p/docs/guide.md")).toBe(true);
  });
});

describe("single-click expansion", () => {
  it("toggles a folder, opening every folder of a compacted chain", async () => {
    await loadDir(ROOT);
    await loadDir("/p/src");
    await vi.waitFor(() => expect(childLabels(ROOT)).toContain("src/main/kotlin"));
    const chain = currentModel().byKey.get("/p/src")!;
    toggleExpanded(chain);
    expect([...useProjectTree.getState().expanded]).toEqual(
      expect.arrayContaining(["/p/src", "/p/src/main", "/p/src/main/kotlin"]),
    );
    toggleExpanded(chain);
    expect(useProjectTree.getState().expanded.has("/p/src")).toBe(false);
  });

  it("is off by default and its option persists across reloads", async () => {
    expect(useProjectTree.getState().options.singleClickExpand).toBe(false);
    setViewOption("singleClickExpand", true);
    vi.resetModules();
    const fresh = await import("./store");
    expect(fresh.useProjectTree.getState().options.singleClickExpand).toBe(true);
    setViewOption("singleClickExpand", false);
  });
});
