import { describe, expect, it } from "vitest";
import type { Profile, RunConfig } from "@/platform/ipc";
import {
  allocationProfilerSupports,
  colorSlot,
  flameLayout,
  flameStep,
  formatWeight,
  frameLocation,
  matchingFrames,
  profilerSupports,
  callSites,
  formatCalls,
  share,
} from "./model";

// all(10) → main(10, self 2) → [work(6), io(2)]
const profile: Profile = {
  profiler: "t",
  unit: "samples",
  mode: "cpu",
  total: 10,
  frames: [
    { name: "all", file: null, line: null, kind: "code" },
    { name: "main", file: "/p/main.py", line: 4, kind: "code" },
    { name: "work", file: null, line: null, kind: "code" },
    { name: "io", file: null, line: null, kind: "code" },
  ],
  nodes: [
    { frame: 0, total: 10, selfWeight: 0, children: [1] },
    { frame: 1, total: 10, selfWeight: 2, children: [2, 3] },
    { frame: 2, total: 6, selfWeight: 6, children: [] },
    { frame: 3, total: 2, selfWeight: 2, children: [] },
  ],
  methods: [],
  calls: [],
};

function cfg(command: string, args: string[], kind = "shell"): RunConfig {
  return {
    id: "c",
    name: "c",
    kind,
    command,
    args,
    cwd: null,
    env: {},
    detected: true,
    isTest: false,
    debugAdapter: null,
  };
}

describe("profiler model", () => {
  it("knows which configurations can be profiled", () => {
    expect(profilerSupports(cfg("node", ["a.js"]), false)).toBe(true);
    expect(profilerSupports(cfg("java", ["-cp", "x", "A"], "application"), false)).toBe(true);
    expect(profilerSupports(cfg(".venv/bin/python", ["main.py"]), false)).toBe(true);
    expect(profilerSupports(cfg("cargo", ["run"]), false)).toBe(false);
    expect(profilerSupports(cfg("cargo", ["run"]), true)).toBe(true);
    expect(profilerSupports(cfg("./app", [], "native"), true)).toBe(true);
    expect(profilerSupports(cfg("make", []), true)).toBe(false);
  });

  it("offers allocation profiling only for JVM programs", () => {
    expect(allocationProfilerSupports(cfg("java", ["-cp", "x", "A"]))).toBe(true);
    expect(allocationProfilerSupports(cfg("/opt/jdk/bin/java", ["-jar", "a.jar"]))).toBe(true);
    expect(allocationProfilerSupports(cfg("node", ["a.js"]))).toBe(false);
    expect(allocationProfilerSupports(cfg("python", ["main.py"]))).toBe(false);
  });

  it("formats byte weights with the Memory view's rounding", () => {
    expect(formatWeight(0, "bytes")).toBe("0 B");
    expect(formatWeight(1, "bytes")).toBe("1 B");
    expect(formatWeight(1024, "bytes")).toBe("1.0 KB");
    expect(formatWeight(536_870_912, "bytes")).toBe("512.0 MB");
    expect(formatWeight(1_288_490_189, "bytes")).toBe("1.2 GB");
    // The rounded value decides the unit: 1048575 B is "1.0 MB", never "1024.0 KB".
    expect(formatWeight(1_048_575, "bytes")).toBe("1.0 MB");
  });

  it("lays out the flame graph and zooms into a node", () => {
    const { rects, depth } = flameLayout(profile);
    expect(depth).toBe(3);
    const at = (node: number) => rects.find((r) => r.node === node)!;
    expect(at(0)).toEqual({ node: 0, depth: 0, x: 0, width: 1 });
    expect(at(2)).toMatchObject({ depth: 2, x: 0, width: 0.6 });
    expect(at(3)).toMatchObject({ depth: 2, x: 0.6, width: 0.2 });

    const zoomed = flameLayout(profile, 2);
    expect(zoomed.rects.map((r) => [r.node, r.depth, r.width])).toEqual([
      [0, 0, 1],
      [1, 1, 1],
      [2, 2, 1],
    ]);
    // Too narrow frames are dropped.
    expect(flameLayout(profile, 0, 0.3).rects.some((r) => r.node === 3)).toBe(false);
  });

  it("searches, formats and locates frames", () => {
    expect(matchingFrames(profile, "  ")).toBeNull();
    expect([...matchingFrames(profile, "WO")!]).toEqual([2]);
    expect(formatWeight(1, "samples")).toBe("1 sample");
    expect(formatWeight(12.34, "ms")).toBe("12.3 ms");
    expect(formatWeight(12_340, "ms")).toBe("12.3 s");
    expect(formatWeight(3, "samples")).toBe("3 samples");
    expect(share(6, 10)).toBe("60%");
    expect(share(0.5, 10)).toBe("5.0%");
    expect(frameLocation(profile, 1)).toBe("main.py:5");
    expect(frameLocation(profile, 2)).toBeNull();
    expect(colorSlot("main")).toBe(colorSlot("main"));
    expect(colorSlot("main")).toBeGreaterThanOrEqual(1);
  });
});

