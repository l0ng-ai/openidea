/**
 * "Update Snapshot" for Jest and Vitest: recognizes snapshot mismatches in a test's
 * failure output and reruns just those tests with `-u` (Jest `--updateSnapshot`,
 * Vitest `--update`), through the run configuration's own test-name filter.
 */
import type { RunConfig } from "@/platform/ipc";
import { frameworkFor } from "./index";
import { testsConfigs } from "./rerun";
import type { TestNode } from "./results";
import { matchesTarget, type StateQuery } from "./states";

/** Jest (and Bun): `expect(received).toMatchSnapshot()`, `….toThrowErrorMatchingInlineSnapshot()`… */
const JEST_SNAPSHOT_RE = /^\s*expect\(.*\)\.(?:toMatch(?:Inline)?Snapshot|toThrowErrorMatching(?:Inline)?Snapshot)\(/;
/** Vitest: ``Error: Snapshot `cart > total 1` mismatched`` (file, inline and file snapshots alike). */
const VITEST_SNAPSHOT_RE = /^\s*(?:\w*Error: )?Snapshot `.*` mismatched\s*$/;

export function isSnapshotFailure(node: TestNode): boolean {
  return (
    node.children.length === 0 &&
    node.own === "failed" &&
    node.output.some((line) => JEST_SNAPSHOT_RE.test(line) || VITEST_SNAPSHOT_RE.test(line))
  );
}

/** The snapshot-mismatch tests under the given nodes, once each. */
export function snapshotFailures(nodes: readonly TestNode[]): TestNode[] {
  const out = new Map<string, TestNode>();
  const visit = (n: TestNode) => {
    if (isSnapshotFailure(n)) out.set(n.id, n);
    n.children.forEach(visit);
  };
  nodes.forEach(visit);
  return [...out.values()];
}

/** The snapshot mismatches of the results matching a gutter target (a test, or a suite's tests). */
export function snapshotFailuresMatching(roots: readonly TestNode[], query: StateQuery): TestNode[] {
  const matched: TestNode[] = [];
  const visit = (n: TestNode) => (matchesTarget(n.path, query) ? matched.push(n) : n.children.forEach(visit));
  roots.forEach(visit);
  return snapshotFailures(matched);
}

/** Configurations rerunning only `paths` with `-u` (the short flag both runners share); empty when unsupported. */
export function updateSnapshotConfigs(config: RunConfig, paths: string[][]): RunConfig[] {
  if (config.params?.framework === "plugin" || frameworkFor(config) !== "js") return [];
  const name = `Update Snapshots: ${config.name.replace(/^(?:Failed|Update Snapshots): /, "")}`;
  const configs = testsConfigs(config, paths, name);
  return Array.isArray(configs) ? configs.map((c) => ({ ...c, args: [...c.args, "-u"] })) : [];
}
