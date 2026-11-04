import { describe, expect, it } from "vitest";
import type { GradleDependency, MavenDependency } from "@/platform/ipc";
import {
  analyze,
  coordinates,
  exclusionFor,
  filterArtifacts,
  filterTree,
  fromGradle,
  scopesOf,
  sortedUsages,
  statusText,
  usageStatus,
  type AnalyzerFilter,
} from "./analyzer";

function dep(coords: string, extra: Partial<MavenDependency> = {}, children: MavenDependency[] = []): MavenDependency {
  const [groupId, artifactId, version, scope = "compile"] = coords.split(":");
  return {
    groupId: groupId!,
    artifactId: artifactId!,
    version: version!,
    type: "jar",
    classifier: null,
    scope,
    optional: false,
    children,
    ...extra,
  };
}

/** The tree `dependency:tree -Dverbose` printed for the conflict demo project. */
const TREE: MavenDependency[] = [
  dep("org.hamcrest:hamcrest-core:1.3"),
  dep("org.apache.commons:commons-text:1.10.0", {}, [dep("org.apache.commons:commons-lang3:3.12.0")]),
  dep("org.apache.commons:commons-configuration2:2.10.1", {}, [
    dep("org.apache.commons:commons-lang3:3.14.0", { omitted: "conflict", conflictWith: "3.12.0" }),
    dep("org.apache.commons:commons-text:1.11.0", { omitted: "conflict", conflictWith: "1.10.0" }),
    dep("commons-logging:commons-logging:1.2", { managedFrom: "1.3.0" }),
  ]),
  dep("com.google.guava:guava:32.1.3-jre", {}, [dep("com.google.guava:failureaccess:1.0.1")]),
  dep("com.google.inject:guice:5.1.0", {}, [
    dep("javax.inject:javax.inject:1"),
    dep("com.google.guava:guava:30.1-jre", { omitted: "conflict", conflictWith: "32.1.3-jre" }),
  ]),
  dep("junit:junit:4.13.2:test", {}, [dep("org.hamcrest:hamcrest-core:1.3:test", { omitted: "duplicate" })]),
];

const ALL: AnalyzerFilter = { query: "", conflictsOnly: false, scope: null };
const byKey = (key: string) => analyze(TREE).find((a) => a.key === key)!;

