/** Folds parser events into a results tree with aggregated statuses and counts. */
import type { TestEvent, TestLocation, TestStatus } from "./types";

export interface TestNode {
  id: string;
  name: string;
  path: string[];
  children: TestNode[];
  /** Own status (leaf result, or a suite-level hint such as jest's `FAIL file`). */
  own: TestStatus | null;
  durationMs?: number;
  location?: TestLocation;
  /** Output captured for this node: its console output and failure details. */
  output: string[];
}

/** A node's output followed by its descendants' in tree order: a group shows the output of its tests. */
export function nodeOutput(node: TestNode): string[] {
  return [...node.output, ...node.children.flatMap(nodeOutput)];
}

export interface TestCounts {
  passed: number;
  failed: number;
  skipped: number;
  running: number;
  total: number;
}

const SEP = "\u0000";
const MAX_OUTPUT_LINES = 400;

export function nodeStatus(node: TestNode): TestStatus | null {
  if (node.children.length === 0) return node.own;
  let any = false;
  let running = false;
  let failed = false;
  let passed = false;
  for (const c of node.children) {
    const s = nodeStatus(c);
    if (!s) continue;
    any = true;
    if (s === "failed") failed = true;
    else if (s === "running") running = true;
    else if (s === "passed") passed = true;
  }
  if (failed || node.own === "failed") return "failed";
  if (running) return "running";
  if (!any) return node.own;
  return passed ? "passed" : "skipped";
}

export class TestResults {
  readonly roots: TestNode[] = [];
  private readonly byId = new Map<string, TestNode>();
  summary: { passed?: number; failed?: number; skipped?: number; durationMs?: number } = {};
  /** Bumped on every change (for memoised views). */
  version = 0;
  finished = false;

  node(path: string[]): TestNode {
    const id = path.join(SEP);
    let node = this.byId.get(id);
    if (node) return node;
    node = { id, name: path[path.length - 1] ?? "", path, children: [], own: null, output: [] };
    this.byId.set(id, node);
    if (path.length === 1) this.roots.push(node);
    else this.node(path.slice(0, -1)).children.push(node);
    return node;
  }

  get(id: string): TestNode | undefined {
    return this.byId.get(id);
  }

  /** The test at `path` has finished with a result. */
  hasResult(path: readonly string[]): boolean {
    const own = this.byId.get(path.join(SEP))?.own;
    return !!own && own !== "running";
  }

  /** Finds a test by a suffix of its path (pytest failure headers name `Class.test`). */
  findBySuffix(suffix: string[]): TestNode | undefined {
    let best: TestNode | undefined;
    for (const n of this.byId.values()) {
      if (n.path.length < suffix.length) continue;
      const tail = n.path.slice(n.path.length - suffix.length);
      if (tail.every((p, i) => p === suffix[i])) {
        if (!best || n.children.length < best.children.length) best = n;
      }
    }
    return best;
  }

  /** Moves the subtree at `from` to `into`, merging it with what is already there. */
  move(from: string[], into: string[]) {
    const source = this.byId.get(from.join(SEP));
    if (!source || from.join(SEP) === into.join(SEP)) return;
    this.version++;
    const parent = from.length > 1 ? this.byId.get(from.slice(0, -1).join(SEP))?.children : this.roots;
    parent?.splice(parent.indexOf(source), 1);
    this.mergeInto(source, into);
  }

  private mergeInto(source: TestNode, into: string[]) {
    this.byId.delete(source.id);
    const target = this.node(into);
    if (source.own && (!target.own || source.own === "failed")) target.own = source.own;
    target.durationMs ??= source.durationMs;
    target.location ??= source.location;
    if (target.output.length === 0) target.output = source.output;
    for (const child of source.children) this.mergeInto(child, [...into, child.name]);
  }

  apply(events: readonly TestEvent[]) {
    if (events.length === 0) return;
    this.version++;
    for (const e of events) {
      switch (e.type) {
        case "start": {
          if (e.path.length === 0) break;
          const n = this.node(e.path);
          if (!n.own) n.own = "running";
          break;
        }
        case "result": {
          if (e.path.length === 0) break;
          const n = this.node(e.path);
          // A failure is sticky (jest reports `FAIL file` before its passing tests).
          if (n.own !== "failed" || e.status === "failed") n.own = e.status;
          if (e.durationMs !== undefined) n.durationMs = e.durationMs;
          break;
        }
        case "location": {
          const n = this.node(e.path);
          // The first location wins, except that a place to search for (Ruby tests) gives way to a real one.
          if (!n.location || (n.location.resolve === "rubyTest" && e.location.resolve !== "rubyTest"))
            n.location = e.location;
          break;
        }
        case "output": {
          const n = this.node(e.path);
          if (n.output.length < MAX_OUTPUT_LINES) n.output.push(e.line);
          break;
        }
        case "summary":
          this.summary = { ...this.summary, ...stripUndefined(e) };
          break;
      }
    }
  }

  /** Marks still-running tests as finished (skipped) when the process ends. */
  finish(exitCode: number | null) {
    this.finished = true;
    this.version++;
    for (const n of this.byId.values()) {
      if (n.own === "running") n.own = n.children.length > 0 ? null : exitCode === 0 ? "passed" : "skipped";
    }
  }

  counts(): TestCounts {
    const c: TestCounts = { passed: 0, failed: 0, skipped: 0, running: 0, total: 0 };
    const visit = (n: TestNode) => {
      if (n.children.length > 0) {
        n.children.forEach(visit);
        return;
      }
      const s = n.own;
      if (!s) return;
      c.total++;
      c[s]++;
    };
    this.roots.forEach(visit);
    // Summary lines are authoritative when the per-test output was terse.
    const { passed, failed, skipped } = this.summary;
    if (passed !== undefined && passed > c.passed) c.passed = passed;
    if (failed !== undefined && failed > c.failed) c.failed = failed;
    if (skipped !== undefined && skipped > c.skipped) c.skipped = skipped;
    c.total = Math.max(c.total, c.passed + c.failed + c.skipped + c.running);
    return c;
  }

  /** First failed leaf in tree order. */
  firstFailure(): TestNode | undefined {
    const visit = (nodes: TestNode[]): TestNode | undefined => {
      for (const n of nodes) {
        if (nodeStatus(n) !== "failed") continue;
        if (n.children.length === 0) return n;
        const hit = visit(n.children);
        if (hit) return hit;
        return n;
      }
      return undefined;
    };
    return visit(this.roots);
  }

  get isEmpty() {
    return this.roots.length === 0;
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined && k !== "type") (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
