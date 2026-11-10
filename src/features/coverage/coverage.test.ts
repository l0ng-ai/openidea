import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import type { CoverageSuite, FileCoverage, RunConfig } from "@/platform/ipc";
import { coverageMarkers } from "./gutter";
import { coverageBadges, coverageSupports, coverageTree, formatPercent, lineState, sortTree } from "./model";
import {
  MAX_SUITES,
  addSuite,
  closeSuite,
  reportEntries,
  resetCoverage,
  setCoverageVisible,
  shownFileCoverage,
  useCoverage,
} from "./store";

function cfg(command: string, args: string[], extra: Partial<RunConfig> = {}): RunConfig {
  return {
    id: "c",
    name: "c",
    kind: "shell",
    command,
    args,
    cwd: null,
    env: {},
    detected: true,
    isTest: false,
    debugAdapter: null,
    ...extra,
  };
}

function file(path: string, covered: number, total: number, branches: [number, number] = [0, 0]): FileCoverage {
  return {
    path,
    lines: [],
    linesCovered: covered,
    linesTotal: total,
    branchesCovered: branches[0],
    branchesTotal: branches[1],
  };
}

const suite = (files: FileCoverage[]): CoverageSuite => ({ runner: "t", hasBranches: true, files });

describe("coverageSupports", () => {
  it("knows the coverage runners", () => {
    expect(coverageSupports(cfg("cargo", ["test"]))).toBe(true);
    expect(coverageSupports(cfg("cargo", ["+nightly", "run"]))).toBe(true);
    expect(coverageSupports(cfg("cargo", ["build"]))).toBe(false);
    expect(coverageSupports(cfg("go", ["test", "./..."]))).toBe(true);
    expect(coverageSupports(cfg("go", ["run", "."]))).toBe(false);
    expect(coverageSupports(cfg("./mvnw", ["test", "-Dtest=A"]))).toBe(true);
    expect(coverageSupports(cfg("gradlew.bat", [":app:test"]))).toBe(true);
    expect(coverageSupports(cfg("mvn", ["package"]))).toBe(false);
    expect(coverageSupports(cfg("pnpm", ["run", "test"], { isTest: true }))).toBe(true);
    expect(coverageSupports(cfg("pnpm", ["run", "dev"]))).toBe(false);
    expect(coverageSupports(cfg("/v/bin/python3", ["-m", "pytest"]))).toBe(true);
    expect(coverageSupports(cfg("uv", ["run", "pytest"]))).toBe(true);
    expect(coverageSupports(cfg("/v/bin/ruby", ["-Ilib", "test/a_test.rb"]))).toBe(true);
    expect(coverageSupports(cfg("bundle", ["exec", "rspec"], { isTest: true }))).toBe(true);
    expect(coverageSupports(cfg("bundle", ["exec", "rake", "db:migrate"]))).toBe(false);
    expect(coverageSupports(cfg("make", ["test"]))).toBe(false);
  });
});

describe("coverage tree", () => {
  const data = suite([
    file("/p/src/a/x.rs", 3, 4, [1, 2]),
    file("/p/src/a/y.rs", 0, 2),
    file("/p/src/b.rs", 5, 5),
    file("/other/lib.rs", 1, 1),
  ]);

  it("groups by directory, sums and compacts single-child chains", () => {
    const tree = coverageTree(data, "/p");
    expect(tree.map((n) => n.name)).toEqual(["src", "other"]);
    const src = tree[0]!;
    expect([src.linesCovered, src.linesTotal, src.branchesCovered, src.branchesTotal]).toEqual([8, 11, 1, 2]);
    expect(tree[1]!.path).toBe("/other");
    expect(tree[1]!.children[0]!.path).toBe("/other/lib.rs");
    const deep = coverageTree(suite([file("/p/src/main/java/A.java", 1, 2)]), "/p");
    expect(deep[0]!.name).toBe("src/main/java");
    expect(deep[0]!.path).toBe("/p/src/main/java");
  });

  it("sorts by name (directories first) or percentage", () => {
    const tree = coverageTree(data, "/p");
    const src = sortTree(tree, "name", true)[1]!;
    expect(src.children.map((n) => n.name)).toEqual(["a", "b.rs"]);
    const byLines = sortTree(tree[0]!.children, "lines", false);
    expect(byLines.map((n) => n.name)).toEqual(["b.rs", "a"]);
    const byBranches = sortTree(tree[0]!.children, "branches", true);
    expect(byBranches.map((n) => n.name)).toEqual(["a", "b.rs"]);
  });

  it("badges every directory and file of the project tree", () => {
    const badges = coverageBadges(coverageTree(data, "/p", false));
    expect(badges.get("/p/src")).toBe("72% lines");
    expect(badges.get("/p/src/a")).toBe("50% lines");
    expect(badges.get("/p/src/a/y.rs")).toBe("0% lines");
  });

  it("formats percentages like IDEA", () => {
    expect(formatPercent(17, 20)).toBe("85% (17/20)");
    expect(formatPercent(1, 1000)).toBe("<1% (1/1000)");
    expect(formatPercent(0, 0)).toBe("n/a");
  });
});