describe("flameStep", () => {
  // root (0) → a (1, 60%) and b (2, 40%); a → c (3)
  const rects = [
    { node: 0, depth: 0, x: 0, width: 1 },
    { node: 1, depth: 1, x: 0, width: 0.6 },
    { node: 2, depth: 1, x: 0.6, width: 0.4 },
    { node: 3, depth: 2, x: 0, width: 0.5 },
  ];
  it("goes to the widest callee, the caller and the neighbours on a row", () => {
    expect(flameStep(rects, 0, "deeper")).toBe(1);
    expect(flameStep(rects, 1, "next")).toBe(2);
    expect(flameStep(rects, 2, "next")).toBe(2);
    expect(flameStep(rects, 2, "previous")).toBe(1);
    expect(flameStep(rects, 2, "deeper")).toBe(2);
    expect(flameStep(rects, 3, "shallower")).toBe(1);
    expect(flameStep(rects, 2, "shallower")).toBe(0);
  });
});

describe("callers and callees", () => {
  const names = (sites: Array<{ frame: number; total: number }>) =>
    sites.map((x) => [recursive.frames[x.frame]!.name, x.total]);
  // all(10) → main(10) → f(8) → f(5) → g(5); main → g(2)
  const recursive: Profile = {
    ...profile,
    frames: [
      ...profile.frames.slice(0, 2),
      { name: "f", file: null, line: null, kind: "code" },
      { name: "g", file: null, line: null, kind: "code" },
    ],
    nodes: [
      { frame: 0, total: 10, selfWeight: 0, children: [1] },
      { frame: 1, total: 10, selfWeight: 0, children: [2, 5] },
      { frame: 2, total: 8, selfWeight: 3, children: [3] },
      { frame: 2, total: 5, selfWeight: 0, children: [4] },
      { frame: 3, total: 5, selfWeight: 5, children: [] },
      { frame: 3, total: 2, selfWeight: 2, children: [] },
    ],
  };

  it("come from the call tree, a recursive function counted at its outermost call", () => {
    const f = callSites(recursive, 2);
    expect(names(f.callers)).toEqual([["main", 8]]);
    expect(names(f.callees)).toEqual([["f", 5]]);
    expect(f.callers[0]!.calls).toBeNull();
    const g = callSites(recursive, 3);
    expect(names(g.callers)).toEqual([
      ["f", 5],
      ["main", 2],
    ]);
    expect(callSites(recursive, 1).callers).toEqual([]);
  });

  it("are the recorded edges of a call-graph profile", () => {
    const graph: Profile = {
      ...recursive,
      calls: [
        { caller: 1, callee: 2, selfWeight: 1, total: 4, calls: 1, primitiveCalls: 1 },
        { caller: 2, callee: 2, selfWeight: 3, total: 4, calls: 99, primitiveCalls: 0 },
        { caller: 2, callee: 3, selfWeight: 6, total: 6, calls: 7, primitiveCalls: 7 },
      ],
    };
    const f = callSites(graph, 2);
    expect(f.callers.map((x) => [x.frame, x.calls])).toEqual([
      [1, 1],
      [2, 99],
    ]);
    expect(f.callees.map((x) => [x.frame, x.total, x.calls])).toEqual([
      [3, 6, 7],
      [2, 4, 99],
    ]);
  });

  it("show recursive call counts as total/primitive", () => {
    expect(formatCalls(8361, 1)).toBe("8,361/1");
    expect(formatCalls(3, 3)).toBe("3");
    expect(formatCalls(3, null)).toBe("3");
  });
});
