/** Profiles as the views need them: supported configurations, flame graph layout, search, formatting. */
import type { Profile, RunConfig } from "@/platform/ipc";

function programName(command: string): string {
  const name = command.split(/[/\\]/).pop() ?? command;
  return name.replace(/\.(exe|cmd|bat)$/i, "");
}

/** Whether async-profiler's allocation and live-object modes apply: JVM programs only. */
export function allocationProfilerSupports(config: Pick<RunConfig, "command">): boolean {
  return programName(config.command) === "java";
}

/**
 * Whether a profiler is known for `config` (cheap; the backend decides for real):
 * Node.js programs and npm scripts, Python, JVM applications, and on Linux native
 * programs and `cargo run`.
 */
export function profilerSupports(config: Pick<RunConfig, "command" | "args" | "kind">, linux = isLinux()): boolean {
  const program = programName(config.command);
  if (["node", "npx", "tsx", "ts-node", "npm", "pnpm", "yarn", "java"].includes(program)) return true;
  if (program === "cargo") return linux && config.args.find((a) => !a.startsWith("+")) === "run";
  if (config.kind === "native") return linux;
  return (
    config.kind === "python" ||
    config.kind === "pytest" ||
    /^(python[\d.]*|py|pytest|py\.test)$/.test(program) ||
    ((program === "uv" || program === "poetry") && config.args[0] === "run")
  );
}

function isLinux(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /linux/i.test(navigator.platform || navigator.userAgent) &&
    !/android/i.test(navigator.userAgent)
  );
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

/** `0 B`, `1.0 KB`, `512.0 MB`: the Memory view's sizes (it lives in another feature, which this one must not import). */
function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  // Compare the rounded value so 1048575 B becomes "1.0 MB", not "1024.0 KB".
  while (Math.abs(Number(value.toFixed(1))) >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

/** `12.3 ms`, `1.2 s`, `340 samples`, `1.2 GB`. */
export function formatWeight(value: number, unit: string): string {
  if (unit === "bytes") return formatBytes(value);
  if (unit === "ms") {
    if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 1 : 2)} s`;
    return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ms`;
  }
  const n = Math.round(value);
  return `${n} ${n === 1 ? "sample" : "samples"}`;
}

export function share(value: number, total: number): string {
  if (total <= 0) return "0%";
  const p = (value / total) * 100;
  return p >= 10 ? `${Math.round(p)}%` : `${p.toFixed(1)}%`;
}

/** One rectangle of the flame graph, in fractions of the zoomed width. */
export interface FlameRect {
  node: number;
  depth: number;
  /** 0..1 of the visible width. */
  x: number;
  width: number;
}

/**
 * Flame graph rectangles (root at depth 0, callees above their callers in rows
 * below) for the subtree under `focus`, dropping those narrower than `minWidth`.
 * The focused node's ancestors are shown full width above it, as in IDEA.
 */
export function flameLayout(profile: Profile, focus = 0, minWidth = 0.002): { rects: FlameRect[]; depth: number } {
  const nodes = profile.nodes;
  const rects: FlameRect[] = [];
  const parents = parentIndex(profile);
  const ancestors: number[] = [];
  for (let p = parents[focus]; p !== undefined && p >= 0; p = parents[p]) ancestors.unshift(p);
  ancestors.forEach((a, depth) => rects.push({ node: a, depth, x: 0, width: 1 }));
  const base = ancestors.length;
  const total = nodes[focus]?.total ?? 0;
  if (total <= 0) return { rects, depth: base };
  let maxDepth = base;
  const stack: Array<{ node: number; depth: number; x: number }> = [{ node: focus, depth: base, x: 0 }];
  while (stack.length) {
    const { node, depth, x } = stack.pop()!;
    const n = nodes[node]!;
    const width = (n.total ?? 0) / total;
    if (width < minWidth) continue;
    rects.push({ node, depth, x, width });
    maxDepth = Math.max(maxDepth, depth);
    let cx = x;
    for (const c of n.children) {
      stack.push({ node: c, depth: depth + 1, x: cx });
      cx += (nodes[c]!.total ?? 0) / total;
    }
  }
  return { rects, depth: maxDepth + 1 };
}

/**
 * Keyboard moves in the flame graph from the frame `node`: `deeper` to its widest callee,
 * `shallower` to its caller, `previous` / `next` to the neighbouring frame on its row.
 */
export function flameStep(
  rects: readonly FlameRect[],
  node: number,
  move: "deeper" | "shallower" | "previous" | "next",
): number {
  const at = rects.find((r) => r.node === node);
  if (!at) return rects[0]?.node ?? node;
  switch (move) {
    case "deeper": {
      const inside = rects.filter((r) => r.depth === at.depth + 1 && r.x >= at.x && r.x < at.x + at.width);
      return inside.reduce<FlameRect | undefined>((a, r) => (!a || r.width > a.width ? r : a), undefined)?.node ?? node;
    }
    case "shallower":
      // A callee starts inside its caller's span.
      return rects.find((r) => r.depth === at.depth - 1 && r.x <= at.x && at.x < r.x + r.width)?.node ?? node;
    case "previous":
    case "next": {
      const row = rects.filter((r) => r.depth === at.depth).sort((a, b) => a.x - b.x);
      const i = row.indexOf(at) + (move === "next" ? 1 : -1);
      return row[i]?.node ?? node;
    }
  }
}

