/**
 * Commit graph lanes for the Git log (computed client-side from parents, for
 * commits in topological order, children before parents), plus the graph
 * transformations of the log's Graph / View options.
 */

export interface GraphSegment {
  /** Lane at the segment's start (top edge for `up`, node level for `down`). */
  from: number;
  /** Lane at the segment's end (node level for `up`, bottom edge for `down`). */
  to: number;
  color: number;
  /** Stands for collapsed commits (Collapse Linear Branches). */
  dashed?: true;
  /** A long edge continues out of sight in this direction (Show Long Edges off). */
  arrow?: "up" | "down";
}

export interface GraphRow {
  /** Lane of the commit's node. */
  lane: number;
  color: number;
  /** Top half of the row: lines entering from the previous row. */
  up: GraphSegment[];
  /** Bottom half: lines leaving towards the next row. */
  down: GraphSegment[];
  /** Number of lane slots this row spans. */
  width: number;
}

interface Lane {
  id: string;
  color: number;
  dashed?: true;
}

export interface GraphState {
  lanes: Array<Lane | null>;
  nextColor: number;
}

export interface GraphCommit {
  id: string;
  parents: readonly string[];
  /** Per parent: the link skips collapsed commits. */
  dashed?: readonly boolean[];
}

export const emptyGraphState = (): GraphState => ({ lanes: [], nextColor: 0 });

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
export function computeGraph(
  commits: ReadonlyArray<GraphCommit>,
  state: GraphState = emptyGraphState(),
): { rows: GraphRow[]; state: GraphState } {
  const lanes = [...state.lanes];
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
      lane = firstFree(lanes);
      color = nextColor++;
    }
    const widthBefore = lanes.length;

    const up: GraphSegment[] = [];
    lanes.forEach((l, i) => {
      if (!l) return;
      up.push(seg(i, l.id === c.id ? lane : i, l.color, l.dashed));
    });
    for (const m of matching) lanes[m] = null;
    if (lane >= lanes.length) lanes.length = lane + 1;
    lanes[lane] = null;

    const down: GraphSegment[] = [];
    lanes.forEach((l, i) => {
      if (l) down.push(seg(i, i, l.color, l.dashed));
    });

    c.parents.forEach((p, k) => {
      const dashed = !!c.dashed?.[k];
      // The first parent continues this lane even if another lane also leads to it
      // (both lines then converge at the parent's node, like `git log --graph`).
      if (k === 0) {
        lanes[lane] = laneOf(p, color, dashed);
        down.push(seg(lane, lane, color, dashed));
        return;
      }
      const existing = lanes.findIndex((l) => l?.id === p);
      if (existing >= 0) {
        down.push(seg(lane, existing, lanes[existing]!.color, dashed));
        return;
      }
      const slot = firstFree(lanes);
      const col = nextColor++;
      lanes[slot] = laneOf(p, col, dashed);
      down.push(seg(lane, slot, col, dashed));
    });

    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    const widthAfter = Math.max(0, ...down.map((s) => s.to + 1));
    rows.push({ lane, color, up, down, width: Math.max(widthBefore, widthAfter, lane + 1) });
  }
  return { rows, state: { lanes, nextColor } };
}

/**
 * Collapse Linear Branches: hides the commits of linear chains (one parent, one child,
 * no references) so that only branch points, merges, tips and referenced commits stay,
 * linked by dashed edges. Commits in `keep` (HEAD) stay visible.
 */
export function collapseLinear<
  C extends { id: string; parents: readonly string[]; refs: readonly string[]; dashed?: readonly boolean[] },
