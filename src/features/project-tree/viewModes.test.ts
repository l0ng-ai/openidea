import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localChangedPaths, registerProjectViewRoot } from "@/workbench/contributions";

vi.mock("@/workbench/messages", () => ({
  confirm: async () => true,
  confirmChecked: async () => ({ checked: false }),
  ask: async () => ({ button: "cancel", checked: false }),
}));

const { MemoryFs, setProjectFsForTests } = await import("./fs");
const { DEFAULT_TREE_OPTIONS, buildModel, buildPathsModel, libKey, pathOfKey, withExtraRoots } =
  await import("./model");
const store = await import("./store");
const {
  autoExpand,
  currentModel,
  initProjectTree,
  isReadOnlyPath,
  loadDir,
  modeShows,
  revealPath,
  setOpenFiles,
  setChangedFiles,
  setViewMode,
  useProjectTree,
} = store;
const { beginRename, deleteSelection } = await import("./operations");
const { contextMenuItems } = await import("./contextMenu");

const LIBS = {
  id: "externalLibraries",
  label: "External Libraries",
  icon: "library",
  order: 5,
  readOnly: true,
  children: [
    {
      label: "< Python 3.12 >",
      icon: "file-python",
      children: [
        { label: "python3.12", icon: "folder-library", path: "/py/lib/python3.12", detail: "library root" },
        { label: "site-packages", icon: "folder-library", path: "/p/.venv/lib/site-packages" },
      ],
    },
  ],
};

/** Key of a library folder / file below the Python SDK group of `LIBS`. */
const pyKey = (path: string) => libKey("externalLibraries/< Python 3.12 >", path);

describe("withExtraRoots groups", () => {
  it("nests group nodes and marks library folders read-only", () => {
    const listings = new Map([
      ["/p", []],
      [
        "/py/lib/python3.12",
        [
          {
            name: "os.py",
            path: "/py/lib/python3.12/os.py",
            kind: "file" as const,
            size: 1,
            mtimeMs: 1,
            ignored: false,
            excluded: false,
            hidden: false,
          },
        ],
      ],
    ]);
    const base = buildModel({ path: "/p", name: "proj" }, listings, DEFAULT_TREE_OPTIONS);
    const m = withExtraRoots(base, [LIBS], listings, DEFAULT_TREE_OPTIONS);
    expect(m.roots.map((r) => [r.label, r.group ?? false])).toEqual([
      ["proj", false],
      ["External Libraries", true],
    ]);
    const group = m.children.get(m.roots[1]!.key)!;
    expect(group.map((n) => n.label)).toEqual(["< Python 3.12 >"]);
    // Library keys have their own namespace: site-packages inside the project is listed too.
    const folders = m.children.get(group[0]!.key)!;
    expect(folders.map((n) => [n.label, n.detail, n.readOnly, n.root, n.key, n.path])).toEqual([
      ["python3.12", "library root", true, false, pyKey("/py/lib/python3.12"), "/py/lib/python3.12"],
      ["site-packages", undefined, true, false, pyKey("/p/.venv/lib/site-packages"), "/p/.venv/lib/site-packages"],
    ]);
    const os = m.byKey.get(pyKey("/py/lib/python3.12/os.py"))!;
    expect([os.readOnly, os.path, pathOfKey(os.key)]).toEqual([
      true,
      "/py/lib/python3.12/os.py",
      "/py/lib/python3.12/os.py",
    ]);
    expect(m.children.get(pyKey("/py/lib/python3.12"))![0]).toBe(os);
    expect(m.keyOfPath.get("/py/lib/python3.12/os.py")).toBe(os.key);
  });
});

describe("buildPathsModel", () => {
  it("builds the folders down to each file below its innermost root", () => {
    const m = buildPathsModel(
      [
        { path: "/p", label: "proj", icon: "" },
        { path: "/data/scratches", label: "Scratches", icon: "scratches" },
      ],
      ["/p/src/b.ts", "/p/src/a/x.ts", "/p/README.md", "/data/scratches/s.py", "/tmp/out.log"],
    );
    expect(m.roots.map((r) => [r.label, r.root, r.icon])).toEqual([
      ["proj", true, undefined],
      ["Scratches", true, "scratches"],
      ["/tmp", true, "folder"],
    ]);
    expect(m.children.get("/p")!.map((n) => n.label)).toEqual(["src", "README.md"]);
    expect(m.children.get("/p/src")!.map((n) => n.label)).toEqual(["a", "b.ts"]);
    expect(m.children.get("/p/src/a")!.map((n) => n.path)).toEqual(["/p/src/a/x.ts"]);
    expect(m.keyOfPath.get("/data/scratches/s.py")).toBe("/data/scratches/s.py");
  });

  it("leaves out roots without files", () => {
    expect(buildPathsModel([{ path: "/p", label: "proj", icon: "" }], []).roots).toEqual([]);
  });
});

