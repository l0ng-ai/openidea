import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Commit } from "@/bindings";
import { collapseLinear, computeGraph, hideLongEdges, linearizeMerges } from "../graph";
import { commitKey, graphCommit } from "../multiRoot";
import { GraphCell } from "../GitLog";
import { toLogChanges } from "../logChanges";

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