>(commits: readonly C[], keep: ReadonlySet<string>): { commits: C[]; graph: GraphCommit[] } {
  const byId = new Map(commits.map((c) => [c.id, c]));
  const children = new Map<string, number>();
  for (const c of commits) for (const p of c.parents) children.set(p, (children.get(p) ?? 0) + 1);
  const hidden = (c: C | undefined): boolean =>
    !!c && c.parents.length === 1 && children.get(c.id) === 1 && !c.refs.length && !keep.has(c.id);

  const visible: C[] = [];
  const graph: GraphCommit[] = [];
  for (const c of commits) {
    if (hidden(c)) continue;
    const dashed: boolean[] = [];
    const parents: string[] = [];
    for (const [i, p] of c.parents.entries()) {
      let cur = p;
      // A filter may already link past hidden commits.
      let skipped = c.dashed?.[i] ?? false;
      for (let next = byId.get(cur), guard = 0; next && guard < commits.length && hidden(next); guard++) {
        cur = next.parents[0]!;
        next = byId.get(cur);
        skipped = true;
      }
      // Two collapsed lines can lead to the same commit: draw one edge.
      const seen = parents.indexOf(cur);
      if (seen >= 0) dashed[seen] = dashed[seen]! || skipped;
      else {
        parents.push(cur);
        dashed.push(skipped);
      }
    }
    visible.push(c);
    graph.push(dashed.some(Boolean) ? { id: c.id, parents, dashed } : { id: c.id, parents });
  }
  return { commits: visible, graph };
}

/** Ids of the loaded commits reachable from `head` (log order: children before parents). */
export function reachableFrom(
  commits: ReadonlyArray<{ id: string; parents: readonly string[] }>,
  head: string | null,
): Set<string> {
  const out = new Set<string>();
  if (!head) return out;
  out.add(head);
  for (const c of commits) if (out.has(c.id)) for (const p of c.parents) out.add(p);
  return out;
}

/** Edges running straight through at least this many rows are long. */
export const LONG_EDGE = 30;
/** Rows of a hidden long edge still drawn next to each of its ends. */
const LONG_EDGE_STUB = 2;

const onLane = (i: number) => (s: GraphSegment) => s.from === i && s.to === i;

const passes = (row: GraphRow, i: number) => row.lane !== i && row.up.some(onLane(i)) && row.down.some(onLane(i));

/**
 * Show Long Edges off: the middle of a straight run of a lane through `minLength` or
 * more rows is not drawn; the visible stubs end in arrows (IDEA's long-edge arrows).
 */
export function hideLongEdges(rows: readonly GraphRow[], minLength = LONG_EDGE): GraphRow[] {
  const out = rows.slice();
  const width = Math.max(0, ...rows.map((r) => r.width));
  const edit = (r: number, fn: (row: GraphRow) => GraphRow) => {
    out[r] = fn(out[r]!);
  };
  for (let i = 0; i < width; i++) {
    const lane = onLane(i);
    let start = -1;
    for (let r = 0; r <= rows.length; r++) {
      if (r < rows.length && passes(rows[r]!, i)) {
        if (start < 0) start = r;
        continue;
      }
      if (start >= 0 && r - start >= minLength) {
        const from = start + LONG_EDGE_STUB;
        const to = r - 1 - LONG_EDGE_STUB;
        for (let k = from; k <= to; k++) {
          edit(k, (row) => ({ ...row, up: row.up.filter((s) => !lane(s)), down: row.down.filter((s) => !lane(s)) }));
        }
        edit(from - 1, (row) => ({ ...row, down: row.down.map((s) => (lane(s) ? { ...s, arrow: "down" } : s)) }));
        edit(to + 1, (row) => ({ ...row, up: row.up.map((s) => (lane(s) ? { ...s, arrow: "up" } : s)) }));
      }
      start = -1;
    }
  }
  return out;
}

/** Lane colours (tokens), cycled by colour index. */
export const LANE_COLORS = [
  "var(--accent)",
  "var(--vcs-added)",
  "var(--vcs-modified)",
  "var(--syn-annotation)",
  "var(--syn-number)",
  "var(--syn-string)",
  "var(--syn-type)",
  "var(--danger)",
];

export const laneColor = (i: number) => LANE_COLORS[i % LANE_COLORS.length]!;
