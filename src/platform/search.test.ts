import { beforeEach, describe, expect, it } from "vitest";
import { useProject } from "./project";
import { projectModules } from "./projectRoots";
import {
  contextAccepts,
  customScopes,
  findCustomScope,
  rememberSearch,
  saveCustomScopes,
  searchHistory,
  useCustomScopes,
} from "./search";

const openProject = (root: string | null) =>
  useProject.setState({
    project: root ? ({ root, name: "p", isGit: false } as never) : null,
  });

describe("shared search pieces", () => {
  beforeEach(() => {
    localStorage.clear();
    useCustomScopes.setState({ root: null, scopes: [] });
    openProject(null);
  });

  it("search context accepts matches like the backend", () => {
    expect(contextAccepts("any", "comment")).toBe(true);
    expect(contextAccepts("inComments", "comment")).toBe(true);
    expect(contextAccepts("inComments", null)).toBe(false);
    expect(contextAccepts("exceptStringLiterals", "comment")).toBe(true);
    expect(contextAccepts("exceptStringLiterals", "string")).toBe(false);
    expect(contextAccepts("exceptCommentsAndStringLiterals", null)).toBe(true);
  });

  it("history is shared, newest first and unique", () => {
    rememberSearch("find", "a");
    rememberSearch("find", "b\nc");
    rememberSearch("find", "a");
    expect(searchHistory("find")).toEqual(["a", "b\nc"]);
  });

  it("keeps each project's history apart (#5758)", () => {
    openProject("/work/a");
    rememberSearch("find", "FooService");
    rememberSearch("replace", "BarService");
    openProject("/work/b");
    expect(searchHistory("find")).toEqual([]);
    rememberSearch("find", "parse_args");
    expect(searchHistory("find")).toEqual(["parse_args"]);
    openProject("/work/a");
    expect(searchHistory("find")).toEqual(["FooService"]);
    expect(searchHistory("replace")).toEqual(["BarService"]);
  });

  it("custom scopes are saved per project", () => {
    openProject("/p1");
    saveCustomScopes([
      { name: " Sources ", pattern: " file:src//* " },
      { name: "", pattern: "x" },
    ]);
    expect(customScopes()).toEqual([{ name: "Sources", pattern: "file:src//*" }]);
    openProject("/p2");
    expect(customScopes()).toEqual([]);
    openProject("/p1");
    expect(findCustomScope("Sources")?.pattern).toBe("file:src//*");
  });

  it("modules are the project and the folders of detected build files", () => {
    const modules = projectModules(
      [
        { path: "web/src", kind: "source", detectedFrom: "web/package.json" },
        { path: "src", kind: "source", detectedFrom: "Cargo.toml" },
        { path: "crates/a/src", kind: "source", detectedFrom: "crates/a/Cargo.toml" },
        { path: "gen", kind: "excluded", detectedFrom: null },
      ],
      "app",
    );
    expect(modules).toEqual([
      { path: "", name: "app" },
      { path: "crates/a", name: "a" },
      { path: "web", name: "web" },
    ]);
  });

  it("keeps Gradle modules after a sync", () => {
    // Root shapes ide-host `with_gradle_roots` writes for a synced multi-module build.
    const synced = projectModules(
      [
        { path: "src/main/java", kind: "source", detectedFrom: "Gradle" },
        { path: "lib/src/main/java", kind: "source", detectedFrom: "lib/Gradle" },
        { path: "lib/build", kind: "excluded", detectedFrom: "lib/Gradle" },
      ],
      "app",
    );
    expect(synced).toEqual([
      { path: "", name: "app" },
      { path: "lib", name: "lib" },
    ]);
  });
});