describe("gutter and suites", () => {
  it("marks covered, partial and uncovered lines", () => {
    const f: FileCoverage = {
      ...file("/p/a.rs", 2, 3),
      lines: [
        { line: 0, hits: 2, branchesTotal: 0, branchesCovered: 0 },
        { line: 1, hits: 1, branchesTotal: 2, branchesCovered: 1 },
        { line: 2, hits: 0, branchesTotal: 0, branchesCovered: 0 },
        { line: 99, hits: 1, branchesTotal: 0, branchesCovered: 0 },
      ],
    };
    expect(f.lines.map(lineState)).toEqual(["covered", "partial", "uncovered", "covered"]);
    const doc = EditorState.create({ doc: "a\nb\nc\n" }).doc;
    const colors: string[] = [];
    coverageMarkers(f, doc).between(
      0,
      doc.length,
      (_from, _to, m) => void colors.push((m as unknown as { color: string }).color),
    );
    expect(colors).toEqual(["var(--coverage-covered)", "var(--coverage-partial)", "var(--coverage-uncovered)"]);
  });

  it("keeps the last suites and hides coverage on demand", () => {
    resetCoverage();
    for (let i = 0; i < MAX_SUITES + 2; i++) addSuite(`run ${i}`, suite([file(`/p/${i}.rs`, 1, 1)]));
    const s = useCoverage.getState();
    expect(s.suites).toHaveLength(MAX_SUITES);
    expect(s.suites[0]!.name).toBe(`run ${MAX_SUITES + 1}`);
    expect(shownFileCoverage(`/p/${MAX_SUITES + 1}.rs`)).not.toBeNull();
    setCoverageVisible(false);
    expect(shownFileCoverage(`/p/${MAX_SUITES + 1}.rs`)).toBeNull();
    closeSuite(s.suites[0]!.id);
    expect(useCoverage.getState().activeId).toBe(s.suites[1]!.id);
    resetCoverage();
  });

  it("replaces a re-imported report and lists remembered imports in Manage Coverage Reports", () => {
    addSuite("tests", suite([file("/p/a.rs", 1, 2)]));
    const first = addSuite("lcov.info", suite([file("/p/a.rs", 1, 2)]), "/ci/lcov.info");
    const again = addSuite("lcov.info", suite([file("/p/a.rs", 2, 2)]), "/ci/lcov.info");
    const { suites } = useCoverage.getState();
    expect(suites.map((s) => s.id)).toEqual([again.id, suites[1]!.id]);
    expect(suites.some((s) => s.id === first.id)).toBe(false);
    expect(shownFileCoverage("/p/a.rs")?.linesCovered).toBe(2);
    const entries = reportEntries(suites, [
      { path: "/ci/lcov.info", name: "lcov.info", importedAt: 1 },
      { path: "/ci/jacoco.xml", name: "jacoco.xml", importedAt: 2 },
    ]);
    expect(entries.map((e) => [e.name, e.detail, !!e.suite])).toEqual([
      ["lcov.info", "/ci/lcov.info", true],
      ["tests", "t", true],
      ["jacoco.xml", "/ci/jacoco.xml", false],
    ]);
    resetCoverage();
  });
});
