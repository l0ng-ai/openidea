import type { Commit } from "@/bindings";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../graph", async (original) => {
  const real = await original<typeof import("../graph")>();
  return { ...real, computeGraph: vi.fn(real.computeGraph) };
});

import { computeGraph, type GraphCommit } from "../graph";
import { presentLogGraph, type GraphOptions } from "../logPresentation";
import { commitKey, graphCommit } from "../multiRoot";
import { referenceComputeGraph } from "./graphReference";

const { computeGraph: real } = await vi.importActual<typeof import("../graph")>("../graph");

const id = (i: number) => `c${i.toString(16).padStart(6, "0")}`;

/**
 * A deterministic history in log order (children before parents): up to eight branches
 * that fork, merge (some with a filtered edge) and carry refs, cut off at `count` commits so
 * that the oldest ones lead to parents that are not loaded.
 */
function history(count: number, withRefs: boolean): Commit[] {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const total = count + 40;
  const tips: number[] = [0];
  const parents: number[][] = [[]];
  const dashed = new Map<number, boolean[]>();
  for (let i = 1; i < total; i++) {
    const r = rnd();
    const h = Math.floor(rnd() * tips.length);
    if (r < 0.06 && tips.length < 8) {
      parents.push([tips[h]!]);
      tips.push(i);
    } else if (r < 0.14 && tips.length > 1) {
      const other = (h + 1) % tips.length;
      parents.push([tips[h]!, tips[other]!]);
      if (rnd() < 0.3) dashed.set(i, [false, true]);
      tips[h] = i;
      tips.splice(other, 1);
    } else {
      parents.push([tips[h]!]);
      tips[h] = i;
    }
  }
  const commits: Commit[] = [];
  for (let i = total - 1; i >= 40; i--) {
    const refs: string[] = [];
    if (withRefs) {
      if (i === total - 1) refs.push("HEAD", "main");
      else if (i % 211 === 0) refs.push(`tag: v${i}`);
      else if (i % 97 === 0) refs.push(`feature-${i}`);
      else if (i % 151 === 0) refs.push(`origin/topic-${i}`);
    }
    commits.push({
      id: id(i),
      shortId: id(i),
      parents: parents[i]!.map(id),
      ...(dashed.has(i) ? { dashed: dashed.get(i)! } : {}),
      author: "A",
      email: "a@x.org",
      summary: id(i),
      message: id(i),
      timeMs: i,
      refs,
      remoteNames: refs.filter((r) => r.startsWith("origin/")),
    } as Commit);
  }
  return commits;
}

const noFragments = () => ({ expanded: new Set<string>(), collapsed: new Set<string>(), merges: new Set<string>() });

function fragmentVariants(commits: readonly Commit[]) {
  const linear = commits.filter((c) => c.parents.length === 1 && !c.refs.length).map((c) => c.id);
  const merges = commits.filter((c) => c.parents.length === 2).map((c) => c.id);
  const every = (ids: string[], n: number) => new Set(ids.filter((_, i) => i % n === 0));
  return {
    none: noFragments(),
    collapsed: { ...noFragments(), collapsed: every(linear, 7) },
    expandedLinear: { ...noFragments(), expanded: every(linear, 5), merges: every(merges, 3) },
    someMerges: { ...noFragments(), merges: every(merges, 2) },
    allMerges: { ...noFragments(), merges: new Set(["*"]) },
  };
}

afterEach(() => vi.mocked(computeGraph).mockImplementation(real));

describe("computeGraph lane slots", () => {
  const pages = (commits: readonly Commit[], size: number) => {
    const source = commits.map(graphCommit);
    return Array.from({ length: Math.ceil(source.length / size) }, (_, i) => source.slice(i * size, (i + 1) * size));
  };

  it.each([true, false])("lays out page by page exactly like the dense lane array (refs: %s)", (withRefs) => {
    let state = { lanes: [] as ReturnType<typeof computeGraph>["state"]["lanes"], nextColor: 0 };
    let expected = state;
    // Pages are laid out on their own, so the loaded part of the log is each page itself.
    for (const page of pages(history(2400, withRefs), 300)) {
      const got = real(page, state);
      const want = referenceComputeGraph(page, expected);
      expect(got.rows).toEqual(want.rows);
      expect(got.state).toEqual(want.state);
      expect(got.state.lanes.length).toBe(want.state.lanes.length);
      state = got.state;
      expected = want.state;
    }
  });

  it("continues from a state with vacated, occupied and never-used slots", () => {
    const lanes: Array<{ id: string; color: number } | null> = [];
    lanes[1] = { id: "b", color: 3 };
    lanes[4] = null;
    lanes[6] = { id: "d", color: 5 };
    const commits: GraphCommit[] = [
      { id: "a", parents: ["b", "e"] },
      { id: "e", parents: ["d"] },
      { id: "b", parents: ["d"] },
      { id: "d", parents: [] },
    ];
    const got = real(commits, { lanes: [...lanes], nextColor: 9 });
    const want = referenceComputeGraph(commits, { lanes: [...lanes], nextColor: 9 });
    expect(got).toEqual(want);
  });

  it("scans a number of lane slots per row that does not depend on the highest slot number", () => {
    const chain = (rows: number): GraphCommit[] =>
      Array.from({ length: rows }, (_, i) => ({
        id: `n${i}`,
        parents: [i + 1 < rows ? `n${i + 1}` : "base"],
        refs: i === 0 ? ["main"] : [],
      }));
    /** Array elements the scans of one `computeGraph` call go over, with a lane at slot 30 000. */
    const scanned = (rows: number) => {
      const lanes: Array<{ id: string; color: number } | null> = [];
      lanes[30_000] = { id: "base", color: 1 };
      const names = ["forEach", "indexOf", "findIndex", "filter", "some", "map", "reduce", "includes"] as const;
      const original = new Map(names.map((n) => [n, Array.prototype[n]]));
      let visited = 0;
      for (const n of names)
        Object.defineProperty(Array.prototype, n, {
          configurable: true,
          writable: true,
          value(this: unknown[], ...args: unknown[]) {
            visited += this.length;
            return (original.get(n) as (...a: unknown[]) => unknown).apply(this, args);
          },
        });
      try {
        real(chain(rows), { lanes, nextColor: 0 });
      } finally {
        for (const n of names)
          Object.defineProperty(Array.prototype, n, { configurable: true, writable: true, value: original.get(n) });
      }
      return visited;
    };
    // Reading the given state costs once per call; each further row may only scan its live lanes.
    expect((scanned(400) - scanned(100)) / 300).toBeLessThan(100);
  });
});

describe("presentLogGraph", () => {
  const optionCombinations: GraphOptions[] = [false, true].flatMap((collapseLinear) =>
    [false, true].flatMap((linearizeMerges) =>
      [false, true].map((longEdges) => ({ collapseLinear, linearizeMerges, longEdges })),
    ),
  );

  it.each([true, false])("keeps every option and fragment combination unchanged (refs: %s)", (withRefs) => {
    const commits = history(2400, withRefs);
    const head = new Set([commitKey(commits[0]!)]);
    const variants = fragmentVariants(commits);
    for (const options of optionCombinations)
      for (const [name, fragments] of Object.entries(variants)) {
        vi.mocked(computeGraph).mockImplementation(real);
        const got = presentLogGraph(commits, options, fragments, head);
        vi.mocked(computeGraph).mockImplementation(referenceComputeGraph);
        const want = presentLogGraph(commits, options, fragments, head);
        expect(got, `${JSON.stringify(options)} ${name}`).toEqual(want);
      }
  });
});
