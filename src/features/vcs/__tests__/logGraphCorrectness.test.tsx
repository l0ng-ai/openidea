import type { Commit } from "@/bindings";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { collapseLinear, computeGraph, hideLongEdges, linearizeMerges } from "../graph";
import { GraphCell } from "../log/GraphCell";
import { toLogChanges } from "../logChanges";
import { DEFAULT_LOG_OPTIONS } from "../logOptions";
import { presentLogGraph } from "../logPresentation";
import { commitKey, graphCommit } from "../multiRoot";

const commit = (id: string, parents: string[] = [], refs: string[] = []): Commit => ({
  id,
  shortId: id,
  parents,
  refs,
  author: "Author",
  email: "author@example.com",
  summary: id,
  message: id,
  timeMs: 0,
});

describe("graph projections", () => {
  it("draws a filtered edge without changing the revision used for a file diff", () => {
    const c = { ...commit("tip", ["hidden"]), repo: "/repo", graphParents: ["base"], graphDashed: [true] };
    const graph = graphCommit(c);
    expect(graph.parents).toEqual([commitKey({ id: "base", repo: "/repo" })]);
    expect(computeGraph([graph]).rows[0]!.down[0]!.dashed).toBe(true);
    const [file] = toLogChanges([{ path: "a.ts", kind: "modified", oldPath: null }], c);
    expect(file!.before).toBe("hidden");
    expect(c.parents).toEqual(["hidden"]);
  });

  it("gives a filtered merge pyramid one connection instead of one lane per hidden path", () => {
    // What the backend returns for an author filter over a merge pyramid: the top
    // row connects to every hidden path's nearest match, while its first connection
    // already reaches the rest — the extra lanes stretched the graph column (#2670).
    const row = (id: string, realParents: string[], graphParents: string[], dashed: boolean[]) => ({
      ...commit(id, realParents),
      repo: "/repo",
      graphParents,
      graphDashed: dashed,
    });
    const all = [
      row("v0", ["m1"], ["v1", "v2", "v3"], [true, true, true]),
      row("v1", ["v2"], ["v2"], [false]),
      row("v2", ["v3"], ["v3"], [false]),
      row("v3", ["base"], ["base"], [false]),
      row("base", [], [], []),
    ];
    const { rows, graph } = presentLogGraph(
      all,
      DEFAULT_LOG_OPTIONS,
      { expanded: new Set(), collapsed: new Set(), merges: new Set() },
      new Set(),
    );
    expect(graph[0]!.parents).toEqual([commitKey({ id: "v1", repo: "/repo" })]);
    expect(rows[0]!.width).toBe(1);
    expect(rows[0]!.down).toHaveLength(1);
    expect(rows[0]!.down[0]!.dashed).toBe(true);
  });

  it("keeps a filtered merge narrow while its older matches are still below the page", () => {
    // The first page of an author-filtered log: the merge's hidden parent projects onto
    // older matches that are not loaded yet, while its real parent leads there too (#5345).
    const row = (id: string, realParents: string[], graphParents: string[], dashed: boolean[]) => ({
      ...commit(id, realParents),
      repo: "/repo",
      graphParents,
      graphDashed: dashed,
    });
    const page = [
      row("merge", ["a3", "hidden3"], ["a3", "root", "a1", "a2"], [false, true, true, true]),
      row("a3", ["a2"], ["a2"], [false]),
    ];
    const { rows, graph } = presentLogGraph(
      page,
      DEFAULT_LOG_OPTIONS,
      { expanded: new Set(), collapsed: new Set(), merges: new Set() },
      new Set(),
    );
    expect(graph[0]!.parents).toEqual([commitKey({ id: "a3", repo: "/repo" })]);
    expect(rows[0]!.width).toBe(1);
  });

  it("preserves filter dashes even when collapse hides no additional commits", () => {
    const c = { ...commit("tip", ["base"]), dashed: [true] };
    const collapsed = collapseLinear([c, commit("base")], new Set(["tip"]));
    expect(collapsed.graph[0]!.dashed).toEqual([true]);
  });

  it("keeps selected commits and collapses only the requested fragment", () => {
    const chain = [
      commit("tip", ["selected"]),
      commit("selected", ["middle"]),
      commit("middle", ["base"]),
      commit("base"),
    ];
    const result = collapseLinear(chain, new Set(["selected"]), new Set(["selected", "middle"]));
    expect(result.commits.map((c) => c.id)).toEqual(["tip", "selected", "base"]);
    expect(result.graph[1]).toMatchObject({ parents: ["base"], dashed: [true] });
  });

  it("retains every node and lane beyond twenty-four simultaneous branches", () => {
    const commits = Array.from({ length: 36 }, (_, i) => commit(`tip${i}`, [`base${i}`]));
    const first = computeGraph(commits);
    const next = computeGraph(
      Array.from({ length: 36 }, (_, i) => commit(`base${i}`)),
      first.state,
    );
    expect(first.rows.at(-1)!.width).toBe(36);
    expect(next.rows.map((r) => r.lane)).toEqual(Array.from({ length: 36 }, (_, i) => i));
    expect(next.state.lanes).toEqual([]);
    const { container } = render(<GraphCell row={first.rows.at(-1)!} />);
    expect(Number(container.querySelector("svg")!.getAttribute("width"))).toBeGreaterThan(24 * 10);
  });

  it("makes long-edge arrows navigate to the correct endpoints by keyboard", () => {
    const chain = Array.from({ length: 40 }, (_, i) => commit(`x${i}`, i < 39 ? [`x${i + 1}`] : []));
    const rows = hideLongEdges(computeGraph([commit("tip", ["base"]), ...chain, commit("base")]).rows);
    const down = rows.find((r) => r.down.some((s) => s.arrow === "down"))!;
    const up = rows.find((r) => r.up.some((s) => s.arrow === "up"))!;
    const navigate = vi.fn();
    const { rerender } = render(<GraphCell row={down} onNavigate={navigate} targetTitle={(i) => `Go to ${i}`} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Go to 41" }), { key: "Enter" });
    expect(navigate).toHaveBeenLastCalledWith(41, "base");
    rerender(<GraphCell row={up} onNavigate={navigate} targetTitle={(i) => `Go to ${i}`} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Go to 0" }), { key: " " });
    expect(navigate).toHaveBeenLastCalledWith(0, "base");
  });

  it("shares a passing lane's straight segment between rows", () => {
    const rows = computeGraph([
      commit("tip", ["main", "side"]),
      commit("side", ["base"]),
      commit("side2", ["base"]),
      commit("main", ["base"]),
      commit("base"),
    ]).rows;
    const passing = (row: number) => rows[row]!.down.find((s) => s.from === 0 && s.to === 0);
    expect(passing(1)).toBeDefined();
    expect(passing(2)).toBe(passing(1));
    expect(rows[2]!.up.find((s) => s.from === 0 && s.to === 0)).toBe(passing(1));
  });

  it("keeps each arrow and target when multiple long edges cross the same rows", () => {
    const chain = (prefix: string) =>
      Array.from({ length: 40 }, (_, i) => commit(`${prefix}${i}`, i < 39 ? [`${prefix}${i + 1}`] : []));
    const commits = [
      commit("left", ["left-base"]),
      ...chain("a"),
      commit("right", ["right-base"]),
      ...chain("b"),
      commit("left-base"),
      ...chain("c"),
      commit("right-base"),
    ];
    const rows = hideLongEdges(computeGraph(commits).rows);
    const arrows = rows.flatMap((row) =>
      (
        [
          ["up", row.up, row.upTargets],
          ["down", row.down, row.downTargets],
        ] as const
      ).flatMap(([direction, segments, targets]) =>
        segments.flatMap((segment, index) =>
          segment.arrow === direction ? [[direction, targets![index], segment.targetRow]] : [],
        ),
      ),
    );
    expect(arrows).toEqual([
      ["down", "left-base", 82],
      ["down", "right-base", 123],
      ["up", "left-base", 0],
      ["up", "right-base", 41],
    ]);
    expect(rows[60]!.upTargets).toEqual(["b18"]);
    expect(rows[60]!.downTargets).toEqual(["b19"]);
  });

  it("keeps a referenced branch's colour when an unrelated head is inserted ahead of it", () => {
    const main = commit("main-tip", ["base"], ["HEAD", "main"]);
    const old = computeGraph([main, commit("base")]).rows[0]!;
    const next = computeGraph([commit("tag-tip", [], ["tag: release"]), main, commit("base")]).rows[1]!;
    expect(next.color).toBe(old.color);
    expect(next.lane).toBe(old.lane);
  });

  it("targets the exact incoming fragment instead of the row or its reused colour", () => {
    const graph = computeGraph([
      { ...commit("tip", ["base"]), dashed: [true], edgeTypes: ["collapsed" as const] },
      commit("other"),
      commit("base"),
    ]);
    const fragment = vi.fn();
    render(<GraphCell row={graph.rows[1]!} onFragment={fragment} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Expand this fragment" })[0]!);
    expect(fragment).toHaveBeenCalledWith("base", true, "tip");
  });
});

describe("linear merge presentation", () => {
  const commits = [
    commit("merge", ["main", "feature"]),
    commit("feature", ["feature-base"]),
    commit("feature-base", ["base"]),
    commit("main", ["base"]),
    commit("base"),
  ];

  it("serializes a contained incoming block and expands back to the actual graph", () => {
    const original = structuredClone(commits);
    const linear = linearizeMerges(commits);
    expect(linear.graph.map((c) => c.id)).toEqual(commits.map((c) => c.id));
    expect(linear.graph[0]!.parents).toEqual(["feature"]);
    expect(linear.graph[2]).toMatchObject({ parents: ["main"], dashed: [true] });
    expect(linear.fragments.get("feature-base\0main")).toBe("merge");
    expect(linearizeMerges(commits, new Set(["merge"])).graph.map((c) => c.parents)).toEqual(
      commits.map((c) => c.parents),
    );
    expect(commits).toEqual(original);
  });

  it("linearizes shared fragments while preserving their other incoming edges", () => {
    const shared = [commit("other", ["feature"]), ...commits];
    expect(linearizeMerges(shared).graph[1]!.parents).toEqual(["feature"]);
    expect(linearizeMerges(shared).graph[0]!.parents).toEqual(["feature"]);
    expect(linearizeMerges(commits.slice(0, 3)).graph[0]!.parents).toEqual(["main", "feature"]);
  });

  it("expands nested merge fragments together with their containing merge", () => {
    const nested = [
      commit("outer", ["main", "nested"]),
      commit("nested", ["feature", "topic"]),
      commit("topic", ["base"]),
      commit("feature", ["base"]),
      commit("main", ["base"]),
      commit("base"),
    ];
    const collapsed = linearizeMerges(nested);
    expect(collapsed.graph[0]!.parents).toEqual(["nested"]);
    expect(collapsed.graph[1]!.parents).toEqual(["topic"]);
    expect(linearizeMerges(nested, new Set(["outer"])).graph.map((c) => c.parents)).toEqual(
      nested.map((c) => c.parents),
    );
  });
});