describe("dependency analyzer", () => {
  it("collects every artifact with its resolved version and conflicts", () => {
    const artifacts = analyze(TREE);
    expect(artifacts.filter((a) => a.conflict).map((a) => a.key)).toEqual([
      "com.google.guava:guava",
      "org.apache.commons:commons-lang3",
      "org.apache.commons:commons-text",
    ]);
    const lang3 = byKey("org.apache.commons:commons-lang3");
    expect(lang3).toMatchObject({ version: "3.12.0", requested: ["3.12.0", "3.14.0"], scope: "compile" });
    const hamcrest = byKey("org.hamcrest:hamcrest-core");
    expect(hamcrest.conflict).toBe(false);
    expect(hamcrest.usages).toHaveLength(2);
    // Managed versions count the version that was asked for.
    expect(byKey("commons-logging:commons-logging").requested).toEqual(["1.3.0"]);
  });

  it("lists usage paths from the direct dependency, resolved first", () => {
    const usages = sortedUsages(byKey("com.google.guava:guava").usages);
    expect(usages.map((u) => u.path.map((d) => d.artifactId))).toEqual([["guava"], ["guice", "guava"]]);
    expect(usages.map((u) => statusText(usageStatus(u.dependency)))).toEqual([
      null,
      "omitted for conflict with 32.1.3-jre",
    ]);
    expect(statusText(usageStatus(byKey("commons-logging:commons-logging").usages[0]!.dependency))).toBe(
      "version managed from 1.3.0",
    );
    expect(statusText(usageStatus(dep("a:b:1", { omitted: "duplicate" })))).toBe("omitted for duplicate");
  });

  it("excludes through the direct dependency that brings an occurrence in", () => {
    const [direct, transitive] = sortedUsages(byKey("com.google.guava:guava").usages);
    expect(exclusionFor(direct!)).toBeNull();
    expect(exclusionFor(transitive!)).toEqual({
      dependency: { groupId: "com.google.inject", artifactId: "guice" },
      exclusion: { groupId: "com.google.guava", artifactId: "guava" },
    });
  });

  it("filters by conflicts, scope and text (including requested versions)", () => {
    const keys = (f: Partial<AnalyzerFilter>) => filterArtifacts(analyze(TREE), { ...ALL, ...f }).map((a) => a.key);
    expect(keys({ conflictsOnly: true })).toHaveLength(3);
    expect(keys({ scope: "test" })).toEqual(["junit:junit", "org.hamcrest:hamcrest-core"]);
    expect(keys({ query: "LANG3" })).toEqual(["org.apache.commons:commons-lang3"]);
    expect(keys({ query: "30.1-jre" })).toEqual(["com.google.guava:guava"]);
    expect(scopesOf(analyze(TREE))).toEqual(["compile", "test"]);
  });

  it("keeps the paths to matches in the tree view", () => {
    const conflicted = new Set(
      analyze(TREE)
        .filter((a) => a.conflict)
        .map((a) => a.key),
    );
    expect(filterTree(TREE, ALL, conflicted)).toHaveLength(TREE.length);
    const tree = filterTree(TREE, { ...ALL, conflictsOnly: true }, conflicted);
    expect(tree.map((n) => n.dependency.artifactId)).toEqual([
      "commons-text",
      "commons-configuration2",
      "guava",
      "guice",
    ]);
    expect(tree[1]!.children.map((n) => n.dependency.artifactId)).toEqual(["commons-lang3", "commons-text"]);
    expect(tree[3]!.children.map((n) => n.key)).toEqual(["/4/1"]);
    expect(filterTree(TREE, { ...ALL, query: "hamcrest", scope: "test" }, conflicted).map((n) => n.key)).toEqual([
      "/5",
    ]);
  });

  it("formats coordinates with the classifier", () => {
    expect(coordinates(dep("g:a:1", { classifier: "linux" }))).toBe("g:a:linux:1");
    expect(coordinates(dep("g:a:1"))).toBe("g:a:1");
  });
});

describe("Gradle reports", () => {
  const g = (coords: string, extra: Partial<GradleDependency> = {}): GradleDependency => {
    const [group, name, requested] = coords.split(":");
    return {
      group: group!,
      name: name!,
      requested: requested ?? null,
      selected: null,
      project: false,
      repeated: false,
      constraint: false,
      unresolved: false,
      children: [],
      ...extra,
    };
  };

  it("keeps dependencies, drops constraints and marks only exact requests that lost as conflicts", () => {
    const deps = fromGradle([
      g("a:replaced:1.0", { selected: "1.1" }),
      g("a:strict:{strictly 2.0}", { selected: "2.0" }),
      g("a:dynamic:1.+", { selected: "1.5" }),
      g("a:platform", { selected: "3.0" }),
      g("a:constraint:4.0", { constraint: true }),
      g("a:legacy:1.0", { selected: ":legacy", project: true }),
      g("a:missing:9", { unresolved: true }),
      g("x:y", { group: "", name: ":core", project: true }),
    ]);
    const artifacts = analyze(deps);
    expect(artifacts.map((a) => [a.key, a.version, a.conflict])).toEqual([
      [":core", "", false],
      ["a:dynamic", "1.5", false],
      ["a:legacy", "project :legacy", false],
      ["a:missing", "9", false],
      ["a:platform", "3.0", false],
      ["a:replaced", "1.1", true],
      ["a:strict", "2.0", false],
    ]);
    expect(artifacts.find((a) => a.key === "a:replaced")!.requested).toEqual(["1.0"]);
    expect(statusText(usageStatus(deps[0]!))).toBe("requested 1.0");
    expect(statusText(usageStatus(deps[5]!))).toBe("not resolved");
  });
});
