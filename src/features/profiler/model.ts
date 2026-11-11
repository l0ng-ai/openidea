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
