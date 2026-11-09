/**
 * Last known result per test, across runs, for the gutter ▶ icons: like IDEA, a
 * test (or suite) that failed last time shows a red run icon, a passed one green.
 * Results are matched to gutter targets by their test path (the trailing name
 * parts), plus the file for frameworks whose results are rooted at the file (or its module).
 */
import { nodeStatus, type TestNode, type TestResults } from "./results";
import type { TestStatus } from "./types";

export type TestState = "passed" | "failed";

interface Entry {
  path: string[];
  state: TestState;
}

const SEP = "\u0000";
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;

export function testStatesVersion(): number {
  return version;
}

export function onTestStatesChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function toState(s: TestStatus | null): TestState | null {
  return s === "passed" || s === "failed" ? s : null;
}

/** Records the outcome of every finished test and suite of a run (newer runs win). */
export function recordTestStates(results: Pick<TestResults, "roots">) {
  let changed = false;
  const visit = (n: TestNode) => {
    const state = toState(nodeStatus(n));
    if (state) {
      const key = n.path.join(SEP);
      if (entries.get(key)?.state !== state) changed = true;
      entries.set(key, { path: n.path, state });
    }
    n.children.forEach(visit);
  };
  results.roots.forEach(visit);
  if (!changed) return;
  version++;
  for (const l of listeners) l();
}

export function clearTestStates() {
  if (!entries.size) return;
  entries.clear();
  version++;
  for (const l of listeners) l();
}

/** `name()`, `name(int)`, `test_x[param]` → `name` / `test_x`. */
const norm = (s: string) => s.replace(/\s*(\(.*\)|\[.*\])$/, "").trim();

function segmentMatches(result: string, target: string): boolean {
  const a = norm(result);
  const b = norm(target);
  // JVM results name the class by its fully qualified name, gutter targets by the simple one.
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

const cleanPath = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

function sameFile(resultRoot: string, relPath: string): boolean {
  const b = cleanPath(relPath);
  // unittest / Django results are rooted at the dotted module (`polls.tests`).
  if (
    /^[\p{L}_][\p{L}\p{N}_]*(\.[\p{L}_][\p{L}\p{N}_]*)*$/u.test(resultRoot) &&
    !resultRoot.endsWith(".py") &&
    b.endsWith(".py")
  ) {
    const module = resultRoot.replace(/\./g, "/");
    return [`${module}.py`, `${module}/__init__.py`].some((f) => b === f || b.endsWith(`/${f}`));
  }
  const a = cleanPath(resultRoot);
  return a === b || b.endsWith(`/${a}`) || a.endsWith(`/${b}`);
}

export interface StateQuery {
  /** Test path of the gutter target (describe chain, module path, `[Class, method]`…). */
  path: string[];
  /** Project-relative path of the file, checked when results are rooted at their file. */
  file?: string;
}

/**
 * Last state of a gutter target: failed when any matching result failed (a
 * parameterised test failed for one of its parameters), else passed.
 */
export function testState({ path, file }: StateQuery): TestState | null {
  if (!path.length) return null;
  let passed = false;
  for (const e of entries.values()) {
    if (e.path.length < path.length) continue;
    const offset = e.path.length - path.length;
    if (!path.every((p, i) => segmentMatches(e.path[offset + i]!, p))) continue;
    if (file !== undefined && (offset === 0 || !sameFile(e.path[0]!, file))) continue;
    if (e.state === "failed") return "failed";
    passed = true;
  }
  return passed ? "passed" : null;
}
