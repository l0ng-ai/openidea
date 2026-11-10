/**
 * Commit graph lanes for the Git log (computed client-side from parents, for
 * commits in topological order, children before parents), plus the graph
 * transformations of the log's Graph / View options.
 */

export type EdgeKind = "normal" | "filtered" | "collapsed" | "shallow" | "unloaded";

export interface GraphSegment {
  edge?: string;
  kind?: EdgeKind;
  source?: string;
  /** Lane at the segment's start (top edge for `up`, node level for `down`). */
  from: number;
  /** Lane at the segment's end (node level for `up`, bottom edge for `down`). */
  to: number;
  color: number;
  /** Stands for collapsed commits (Collapse Linear Branches). */
  dashed?: true;
  /** A long edge continues out of sight in this direction (Show Long Edges off). */
  arrow?: "up" | "down";
  /** Destination row of a long-edge arrow in the displayed graph. */
  targetRow?: number;
  /** Drawn lane positions when they differ from `from` / `to` (see {@link straightenLaneChanges}). */
  fromX?: number;
  toX?: number;
}

export interface GraphRow {
  id?: string;
  /** Lane of the commit's node. */
  lane: number;
  color: number;
  /** Top half of the row: lines entering from the previous row. */
  up: GraphSegment[];
  /** Bottom half: lines leaving towards the next row. */
  down: GraphSegment[];
  /** Number of lane slots this row spans. */
  width: number;
  /** Graph ids corresponding to each half-edge, for fragment actions. */
  upTargets?: string[];
  downTargets?: string[];
}

