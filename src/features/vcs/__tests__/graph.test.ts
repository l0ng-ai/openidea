import { describe, expect, it } from "vitest";
import {
  compactLanes,
  computeGraph,
  pruneFilteredEdges,
  straightenLaneChanges,
  type GraphCommit,
  type GraphRow,
} from "../graph";

const c = (id: string, ...parents: string[]) => ({ id, parents });

describe("computeGraph", () => {
  it("keeps a linear history in lane 0", () => {
    const { rows } = computeGraph([c("c", "b"), c("b", "a"), c("a")]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(rows[0]!.up).toEqual([]);
    expect(rows[0]!.down).toEqual([{ from: 0, to: 0, color: 0 }]);
    expect(rows[2]!.down).toEqual([]);
    expect(new Set(rows.map((r) => r.color)).size).toBe(1);
  });

  it("opens a lane for a merge's second parent and joins it back", () => {
    // m merges f into main; f branched from a.
    const { rows } = computeGraph([c("m", "b", "f"), c("f", "a"), c("b", "a"), c("a")]);
    const [m, f, b, a] = rows;
    expect(m!.lane).toBe(0);
    expect(m!.down).toEqual([
      { from: 0, to: 0, color: m!.color },
      { from: 0, to: 1, color: f!.color },
    ]);
    expect(f!.lane).toBe(1);
    expect(f!.color).not.toBe(m!.color);
    // b passes lane 1 (f's parent a) through while sitting in lane 0.
    expect(b!.lane).toBe(0);
    expect(b!.down).toContainEqual({ from: 1, to: 1, color: f!.color });
    // a is expected by both lanes: both lines converge into its node.
    expect(a!.lane).toBe(0);
    expect(a!.up).toEqual([
      { from: 0, to: 0, color: m!.color },
      { from: 1, to: 0, color: f!.color },
    ]);
    expect(a!.width).toBe(2);
  });

  it("reuses freed lanes and continues across pages", () => {
    const first = computeGraph([c("t1", "x"), c("t2", "y")]);
    expect(first.rows.map((r) => r.lane)).toEqual([0, 1]);
    const next = computeGraph([c("x"), c("y"), c("z")], first.state);
    expect(next.rows.map((r) => r.lane)).toEqual([0, 1, 0]);
    expect(next.state.lanes).toEqual([]);
  });

  it("converges lanes that lead to the same parent at its node", () => {
    const { rows } = computeGraph([c("t1", "p"), c("t2", "p"), c("p")]);
    expect(rows[1]!.lane).toBe(1);
    expect(rows[1]!.down).toContainEqual({ from: 1, to: 1, color: rows[1]!.color });
    expect(rows[2]!.lane).toBe(0);
    expect(rows[2]!.up).toEqual([
      { from: 0, to: 0, color: rows[0]!.color },
      { from: 1, to: 0, color: rows[1]!.color },
    ]);
  });

  it("joins a merge parent that is already on another lane", () => {
    // m2 merges x, which lane 1 (from t) already leads to.
    const { rows } = computeGraph([c("t", "x"), c("m2", "b", "x"), c("x", "b"), c("b")]);
    const m2 = rows[1]!;
    expect(m2.down).toContainEqual({ from: m2.lane, to: 0, color: rows[0]!.color });
  });
});

describe("pruneFilteredEdges", () => {
  // A filtered log: hidden commits connect the rows to their nearest matching
  // ancestors, one dashed edge per merge path (`filtered` kind).
  const filtered = (id: string, ...parents: string[]): GraphCommit => ({
    id,
    parents,
    dashed: parents.map(() => true),
    edgeTypes: parents.map(() => "filtered" as const),
  });
  const shown = (id: string, parent: string): GraphCommit => ({
    id,
    parents: [parent],
    dashed: [false],
    edgeTypes: ["normal" as const],
  });

  it("drops filtered ancestors that another connection of the commit already reaches", () => {
    // A merge pyramid under an author filter: every hidden merge path's nearest match
    // is a different row, while v1's own chain already reaches the rest (#2670).
    const commits = [
      filtered("v0", "v1", "v2", "v3", "v4"),
      shown("v1", "v2"),
      shown("v2", "v3"),
      shown("v3", "v4"),
      shown("v4", "base"),
      c("base"),
    ];
    // Without pruning each dashed connection opens a lane of its own.
    expect(computeGraph(commits).rows[0]!.width).toBe(4);
    const pruned = pruneFilteredEdges(commits);
    expect(pruned[0]!.parents).toEqual(["v1"]);
    expect(computeGraph(pruned).rows[0]!.width).toBe(1);
  });

  it("keeps filtered ancestors that no other connection reaches", () => {
    // Two sibling side branches match on different commits: both edges are needed.
    const commits = [filtered("tip", "left", "right"), shown("left", "base"), shown("right", "base"), c("base")];
    expect(pruneFilteredEdges(commits)).toEqual(commits);
  });

  it("keeps real merge edges even when one parent reaches the other", () => {
    // A full history has no filtered edges; `git log --graph` draws both parents.
    const commits = [c("m", "b", "f"), c("f", "a"), c("b", "a"), c("a")];
    expect(pruneFilteredEdges(commits)).toEqual(commits);
  });
});

describe("straightenLaneChanges", () => {
  it("draws a lane change as one diagonal across the row boundary, keeping the lanes", () => {
    // m merges f into main; f branched from a; b sits in lane 0 while lane 1 passes it.
    const rows = straightenLaneChanges(computeGraph([c("m", "b", "f"), c("f", "a"), c("b", "a"), c("a")]).rows);
    const [m, f, b, a] = rows;
    // m → f: leaves m's node towards lane 1 and reaches f's node in a straight line.
    expect(m!.down[1]).toMatchObject({ from: 0, to: 1, toX: 0.5 });
    expect(f!.up.find((s) => s.from === 1)).toMatchObject({ from: 1, to: 1, fromX: 0.5 });
    // Lane 1 converging into a: the vertical line of b's row meets it halfway.
    expect(a!.up[1]).toMatchObject({ from: 1, to: 0, fromX: 0.5 });
    expect(b!.down.find((s) => s.from === 1)).toMatchObject({ from: 1, to: 1, toX: 0.5 });
    // Straight lines stay where they are.
    expect(m!.down[0]!.toX).toBeUndefined();
    expect(a!.up[0]!.fromX).toBeUndefined();
  });

  it("leaves a lane that another line also ends in, and arrows, as they are", () => {
    const rows = straightenLaneChanges([
      {
        lane: 0,
        color: 0,
        up: [],
        down: [
          { from: 0, to: 1, color: 0 },
          { from: 1, to: 1, color: 1 },
        ],
        width: 2,
      },
      {
        lane: 1,
        color: 1,
        up: [{ from: 1, to: 1, color: 1 }],
        down: [{ from: 1, to: 2, color: 1, arrow: "down" }],
        width: 3,
      },
      { lane: 2, color: 1, up: [{ from: 2, to: 2, color: 1 }], down: [], width: 3 },
    ]);
    expect(rows[0]!.down[0]!.toX).toBeUndefined();
    expect(rows[1]!.up[0]!.fromX).toBeUndefined();
    expect(rows[1]!.down[0]!.toX).toBeUndefined();
    expect(rows[2]!.up[0]!.fromX).toBeUndefined();
  });
});

describe("compactLanes", () => {
  const row = (lane: number, up: [number, number][], down: [number, number][], width = 9): GraphRow => ({
    lane,
    color: 0,
    up: up.map(([from, to]) => ({ from, to, color: 0 })),
    down: down.map(([from, to]) => ({ from, to, color: 0 })),
    width,
  });

  it("packs the lanes of each row side by side, in their order", () => {
    // Lanes 2 and 7 (branch layout leaves the slots between them empty); 7 merges into 2.
    const rows = compactLanes([
      row(
        7,
        [],
        [
          [2, 2],
          [7, 7],
        ],
      ),
      row(
        2,
        [
          [2, 2],
          [7, 2],
        ],
        [[2, 2]],
      ),
      row(2, [[2, 2]], []),
    ]);
    expect(rows.map((r) => r.lane)).toEqual([1, 0, 0]);
    expect(rows.map((r) => r.width)).toEqual([2, 2, 1]);
    expect(rows[0]!.down.map((s) => [s.from, s.to])).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(rows[1]!.up.map((s) => [s.from, s.to])).toEqual([
      [0, 0],
      [1, 0],
    ]);
  });

  it("keeps lines joined across rows when a lane is freed in between", () => {
    const laid = computeGraph([
      { id: "a", parents: ["c"], refs: ["a"] },
      { id: "b", parents: ["c"], refs: ["b"] },
      { id: "x", parents: ["c"], refs: ["x"] },
      { id: "c", parents: [], refs: ["main"] },
    ]).rows;
    const rows = compactLanes(laid);
    for (let r = 0; r + 1 < rows.length; r++) {
      const below = new Set(rows[r]!.down.map((s) => s.to));
      expect(new Set(rows[r + 1]!.up.map((s) => s.from))).toEqual(below);
      expect(Math.max(...below)).toBe(below.size - 1);
    }
  });
});
