/**
 * The dense-array lane layout `computeGraph` used before its lanes were kept sparsely, kept
 * verbatim as the oracle for the differential tests: it scans every slot number per row.
 */
import { emptyGraphState, graphLayout } from "../graph";
import type { GraphCommit, GraphRow, GraphSegment, GraphState, EdgeKind } from "../graph";

interface Lane {
  id: string;
  source?: string;
  kind?: EdgeKind;
  color: number;
  dashed?: true;
}

const firstFree = (lanes: Array<Lane | null>) => {
  const i = lanes.indexOf(null);
  return i < 0 ? lanes.length : i;
};

const seg = (from: number, to: number, color: number, dashed?: boolean): GraphSegment =>
  dashed ? { from, to, color, dashed: true } : { from, to, color };

const laneOf = (id: string, color: number, dashed: boolean): Lane =>
  dashed ? { id, color, dashed: true } : { id, color };

/**
 * Lays out `commits` (continuing from `state`, so pages can be appended).
 * Each lane keeps its position while it lives; freed slots are reused.
 */
export function referenceComputeGraph(
  commits: ReadonlyArray<GraphCommit>,
  state: GraphState = emptyGraphState(),
): { rows: GraphRow[]; state: GraphState } {
  const lanes = [...state.lanes];
  const track = commits.some((c) => c.refs !== undefined);
  const positions = new Map(commits.map((c, i) => [c.id, i]));
  const layout = graphLayout(commits);
  const refAware = commits.some((c) => c.refs?.length);
  const stableColor = (id: string, fallback: number) => {
    if (!refAware) return fallback;
    const index = positions.get(id);
    const owner = index == null ? id : layout.owners[index]!;
    let hash = 2166136261;
    for (const char of owner) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return hash >>> 0;
  };
  const describe = (s: GraphSegment, lane: Lane) =>
    track ? { ...s, edge: `${lane.source ?? ""}\0${lane.id}`, source: lane.source, kind: lane.kind } : s;

  let nextColor = state.nextColor;
  const rows: GraphRow[] = [];

  for (const c of commits) {
    const matching: number[] = [];
    lanes.forEach((l, i) => {
      if (l?.id === c.id) matching.push(i);
    });
    let lane: number;
    let color: number;
    if (matching.length) {
      lane = matching[0]!;
      color = lanes[lane]!.color;
    } else {
      const preferred = refAware ? Math.max(0, layout.layout[positions.get(c.id)!]! - 1) : firstFree(lanes);
      lane = !lanes[preferred] ? preferred : firstFree(lanes);
      color = stableColor(c.id, nextColor++);
    }
    const widthBefore = lanes.length;

    const up: GraphSegment[] = [];
    const upTargets: string[] = [];
    lanes.forEach((l, i) => {
      if (!l) return;
      up.push(describe(seg(i, l.id === c.id ? lane : i, l.color, l.dashed), l));
      upTargets.push(l.id);
    });
    for (const m of matching) lanes[m] = null;
    if (lane >= lanes.length) lanes.length = lane + 1;
    lanes[lane] = null;

    const down: GraphSegment[] = [];
    const downTargets: string[] = [];
    lanes.forEach((l, i) => {
      if (l) {
        down.push(describe(seg(i, i, l.color, l.dashed), l));
        downTargets.push(l.id);
      }
    });

    c.parents.forEach((p, k) => {
      const dashed = !!c.dashed?.[k];
      const kind = c.edgeTypes?.[k] ?? (dashed ? "filtered" : "normal");
      const info = {
        id: p,
        source: c.id,
        kind: !positions.has(p) && kind !== "shallow" ? ("unloaded" as const) : kind,
      };
      if (track && kind === "shallow") {
        down.push({
          ...describe(seg(lane, lane, color, dashed), { ...info, color }),
          kind: kind === "shallow" ? "shallow" : "unloaded",
          arrow: "down",
          targetRow: -1,
        });
        downTargets.push(p);
        return;
      }
      // The first parent continues this lane even if another lane also leads to it
      // (both lines then converge at the parent's node, like `git log --graph`).
      if (k === 0) {
        lanes[lane] = { ...laneOf(p, color, dashed), ...info };
        down.push(describe(seg(lane, lane, color, dashed), { ...info, color }));
        downTargets.push(p);
        return;
      }
      const existing = lanes.findIndex((l) => l?.id === p);
      if (existing >= 0) {
        down.push(
          describe(seg(lane, existing, lanes[existing]!.color, dashed), { ...info, color: lanes[existing]!.color }),
        );
        downTargets.push(p);
        return;
      }
      const slot = firstFree(lanes);
      const col = stableColor(p, nextColor++);
      lanes[slot] = { ...laneOf(p, col, dashed), ...info };
      down.push(describe(seg(lane, slot, col, dashed), { ...info, color: col }));
      downTargets.push(p);
    });

    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    const widthAfter = down.reduce((width, segment) => Math.max(width, segment.to + 1), 0);
    rows.push({
      ...(track ? { id: c.id } : {}),
      lane,
      color,
      up,
      down,
      upTargets,
      downTargets,
      width: Math.max(widthBefore, widthAfter, lane + 1),
    });
  }
  if (track && rows.length) {
    const last = rows.at(-1)!;
    last.down = last.down.map((s) => (s.kind === "unloaded" ? { ...s, arrow: "down", targetRow: -1 } : s));
  }
  return { rows, state: { lanes, nextColor } };
}