interface Lane {
  id: string;
  source?: string;
  kind?: EdgeKind;
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
  refs?: readonly string[];
  remoteNames?: readonly string[];
  edgeTypes?: readonly ("normal" | "filtered" | "collapsed" | "shallow" | "unloaded")[];
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

/**
 * Collapse Linear Branches: hides the commits of linear chains (one parent, one child,
 * no references) so that only branch points, merges, tips and referenced commits stay,
 * linked by dashed edges. Commits in `keep` (HEAD) stay visible.
 */
export function collapseLinear<
  C extends {
    id: string;
    parents: readonly string[];
    refs: readonly string[];
    dashed?: readonly boolean[];
    edgeTypes?: readonly EdgeKind[];
  },
>(
  commits: readonly C[],
  keep: ReadonlySet<string>,
  only?: ReadonlySet<string>,
): { commits: C[]; graph: GraphCommit[] } {
  const byId = new Map(commits.map((c) => [c.id, c]));
  const children = new Map<string, number>();
  for (const c of commits) for (const p of c.parents) children.set(p, (children.get(p) ?? 0) + 1);
  const hidden = (c: C | undefined): boolean =>
    !!c &&
    c.parents.length === 1 &&
    children.get(c.id) === 1 &&
    !c.refs.length &&
    !keep.has(c.id) &&
    (!only || only.has(c.id));

  const visible: C[] = [];
  const graph: GraphCommit[] = [];
  for (const c of commits) {
    if (hidden(c)) continue;
    const dashed: boolean[] = [];
    const parents: string[] = [];
    const edgeTypes: EdgeKind[] = [];
    for (const [i, p] of c.parents.entries()) {
      let cur = p;
      let skipped = !!c.dashed?.[i];
      let kind = c.edgeTypes?.[i] ?? (skipped ? "filtered" : "normal");
      for (let next = byId.get(cur), guard = 0; next && guard < commits.length && hidden(next); guard++) {
        cur = next.parents[0]!;
        next = byId.get(cur);
        skipped = true;
        kind = "collapsed";
      }
      // Two collapsed lines can lead to the same commit: draw one edge.
      const seen = parents.indexOf(cur);
      if (seen >= 0) dashed[seen] = dashed[seen]! || skipped;
      else {
        parents.push(cur);
        dashed.push(skipped);
        edgeTypes.push(kind);
      }
    }
    visible.push(c);
    graph.push({ ...c, id: c.id, parents, dashed, edgeTypes });
  }
  return { commits: visible, graph };
}

/** Ids reachable from the given heads (log order: children before parents). */
export function reachableFrom(
  commits: ReadonlyArray<{ id: string; parents: readonly string[] }>,
  heads: Iterable<string>,
): Set<string> {
  const out = new Set(heads);
  if (!out.size) return out;
  for (const c of commits) if (out.has(c.id)) for (const p of c.parents) out.add(p);
  return out;
}

/** Ref-priority DFS layout, shared by Bek fragment recognition and lane colours.
 * Adapted from IntelliJ GraphLayoutBuilder (JetBrains contributors, Apache-2.0). */
export function graphLayout(commits: readonly GraphCommit[]) {
  const positions = new Map(commits.map((c, i) => [c.id, i]));
  const parents = commits.map((c) =>
    c.parents.flatMap((id) => {
      const i = positions.get(id);
      return i == null ? [] : [i];
    }),
  );
  const children = commits.map(() => [] as number[]);
  parents.forEach((ps, i) => ps.forEach((p) => children[p]!.push(i)));
  const refRank = (c: GraphCommit, ref: string) =>
    `${ref === "HEAD" ? 0 : ref === "main" || ref === "master" ? 1 : ref.startsWith("tag: ") ? 4 : c.remoteNames?.includes(ref) ? 3 : 2}${ref}`;
  const priority = (i: number) =>
    commits[i]!.refs?.length ? commits[i]!.refs!.map((r) => refRank(commits[i]!, r)).sort()[0]! : `5${commits[i]!.id}`;
  const heads = commits
    .flatMap((c, i) => (!children[i]!.length || c.refs?.length ? [i] : []))
    .sort((a, b) => priority(a).localeCompare(priority(b)));
  const layout = commits.map(() => 0);
  const owners = commits.map(() => "");
  let next = 1;
  for (const head of heads) {
    if (layout[head]) continue;
    const owner =
      commits[head]!.refs?.filter((r) => r !== "HEAD").sort((a, b) =>
        refRank(commits[head]!, a).localeCompare(refRank(commits[head]!, b)),
      )[0] ?? (commits[head]!.refs?.includes("HEAD") ? "HEAD" : commits[head]!.id);
    const startLayout = next;
    const stack = [head];
    while (stack.length) {
      const node = stack.at(-1)!;
      const first = !layout[node];
      if (first) {
        layout[node] = next;
        owners[node] = `${owner}\0${next - startLayout}`;
      }
      const parent = parents[node]!.find((p) => !layout[p]);
      if (parent != null) stack.push(parent);
      else {
        if (first) next++;
        stack.pop();
      }
    }
  }
  return { layout, owners, parents, children };
}

/** LinearBek fragment recognition and nested expansion.
 * Adapted from JetBrains LinearBekGraphBuilder, Copyright 2000-2025, Apache-2.0. */
export function linearizeMerges(commits: readonly GraphCommit[], expanded: ReadonlySet<string> = new Set()) {
  const positions = new Map(commits.map((c, i) => [c.id, i]));
  const { layout } = graphLayout(commits);
  const expand = new Set(expanded);
  const build = () => {
    const graph = commits.map((c) => ({
      ...c,
      parents: [...c.parents],
      dashed: c.parents.map((_, i) => !!c.dashed?.[i]),
    }));
    const fragments = new Map<string, string>();
    const nodes = new Map<string, Set<string>>();
    for (let merge = graph.length - 1; merge >= 0; merge--) {
      const down = graph[merge]!.parents.flatMap((p) => {
        const i = positions.get(p);
        return i == null ? [] : [i];
      }).sort((a, b) => a - b);
      if (down.length !== 2 || graph[merge]!.parents.length !== 2) continue;
      const [right, left] = down as [number, number];
      const body = new Set<number>(),
        tails = new Set<number>();
      const tailEdges = new Map<number, Set<string>>();
      const queue: Array<{ up: number; down: number | undefined; id: string }> = [];
      const add = (up: number) => graph[up]!.parents.forEach((id) => queue.push({ up, down: positions.get(id), id }));
      const magic = new Set<number>();
      const pending = [...graph[left]!.parents];
      while (pending.length) {
        const id = pending.pop()!,
          i = positions.get(id);
        if (i == null || i > left + LONG_EDGE || magic.has(i)) continue;
        magic.add(i);
        pending.push(...graph[i]!.parents);
      }
      let rows = 1,
        size = 1,
        old = false,
        valid = true;
      const visited = new Set<string>();
      add(right);
      while (queue.length && valid) {
        queue.sort((a, b) => (b.down ?? Infinity) - (a.down ?? Infinity));
        const e = queue.pop()!;
        const key = `${e.up}\0${e.id}`;
        if (visited.has(key)) continue;
        visited.add(key);
        const next = e.down;
        if (next == null) {
          if (!body.has(e.up)) tails.add(e.up);
          continue;
        }
        if (next === left) {
          if (!body.has(e.up)) tails.add(e.up);
          old = true;
        } else if (next >= right + rows && next < left) {
          rows = next - right + 1;
          size++;
          add(next);
          body.add(e.up);
        } else if (next > left) {
          const li = layout[next]!,
            ll = layout[left]!,
            rl = layout[right]!;
          let allowed: boolean;
          if (ll > rl && !old) allowed = next <= left + LONG_EDGE && magic.has(next);
          else if ((li > ll && li < rl) || li === ll) allowed = true;
          else if (li >= rl) allowed = false;
          else allowed = next > left + LONG_EDGE ? tailEdges.has(e.up) || body.has(e.up) : magic.has(next);
          if (!allowed) {
            valid = false;
            break;
          }
          if (!body.has(e.up)) {
            tails.add(e.up);
            tailEdges.set(e.up, new Set([...(tailEdges.get(e.up) ?? []), e.id]));
          }
        }
        if (size >= 200) valid = false;
      }
      if (!valid || !tails.size) continue;
      const id = graph[merge]!.id;
      nodes.set(id, new Set([merge, left, right, ...body, ...tails].map((i) => graph[i]!.id)));
      if (expand.has(id)) continue;
      for (const [up, removed] of tailEdges) {
        const c = graph[up]!;
        c.dashed = c.dashed.filter((_, i) => !removed.has(c.parents[i]!));
        c.parents = c.parents.filter((p) => !removed.has(p));
      }
      for (const tail of tails) {
        const c = graph[tail]!,
          target = graph[left]!.id;
        const index = c.parents.indexOf(target);
        if (index < 0) {
          c.parents.push(target);
          c.dashed.push(true);
        } else c.dashed[index] = true;
        fragments.set(`${c.id}\0${target}`, id);
      }
      const c = graph[merge]!,
        target = graph[left]!.id;
      c.dashed = c.dashed.filter((_, i) => c.parents[i] !== target);
      c.parents = c.parents.filter((p) => p !== target);
    }
    for (const c of graph) {
      const original = commits[positions.get(c.id)!]!;
      c.edgeTypes = c.parents.map((p, i) =>
        fragments.has(`${c.id}\0${p}`)
          ? "collapsed"
          : (original.edgeTypes?.[original.parents.indexOf(p)] ?? (c.dashed[i] ? "filtered" : "normal")),
      );
    }
    return { graph, fragments, nodes };
  };
  let result = build();
  // Expanding a containing merge restores its nested fragments as well.
  for (;;) {
    let changed = false;
    for (const id of [...expand])
      for (const node of result.nodes.get(id) ?? [])
        if (node !== id && result.nodes.has(node) && !expand.has(node)) {
          expand.add(node);
          changed = true;
        }
    if (!changed) return result;
    result = build();
  }
}

const LONG_EDGE = 30;
/** Rows of a hidden long edge still drawn next to each of its ends. */
const LONG_EDGE_STUB = 2;

const onLane = (i: number) => (s: GraphSegment) => s.from === i && s.to === i;

/** Lanes a row's vertical lines pass straight through (other than its node's). */
function passingLanes(row: GraphRow): Set<number> {
  const out = new Set<number>();
  for (const s of row.up)
    if (s.from === s.to && s.from !== row.lane && row.down.some((d) => d.from === s.from && d.to === s.from))
      out.add(s.from);
  return out;
}

/**
 * Show Long Edges off: the middle of a straight run of a lane through `minLength` or
 * more rows is not drawn; the visible stubs end in arrows (IDEA's long-edge arrows).
 */
export function hideLongEdges(rows: readonly GraphRow[], minLength = LONG_EDGE): GraphRow[] {
  const out = rows.slice();
  const edit = (r: number, fn: (row: GraphRow) => GraphRow) => {
    out[r] = fn(out[r]!);
  };
  const hide = (i: number, start: number, end: number) => {
    const lane = onLane(i);
    const from = start + LONG_EDGE_STUB;
    const to = end - 1 - LONG_EDGE_STUB;
    for (let k = from; k <= to; k++) {
      edit(k, (row) => ({
        ...row,
        up: row.up.filter((s) => !lane(s)),
        down: row.down.filter((s) => !lane(s)),
        upTargets: row.upTargets?.filter((_, i) => !lane(row.up[i]!)),
        downTargets: row.downTargets?.filter((_, i) => !lane(row.down[i]!)),
      }));
    }
    edit(from - 1, (row) => ({
      ...row,
      down: row.down.map((s) => (lane(s) ? { ...s, arrow: "down", targetRow: end } : s)),
    }));
    edit(to + 1, (row) => ({
      ...row,
      up: row.up.map((s) => (lane(s) ? { ...s, arrow: "up", targetRow: start - 1 } : s)),
    }));
  };
  // One pass over the rows, following every lane's current run at once.
  const runs = new Map<number, number>();
  for (let r = 0; r <= rows.length; r++) {
    const through = r < rows.length ? passingLanes(rows[r]!) : new Set<number>();
    for (const [lane, start] of runs) {
      if (through.has(lane)) continue;
      if (r - start >= minLength) hide(lane, start, r);
      runs.delete(lane);
    }
    for (const lane of through) if (!runs.has(lane)) runs.set(lane, r);
  }
  return out;
}

/**
 * Packs each row's lanes side by side, in their order: lanes laid out by branch leave
 * gaps (one per branch) and hidden long edges free theirs. Each row boundary and each
 * node level is packed on its own; adjacent rows share the boundary, so lines stay joined.
 */
export function compactLanes(rows: readonly GraphRow[]): GraphRow[] {
  const ranks = (lanes: Iterable<number>) => new Map([...new Set(lanes)].sort((a, b) => a - b).map((l, i) => [l, i]));
  const boundaries = Array.from({ length: rows.length + 1 }, (_, r) =>
    ranks([...(rows[r]?.up.map((s) => s.from) ?? []), ...(rows[r - 1]?.down.map((s) => s.to) ?? [])]),
  );
  return rows.map((row, r) => {
    const node = ranks([row.lane, ...row.up.map((s) => s.to), ...row.down.map((s) => s.from)]);
    const top = boundaries[r]!;
    const bottom = boundaries[r + 1]!;
    return {
      ...row,
      lane: node.get(row.lane)!,
      up: row.up.map((s) => ({ ...s, from: top.get(s.from)!, to: node.get(s.to)! })),
      down: row.down.map((s) => ({ ...s, from: node.get(s.from)!, to: bottom.get(s.to)! })),
      width: Math.max(node.size, top.size, bottom.size),
    };
  });
}

/**
 * Draws a lane change as one straight diagonal across the row boundary, like IDEA: a half-row
 * segment that changes lane and the vertical half of the neighbouring row that continues it meet
 * halfway between the two lanes. Only the drawn positions change; `from` / `to` stay the lanes.
 */
export function straightenLaneChanges(rows: readonly GraphRow[]): GraphRow[] {
  const out = rows.map((r) => ({ ...r, up: [...r.up], down: [...r.down] }));
  const vertical = (s: GraphSegment, lane: number) => s.from === lane && s.to === lane && !s.arrow;
  for (let r = 0; r < out.length; r++) {
    const row = out[r]!;
    // Leaving the node towards another lane: continues straight down in the next row.
    const next = out[r + 1];
    // Another line ending at the same lane (a merge into a lane that continues) keeps its position.
    const shared = (list: readonly GraphSegment[], lane: number, end: "from" | "to") =>
      list.filter((x) => x[end] === lane).length > 1;
    row.down.forEach((s, i) => {
      if (s.from === s.to || s.arrow || !next || shared(row.down, s.to, "to")) return;
      const j = next.up.findIndex((u) => vertical(u, s.to) && u.edge === s.edge && u.fromX === undefined);
      if (j < 0) return;
      const mid = (s.from + s.to) / 2;
      row.down[i] = { ...s, toX: mid };
      next.up[j] = { ...next.up[j]!, fromX: mid };
    });
    // Converging into the node from another lane: continues a vertical line of the previous row.
    const prev = out[r - 1];
    row.up.forEach((s, i) => {
      if (s.from === s.to || s.arrow || !prev || shared(prev.down, s.from, "to")) return;
      const j = prev.down.findIndex((d) => vertical(d, s.from) && d.edge === s.edge && d.toX === undefined);
      if (j < 0) return;
      const mid = (s.from + s.to) / 2;
      row.up[i] = { ...s, fromX: mid };
      prev.down[j] = { ...prev.down[j]!, toX: mid };
    });
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
