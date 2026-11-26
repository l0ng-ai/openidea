/**
 * "Update Snapshot" for Jest and Vitest: recognizes snapshot mismatches in a test's
 * failure output and reruns just those tests with `-u` (Jest `--updateSnapshot`,
 * Vitest `--update`), through the run configuration's own test-name filter.
 */
import type { RunConfig } from "@/platform/ipc";
import { commandName } from "../commandName";
import { frameworkFor } from "./index";
import { escapeRegExp, testsConfigs } from "./rerun";
import type { TestNode } from "./results";
import { matchesTarget, type StateQuery } from "./states";

/** Jest (and Bun): `expect(received).toMatchSnapshot()`, `….resolves.toMatchSnapshot()`, `….toThrowErrorMatchingInlineSnapshot()`… */
const JEST_SNAPSHOT_RE =
  /^\s*expect\(.*\)(?:\.(?:resolves|rejects))?\.(?:toMatch(?:Inline)?Snapshot|toThrowErrorMatching(?:Inline)?Snapshot)\(/;
/** Vitest: ``Error: Snapshot `cart > total 1` mismatched`` (file, inline and file snapshots alike). */
const VITEST_SNAPSHOT_RE = /^\s*(?:\w*Error: )?Snapshot `.*` mismatched\s*$/;

/** The runner whose snapshot mismatch failed this test, or null for any other failure. */
export function snapshotRunner(node: TestNode): "jest" | "vitest" | null {
  if (node.children.length || node.own !== "failed") return null;
  for (const line of node.output) {
    if (JEST_SNAPSHOT_RE.test(line)) return "jest";
    if (VITEST_SNAPSHOT_RE.test(line)) return "vitest";
  }
  return null;
}

/** The snapshot-mismatch tests under the given nodes, once each. */
export function snapshotFailures(nodes: readonly TestNode[]): TestNode[] {
  const out = new Map<string, TestNode>();
  const visit = (n: TestNode) => {
    if (snapshotRunner(n)) out.set(n.id, n);
    n.children.forEach(visit);
  };
  nodes.forEach(visit);
  return [...out.values()];
}

/** The results that are a gutter target (a test, or a suite with its tests). */
export function targetNodes(roots: readonly TestNode[], query: StateQuery): TestNode[] {
  const matched: TestNode[] = [];
  const visit = (n: TestNode) => (matchesTarget(n.path, query) ? matched.push(n) : n.children.forEach(visit));
  roots.forEach(visit);
  return matched;
}

/** Configurations running only `paths`, launched with {@link snapshotUpdateArgs}; empty when unsupported. */
export function snapshotTestConfigs(config: RunConfig, paths: string[][], name: string): RunConfig[] {
  if (config.params?.framework === "plugin" || frameworkFor(config) !== "js") return [];
  // Always a single run: in watch mode (`watch`, #6102) `-u` would rewrite snapshots on every save.
  const once: RunConfig & { watch?: boolean } = { ...config, watch: undefined };
  const configs = testsConfigs(once, paths, name);
  return Array.isArray(configs) ? configs : [];
}

/**
 * `-u`, the short flag both runners share. Jest's `-u` also deletes every `.snap` file in the
 * project whose test file is gone, whatever the filters, except under ignored test paths:
 * ignoring all but the chosen files keeps them (Bun has no such option).
 */
export function snapshotUpdateArgs(config: RunConfig, paths: string[][], jest: boolean): string[] {
  if (!jest || commandName(config.command) === "bun" || config.kind === "bun") return ["-u"];
  const files = [...new Set(paths.map((p) => p[0]!))].map((file) =>
    file
      .replace(/^\.[\\/]/, "")
      .split(/[\\/]/)
      .map(escapeRegExp)
      .join("[\\\\/]"),
  );
  return ["-u", "--testPathIgnorePatterns", `^(?!.*(?:^|[\\\\/])(?:${files.join("|")})$)`];
}
