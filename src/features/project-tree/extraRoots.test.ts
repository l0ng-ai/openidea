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
const { DEFAULT_TREE_OPTIONS, buildModel, visibleInfo, withExtraRoots } = await import("./model");
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

describe("library reveal root selection", () => {
  const GRADLE = "/g/caches/modules-2/files-2.1/org.example/a/1.0";
  let unregister = () => {};
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    unregister();
    setProjectFsForTests(null);
    initProjectTree(null);
  });

  it.each([
    {
      name: "an archive entry inside the project",
      requested: "/p/lib/a.jar!/x/A.class",
      roots: ["/p/lib/a.jar!"],
      expected: "/p/lib/a.jar!/x/A.class",
    },
    {
      name: "a jdtls class inside the project",
      requested: "jdt://contents/a.jar/x/A.class?=p/%5C/p%5C/lib%5C/a.jar%3Cx%28A.class",
      roots: ["/p/lib/a.jar!"],
      expected: "/p/lib/a.jar!/x/A.class",
    },
    {
      name: "a jar URI inside a workspace member",
      requested: "jar:file:///member/lib/a.jar!/x/A.class",
      roots: ["/member/lib/a.jar!"],
      members: ["/member"],
      expected: "/member/lib/a.jar!/x/A.class",
    },
    {
      name: "JDK 8 sources after an unregistered rt.jar under the JDK home",
      requested:
        "jdt://contents/rt.jar/java.lang/String.class?=p/%5C/jdk8%5C/jre%5C/lib%5C/rt.jar%3Cjava.lang%28String.class",
      roots: ["/jdk8", "/jdk8/src.zip!"],
      expected: "/jdk8/src.zip!/java/lang/String.java",
    },
    {
      name: "the first registered archive candidate before JDK 8 sources",
      requested:
        "jdt://contents/rt.jar/java.lang/String.class?=p/%5C/jdk8%5C/jre%5C/lib%5C/rt.jar%3Cjava.lang%28String.class",
      roots: ["/jdk8", "/jdk8/src.zip!", "/jdk8/jre/lib/rt.jar!"],
      expected: "/jdk8/jre/lib/rt.jar!/java/lang/String.class",
    },
    {
      name: "a Gradle sources jar with a different binary hash directory",
      requested: `jar:file://${GRADLE}/sourceHash/a-1.0-sources.jar!/x/A.java`,
      roots: ["/g", `${GRADLE}/binaryHash/a-1.0.jar!`],
      expected: `${GRADLE}/binaryHash/a-1.0.jar!/x/A.class`,
    },
    {
      name: "the exact Gradle sources archive before its binary fallback",
      requested: `jar:file://${GRADLE}/sourceHash/a-1.0-sources.jar!/x/A.java`,
      roots: [`${GRADLE}/binaryHash/a-1.0.jar!`, `${GRADLE}/sourceHash/a-1.0-sources.jar!`],
      expected: `${GRADLE}/sourceHash/a-1.0-sources.jar!/x/A.java`,
    },
    {
      name: "an unregistered archive inside the project",
      requested: "jar:file:///p/lib/a.jar!/x/A.class",
      roots: [],
      expected: null,
    },
    {
      name: "an unregistered archive inside a workspace member",
      requested: "/member/lib/a.jar!/x/A.class",
      roots: [],
      members: ["/member"],
      expected: null,
    },
    {
      name: "an unregistered archive inside a broader library folder",
      requested: "jar:file:///jdk8/jre/lib/rt.jar!/java/lang/String.class",
      roots: ["/jdk8"],
      expected: null,
    },
  ])("reveals only registered archives: $name", async ({ requested, roots, members, expected }) => {
    setProjectFsForTests(new MemoryFs({ "/p/pom.xml": "x", ...(expected ? { [expected]: "x" } : {}) }, "/p"), "/p");
    initProjectTree("/p", "proj", members);
    unregister = registerProjectViewRoot({
      id: "externalLibraries",
      label: "External Libraries",
      icon: "library",
      readOnly: true,
      children: [
        {
          label: "Libraries",
          icon: "library",
          children: roots.map((path) => ({ label: path, icon: "library", path })),
        },
      ],
    });

    expect(revealPath(requested)).toBe(expected !== null);
    expect(useProjectTree.getState().revealRequest?.path ?? null).toBe(expected);
    if (!expected) return;
    const root = expected.slice(0, expected.indexOf("!/") + 1);
    const rootKey = currentModel().keyOfPath.get(root)!;
    expect(rootKey).not.toBe(root);
    expect(useProjectTree.getState().expanded.has(rootKey)).toBe(true);
    await vi.waitFor(() => {
      const model = currentModel();
      const key = model.keyOfPath.get(expected)!;
      expect(visibleInfo(model, useProjectTree.getState().expanded).visible.has(key)).toBe(true);
    });
  });

  it("matches a Windows archive root registered with backslashes", () => {
    setProjectFsForTests(new MemoryFs({ "C:/p/pom.xml": "x" }, "C:/p"), "C:/p");
    initProjectTree("C:/p", "proj");
    const root = "C:\\m2\\a.jar!";
    unregister = registerProjectViewRoot({
      id: "externalLibraries",
      label: "External Libraries",
      icon: "library",
      readOnly: true,
      children: [{ label: "Libraries", icon: "library", children: [{ label: "a.jar", icon: "library", path: root }] }],
    });

    expect(revealPath("jar:file:///C:/m2/a.jar!/x/A.class")).toBe(true);
    expect(useProjectTree.getState().revealRequest?.path).toBe("C:/m2/a.jar!/x/A.class");
  });
});
