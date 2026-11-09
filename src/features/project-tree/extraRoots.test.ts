import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "@/bindings";
import { registerProjectViewRoot } from "@/workbench/contributions";

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
const { DEFAULT_TREE_OPTIONS, buildModel, withExtraRoots } = await import("./model");
const { currentModel, initProjectTree, loadDir, revealPath, useProjectTree } = await import("./store");
const { beginRename, commitEditing, deleteSelection } = await import("./operations");

const entry = (path: string, kind: "file" | "dir" = "file"): FileEntry => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  kind,
  size: 0,
  mtimeMs: 1,
  ignored: false,
  excluded: false,
  hidden: false,
});

describe("withExtraRoots", () => {
  it("appends contributed roots after the project root with their own children", () => {
    const listings = new Map([
      ["/p", [entry("/p/a.txt")]],
      ["/data/scratches", [entry("/data/scratches/scratch.java")]],
    ]);
    const base = buildModel({ path: "/p", name: "proj" }, listings, DEFAULT_TREE_OPTIONS);
    const m = withExtraRoots(
      base,
      [{ path: "/data/scratches", label: "Scratches", icon: "scratches" }],
      listings,
      DEFAULT_TREE_OPTIONS,
    );
    expect(m.roots.map((r) => [r.label, r.root, r.icon])).toEqual([
      ["proj", true, undefined],
      ["Scratches", true, "scratches"],
    ]);
    expect(m.children.get("/data/scratches")!.map((n) => n.label)).toEqual(["scratch.java"]);
    expect(m.keyOfPath.get("/data/scratches/scratch.java")).toBe("/data/scratches/scratch.java");
    // The base model is untouched.
    expect(base.roots).toHaveLength(1);
  });

  it("returns the model itself without extra roots", () => {
    const base = buildModel({ path: "/p", name: "proj" }, new Map(), DEFAULT_TREE_OPTIONS);
    expect(withExtraRoots(base, [], new Map(), DEFAULT_TREE_OPTIONS)).toBe(base);
  });
});

describe("project view with a scratches root", () => {
  let unregister = () => {};
  beforeEach(() => {
    localStorage.clear();
    const fs = new MemoryFs({ "/p/README.md": "x", "/data/scratches/scratch.py": "x" }, "/p");
    setProjectFsForTests(fs, "/p");
    initProjectTree("/p", "proj");
    unregister = registerProjectViewRoot({
      id: "scratches",
      label: "Scratches",
      icon: "scratches",
      path: "/data/scratches",
    });
  });
  afterEach(() => {
    unregister();
    setProjectFsForTests(null);
    initProjectTree(null);
  });

  const scratchLabels = () => (currentModel().children.get("/data/scratches") ?? []).map((n) => n.label);

  it("lists, reveals, renames and deletes scratch files", async () => {
    await loadDir("/data/scratches");
    expect(currentModel().roots.map((r) => r.label)).toEqual(["proj", "Scratches"]);
    expect(scratchLabels()).toEqual(["scratch.py"]);

    expect(revealPath("/data/scratches/scratch.py")).toBe(true);
    expect(useProjectTree.getState().expanded.has("/data/scratches")).toBe(true);

    beginRename(currentModel().byKey.get("/data/scratches/scratch.py")!);
    expect(await commitEditing("notes.py")).toBe(true);
    expect(scratchLabels()).toEqual(["notes.py"]);

    await deleteSelection([currentModel().byKey.get("/data/scratches/notes.py")!]);
    expect(scratchLabels()).toEqual([]);
  });

  it("never deletes the scratches root itself", async () => {
    await loadDir("/data/scratches");
    await deleteSelection([currentModel().byKey.get("/data/scratches")!]);
    expect(scratchLabels()).toEqual(["scratch.py"]);
  });
});

describe("project view with External Libraries", () => {
  const JAR = "/m2/spring-boot-4.1.1.jar";
  const CLASS = `${JAR}!/org/springframework/boot/SpringApplication.class`;
  let unregister = () => {};
  beforeEach(() => {
    localStorage.clear();
    setProjectFsForTests(new MemoryFs({ "/p/pom.xml": "x", [CLASS]: "x" }, "/p"), "/p");
    initProjectTree("/p", "proj");
    unregister = registerProjectViewRoot({
      id: "externalLibraries",
      label: "External Libraries",
      icon: "library",
      readOnly: true,
      children: [
        {
          label: "< Maven: spring-boot >",
          icon: "maven-project",
          children: [{ label: "spring-boot-4.1.1.jar", icon: "file-archive", path: `${JAR}!` }],
        },
      ],
    });
  });
  afterEach(() => {
    unregister();
    setProjectFsForTests(null);
    initProjectTree(null);
  });

  it.each([
    ["the archive entry", CLASS],
    [
      "a jdtls class",
      "jdt://contents/spring-boot-4.1.1.jar/org.springframework.boot/SpringApplication.class?=demo/%5C/m2%5C/spring-boot-4.1.1.jar%3Corg.springframework.boot%28SpringApplication.class",
    ],
    ["a Kotlin LSP class", `jar:///m2/spring-boot-4.1.1.jar!/org/springframework/boot/SpringApplication.class`],
  ])("reveals %s inside its jar", (_, path) => {
    expect(revealPath(path)).toBe(true);
    const { expanded, revealRequest } = useProjectTree.getState();
    expect(revealRequest?.path).toBe(CLASS);
    expect([...expanded].some((k) => k.endsWith(`${JAR}!/org/springframework/boot`))).toBe(true);
  });

  it("leaves classes of unlisted jars alone", () => {
    expect(revealPath("jar:///elsewhere/x.jar!/p/C.class")).toBe(false);
  });
});