const parentCache = new WeakMap<Profile, Int32Array>();

/** Parent node of every node (-1 for the root). */
export function parentIndex(profile: Profile): Int32Array {
  let parents = parentCache.get(profile);
  if (parents) return parents;
  parents = new Int32Array(profile.nodes.length).fill(-1);
  profile.nodes.forEach((n, i) => n.children.forEach((c) => (parents![c] = i)));
  parentCache.set(profile, parents);
  return parents;
}

/** Frames whose name contains `query` (case-insensitive), or null when not searching. */
export function matchingFrames(profile: Profile, query: string): Set<number> | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const out = new Set<number>();
  profile.frames.forEach((f, i) => {
    if (f.name.toLowerCase().includes(q)) out.add(i);
  });
  return out;
}

/** Short file location of a frame: `index.js:12`. */
export function frameLocation(profile: Profile, frame: number): string | null {
  const f = profile.frames[frame];
  if (!f?.file) return null;
  const name = f.file.split(/[/\\]/).pop() ?? f.file;
  return f.line !== null ? `${name}:${f.line + 1}` : name;
}

/** Colour slot (1–4) of a frame name, stable across renders. */
export function colorSlot(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return (Math.abs(h) % 4) + 1;
}

// A plain literal: the profiler view translates it with `tx`, and the catalog test only counts literals.
const ESTIMATED_TREE =
  "cProfile records callers and callees, not whole stacks: the flame graph and call tree are estimated from them. The method list is exact.";

/** The notice of a call-graph profile (cProfile): its call edges are exact, its call tree an estimate. */
export function treeNotice(profile: Profile): string | null {
  return profile.calls.length ? ESTIMATED_TREE : null;
}

/** A caller or callee of a function, with what the calls between the two took. */
export interface CallSite {
  frame: number;
  total: number;
  /** Known for call-graph profiles (cProfile) only. */
  calls: number | null;
  primitiveCalls: number | null;
}

/**
 * Callers and callees of `frame`, heaviest first: the exact edges of a call-graph profile,
 * else summed from the call tree, counting a recursive function at its outermost call only.
 */
export function callSites(profile: Profile, frame: number): { callers: CallSite[]; callees: CallSite[] } {
  const byTotal = (a: CallSite, b: CallSite) => b.total - a.total;
  if (profile.calls.length) {
    const site = (other: number, e: (typeof profile.calls)[number]): CallSite => ({
      frame: other,
      total: e.total ?? 0,
      calls: e.calls ?? 0,
      primitiveCalls: e.primitiveCalls ?? 0,
    });
    return {
      callers: profile.calls
        .filter((e) => e.callee === frame)
        .map((e) => site(e.caller, e))
        .sort(byTotal),
      callees: profile.calls
        .filter((e) => e.caller === frame)
        .map((e) => site(e.callee, e))
        .sort(byTotal),
    };
  }
  const nodes = profile.nodes;
  const callers = new Map<number, number>();
  const callees = new Map<number, number>();
  const add = (m: Map<number, number>, f: number, w: number) => m.set(f, (m.get(f) ?? 0) + w);
  // How many calls of `frame` are above the node being visited.
  let above = 0;
  const stack: Array<{ node: number; parent: number; exit: boolean }> = [{ node: 0, parent: -1, exit: false }];
  while (stack.length) {
    const { node, parent, exit } = stack.pop()!;
    const n = nodes[node]!;
    if (exit) {
      if (n.frame === frame) above--;
      continue;
    }
    if (n.frame === frame && above === 0 && parent > 0) add(callers, nodes[parent]!.frame, n.total ?? 0);
    if (parent >= 0 && nodes[parent]!.frame === frame && above === 1) add(callees, n.frame, n.total ?? 0);
    if (n.frame === frame) above++;
    stack.push({ node, parent, exit: true });
    for (const c of n.children) stack.push({ node: c, parent: node, exit: false });
  }
  const sites = (m: Map<number, number>) =>
    [...m].map(([f, total]): CallSite => ({ frame: f, total, calls: null, primitiveCalls: null })).sort(byTotal);
  return { callers: sites(callers), callees: sites(callees) };
}

/** `12` or, when some calls were recursive, `12/1` (total/primitive), as `pstats` prints it. */
export function formatCalls(calls: number, primitive: number | null): string {
  const n = (v: number) => Math.round(v).toLocaleString("en-US");
  return primitive !== null && primitive !== calls ? `${n(calls)}/${n(primitive)}` : n(calls);
}