describe("localChangedPaths", () => {
  it("lists change-list files, all lists or one, optionally without deleted ones", () => {
    const lists = [
      {
        id: "default",
        name: "Changes",
        active: true,
        files: [{ path: "/p/b.ts" }, { path: "/p/gone.ts", deleted: true }],
      },
      { id: "ui", name: "UI", active: false, files: [{ path: "/p/a.ts" }] },
    ];
    expect(localChangedPaths(lists, null, true)).toEqual(["/p/a.ts", "/p/b.ts"]);
    expect(localChangedPaths(lists)).toEqual(["/p/a.ts", "/p/b.ts", "/p/gone.ts"]);
    expect(localChangedPaths(lists, "ui")).toEqual(["/p/a.ts"]);
    expect(localChangedPaths([])).toEqual([]);
  });
});

describe("project view modes", () => {
  let disposers: Array<() => void> = [];
  beforeEach(() => {
    localStorage.clear();
    const fs = new MemoryFs(
      {
        "/p/src/App.kt": "x",
        "/p/README.md": "x",
        "/data/scratches/s.py": "x",
        "/py/lib/python3.12/os.py": "x",
        "/p/.venv/pyvenv.cfg": "x",
        "/p/.venv/lib/site-packages/req/api.py": "x",
      },
      "/p",
    );
    setProjectFsForTests(fs, "/p");
    initProjectTree("/p", "proj");
    disposers = [
      registerProjectViewRoot({
        id: "scratches",
        label: "Scratches",
        icon: "scratches",
        path: "/data/scratches",
        order: 10,
        scope: "scratches",
      }),
      registerProjectViewRoot(LIBS),
    ];
  });
  afterEach(() => {
    setViewMode("project");
    setOpenFiles([]);
    setChangedFiles([]);
    disposers.forEach((d) => d());
    setProjectFsForTests(null);
    initProjectTree(null);
  });

  const labels = () => currentModel().roots.map((r) => r.label);

  it("switches panes and remembers the choice", () => {
    expect(labels()).toEqual(["proj", "External Libraries", "Scratches"]);
    setViewMode("projectFiles");
    expect(labels()).toEqual(["proj"]);
    setViewMode("scratches");
    expect(labels()).toEqual(["Scratches"]);
    expect(useProjectTree.getState().expanded.has("/data/scratches")).toBe(true);
    expect(localStorage.getItem("openidea.projectTree.mode")).toBe(JSON.stringify("scratches"));
  });

  it("keeps each pane's expansion", () => {
    store.setExpanded(new Set(["/p", "/p/src"]));
    setViewMode("projectFiles");
    expect(useProjectTree.getState().expanded).toEqual(new Set(["/p"]));
    setViewMode("project");
    expect(useProjectTree.getState().expanded).toEqual(new Set(["/p", "/p/src"]));
  });

  it("lists open and changed files, expanded once", () => {
    setOpenFiles(["/p/src/App.kt", "/data/scratches/s.py"]);
    setChangedFiles(["/p/README.md"]);
    setViewMode("openFiles");
    expect(labels()).toEqual(["proj", "Scratches"]);
    autoExpand(currentModel());
    expect([...useProjectTree.getState().expanded].sort()).toEqual(["/data/scratches", "/p", "/p/src"]);
    // A collapsed folder stays collapsed.
    store.setExpanded(new Set(["/p"]));
    autoExpand(currentModel());
    expect(useProjectTree.getState().expanded.has("/p/src")).toBe(false);
    expect(modeShows("/p/src/App.kt")).toBe(true);
    expect(modeShows("/p/README.md")).toBe(false);

    setViewMode("changedFiles");
    expect(
      currentModel()
        .children.get("/p")!
        .map((n) => n.label),
    ).toEqual(["README.md"]);
  });

  it("shows a user scope's files as a pane", () => {
    store.setScopeView("Changed for FTP");
    expect(useProjectTree.getState()).toMatchObject({ mode: "scope", scope: "Changed for FTP" });
    store.setScopeFiles(["/p/src/App.kt", "/p/README.md"]);
    autoExpand(currentModel());
    expect(
      currentModel()
        .children.get("/p")!
        .map((n) => n.label),
    ).toEqual(["src", "README.md"]);
    expect(modeShows("/p/src/App.kt")).toBe(true);
    expect(modeShows("/p/src/Other.kt")).toBe(false);
    // Another scope starts from its own files.
    store.setScopeView("Other");
    expect(useProjectTree.getState()).toMatchObject({ mode: "scope", scope: "Other", scopeFiles: [] });
    setViewMode("project");
    expect(useProjectTree.getState().mode).toBe("project");
  });

  it("reveals library files through their group nodes", async () => {
    await loadDir("/py/lib/python3.12");
    expect(revealPath("/py/lib/python3.12/os.py")).toBe(true);
    const expanded = useProjectTree.getState().expanded;
    expect(expanded.has("\u0000group:externalLibraries")).toBe(true);
    expect(expanded.has("\u0000group:externalLibraries/< Python 3.12 >")).toBe(true);
    expect(expanded.has(pyKey("/py/lib/python3.12"))).toBe(true);
    expect(useProjectTree.getState().revealRequest?.path).toBe("/py/lib/python3.12/os.py");
  });

  it("keeps library sources read-only", async () => {
    await loadDir("/py/lib/python3.12");
    const file = currentModel().byKey.get(pyKey("/py/lib/python3.12/os.py"))!;
    expect(isReadOnlyPath(file.path)).toBe(true);
    expect(isReadOnlyPath("/p/src")).toBe(false);
    beginRename(file);
    expect(useProjectTree.getState().editing).toBeNull();
    await deleteSelection([file]);
    await expect((await import("./fs")).projectFs("/p").readDir("/py/lib/python3.12")).resolves.toHaveLength(1);
    const ids = contextMenuItems([file]).map((i) => ("id" in i ? i.id : i.kind));
    expect(ids).not.toContain("delete");
    expect(ids).not.toContain("new");
    expect(ids).toContain("copyPath");
  });

  it("shows library folders inside the project in both places, read-only", async () => {
    const site = "/p/.venv/lib/site-packages";
    for (const dir of ["/p", "/p/.venv", "/p/.venv/lib", site, `${site}/req`]) await loadDir(dir);
    const m = currentModel();
    // Under the project: path keys, read-only from the library root down.
    const venvKids = m.children.get("/p/.venv")!;
    expect(venvKids.map((n) => [n.label, n.key, n.readOnly ?? false])).toEqual([
      ["lib/site-packages/req", "/p/.venv/lib", true],
      ["pyvenv.cfg", "/p/.venv/pyvenv.cfg", false],
    ]);
    expect(m.byKey.get("/p/.venv")?.readOnly).toBeUndefined();
    const projectFile = m.byKey.get(`${site}/req/api.py`)!;
    expect(projectFile.readOnly).toBe(true);
    // Under External Libraries: the same folders in the library namespace.
    const libFile = m.byKey.get(pyKey(`${site}/req/api.py`))!;
    expect([libFile.path, libFile.readOnly]).toEqual([`${site}/req/api.py`, true]);
    expect(m.children.get(pyKey(site))!.map((n) => n.key)).toEqual([pyKey(`${site}/req`)]);
    // Paths resolve to the project node (Select In, autoscroll from source).
    expect(m.keyOfPath.get(`${site}/req/api.py`)).toBe(`${site}/req/api.py`);
    expect(isReadOnlyPath(site)).toBe(true);

    beginRename(projectFile);
    expect(useProjectTree.getState().editing).toBeNull();
    await deleteSelection([projectFile, libFile]);
    await expect((await import("./fs")).projectFs("/p").readDir(`${site}/req`)).resolves.toHaveLength(1);
    const ids = contextMenuItems([projectFile]).map((i) => ("id" in i ? i.id : i.kind));
    expect(ids).not.toContain("delete");
    expect(ids).not.toContain("rename");
    expect(contextMenuItems([m.byKey.get("/p/.venv/pyvenv.cfg")!]).map((i) => ("id" in i ? i.id : i.kind))).toContain(
      "delete",
    );
  });

  it("expands library folders in their own namespace", async () => {
    await store.expandAll(pyKey("/p/.venv/lib/site-packages"));
    const expanded = useProjectTree.getState().expanded;
    expect(expanded.has(pyKey("/p/.venv/lib/site-packages/req"))).toBe(true);
    expect(expanded.has("/p/.venv/lib/site-packages/req")).toBe(false);
  });
});
