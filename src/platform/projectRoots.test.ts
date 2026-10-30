import { beforeEach, describe, expect, it } from "vitest";
import {
  effectiveRoots,
  folderRole,
  isTestFileName,
  isTestPath,
  markFolder,
  restoreDetected,
  rootFor,
  rootRole,
  unmarkedRoots,
  validateProjectStructure,
  type RootFolder,
} from "./languageSettings";
import { useProject } from "./project";
import { currentRoots, inFileSet, isTestFile, rootOfPath, useProjectRoots } from "./projectRoots";

const pom = (path: string, kind: RootFolder["kind"]): RootFolder => ({ path, kind, detectedFrom: "pom.xml" });
const DETECTED: RootFolder[] = [
  pom("src/main/java", "source"),
  pom("src/main/resources", "resources"),
  pom("src/test/java", "test"),
  pom("src/test/resources", "testResources"),
  pom("target", "excluded"),
];

describe("effective roots", () => {
  it("shows detected roots until the user marks or unmarks them", () => {
    const ps = validateProjectStructure({ sourceRoots: ["gen"], testRoots: ["src/main/java"], unmarked: ["target"] });
    const roots = effectiveRoots(DETECTED, ps);
    expect(roots.map((r) => [r.path, r.kind, r.detectedFrom])).toEqual([
      ["gen", "source", null],
      ["src/main/java", "test", null],
      ["src/main/resources", "resources", "pom.xml"],
      ["src/test/java", "test", "pom.xml"],
      ["src/test/resources", "testResources", "pom.xml"],
    ]);
    expect(rootRole(roots, "target")).toBeNull();
    expect(unmarkedRoots(DETECTED, ps).map((r) => r.path)).toEqual(["target"]);
    expect(rootRole(effectiveRoots(DETECTED, restoreDetected(ps, DETECTED)), "target")).toBe("excluded");
  });

  it("marks against detection: same role needs no override, unmark records the detected root", () => {
    let ps = validateProjectStructure({});
    ps = markFolder(ps, "src/main/java", "source", DETECTED);
    expect(ps.sourceRoots).toEqual([]);
    ps = markFolder(ps, "src/main/java", null, DETECTED);
    expect(ps.unmarked).toEqual(["src/main/java"]);
    expect(rootRole(effectiveRoots(DETECTED, ps), "src/main/java")).toBeNull();
    // Re-marking it brings it back without a user entry.
    ps = markFolder(ps, "src/main/java", "source", DETECTED);
    expect(ps).toEqual(validateProjectStructure({}));
    ps = markFolder(ps, "docs", "testResources", DETECTED);
    expect(folderRole(ps, "docs")).toBe("testResources");
    expect(markFolder(ps, "docs", null, DETECTED).testResourceRoots).toEqual([]);
  });

  it("stores the content root as '.'", () => {
    const go: RootFolder[] = [{ path: "", kind: "source", detectedFrom: "go.mod" }];
    const ps = markFolder(validateProjectStructure({}), "", null, go);
    expect(ps.unmarked).toEqual(["."]);
    expect(effectiveRoots(go, ps)).toEqual([]);
    const marked = markFolder(validateProjectStructure({}), "", "test", []);
    expect(marked.testRoots).toEqual(["."]);
    expect(rootRole(effectiveRoots([], marked), "")).toBe("test");
  });

  it("finds the innermost root and recognises test files", () => {
    const roots = effectiveRoots(
      [...DETECTED, { path: "", kind: "source", detectedFrom: "go.mod" }],
      validateProjectStructure({}),
    );
    expect(rootFor(roots, "src/test/java/a/B.java")?.path).toBe("src/test/java");
    expect(rootFor(roots, "src/test/javax/B.java")?.path).toBe("");
    expect(isTestPath(roots, "src/test/java/a/B.java")).toBe(true);
    expect(isTestPath(roots, "src/test/resources/app.yml")).toBe(true);
    expect(isTestPath(roots, "src/main/java/a/B.java")).toBe(false);
    expect(isTestPath(roots, "pkg/math_test.go")).toBe(true);
    expect(isTestPath(roots, "target/x_test.go")).toBe(false);
    for (const n of ["a_test.go", "test_x.py", "x_test.py", "conftest.py", "a.test.ts", "b.spec.jsx"])
      expect(isTestFileName(n)).toBe(true);
    for (const n of ["test.ts", "latest.go", "contest.py", "a.test.rs"]) expect(isTestFileName(n)).toBe(false);
  });
});

describe("project roots store", () => {
  beforeEach(() => {
    useProject.setState({
      project: { name: "p", root: "/p", isGit: false, settings: {} } as never,
      settings: { projectStructure: { excluded: ["out"] } } as never,
    });
    useProjectRoots.setState({ root: "/p", detected: DETECTED });
  });

  it("merges detected roots with the current settings", () => {
    expect(currentRoots().map((r) => r.path)).toContain("out");
    expect(rootOfPath("/p/src/main/java/a/B.java")?.kind).toBe("source");
    expect(rootOfPath("/elsewhere/B.java")).toBeNull();
    expect(isTestFile("/p/src/test/java/a/BTest.java")).toBe(true);
  });

  it("answers IDEA's named scopes", () => {
    expect(inFileSet("production", "/p/src/main/java/A.java")).toBe(true);
    expect(inFileSet("production", "/p/src/test/java/ATest.java")).toBe(false);
    expect(inFileSet("test", "/p/src/test/java/ATest.java")).toBe(true);
    expect(inFileSet("all", "/p/README.md")).toBe(true);
    expect(inFileSet("all", "/p/target/x.txt")).toBe(false);
    expect(inFileSet("all", "/elsewhere/x.txt")).toBe(false);
  });

  it("ignores roots of another project", () => {
    useProjectRoots.setState({ root: "/other", detected: DETECTED });
    expect(currentRoots().map((r) => r.path)).toEqual(["out"]);
  });
});

it("lists workspace members as scopes and admits their files without admitting workspace state", async () => {
  const { renderHook } = await import("@testing-library/react");
  const { useProjectModules } = await import("./projectRoots");
  useProject.setState({
    project: {
      root: "/workspace",
      name: "Workspace",
      settings: {},
      isGit: false,
      workspace: { version: 1, name: "Workspace", projects: ["/z", "/a"] },
    },
    settings: {} as never,
  });
  const hook = renderHook(() => useProjectModules());
  expect(hook.result.current).toEqual([
    { name: "z", path: "/z" },
    { name: "a", path: "/a" },
  ]);
  expect(inFileSet("all", "/z/src/main.ts")).toBe(true);
  expect(inFileSet("all", "/workspace/.openidea/workspace.json")).toBe(false);
  hook.unmount();
  useProject.setState({ project: null });
});
