import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

// Package-owned expectations, independent of collected artifacts and human-owned budgets.
export const RUST_BENCHMARKS: Readonly<Record<string, readonly string[]>> = {
  "ide-text": [
    "text/open_1mb",
    "text/apply_keystroke_1mb",
    "text/apply_100_changes_1mb",
    "text/diff_two_edits_1mb",
    "text/diff_every_line_1mb",
    "text/offset_to_pos_round_trip",
    "text/pos_to_byte",
    "text/text_for_save_crlf_1mb",
    "text/diff_one_edit_5mb",
  ],
  "ide-lsp": ["lsp/did_change_incremental_1mb"],
  "ide-language": [
    "syntax_2mb/outline_uncached",
    "syntax_2mb/folding_uncached",
    "syntax_2mb/outline_cached_hit",
    "syntax_2mb/folding_cached_hit",
    "syntax_2mb/selection_cached_hit",
    "syntax_2mb/folding_after_keystroke_incremental",
    "syntax_2mb/outline_after_keystroke_incremental",
  ],
  "ide-index": [
    "index_100k/find_files/ordcon",
    "index_100k/find_files/src/user",
    "index_100k/find_files/PaymentService",
    "index_100k/find_files/zzzz",
    "index_100k/find_files/a",
    "index_100k/find_dirs/util",
    "index_100k/find_dirs/src/ui",
    "index_100k/find_dirs/a",
    "index_100k/find_symbols/OCo",
    "index_100k/find_symbols/invoiceRepo",
    "index_100k/find_symbols/renderView",
    "index_100k/find_symbols/q",
    "index_100k/find_symbols_types/UsSe",
    "startup_20k/reopen_wait_idle",
  ],
  "ide-search": [
    "search_5k/literal",
    "search_5k/regex",
    "search_5k/dense_limit",
    "search_dense_files/24x40k_limit",
    "search_excluded_subtrees/5k_dependencies",
  ],
  "ide-host": ["plugins/load_50", "plugins/cold_activation", "plugins/syntax_highlights_2k_lines"],
  "ide-heap": ["heap/index_1m_objects", "heap/dominators_1m_random"],
};

const OBSERVE_ONLY: Readonly<Record<string, true>> = {
  "syntax_2mb/outline_uncached": true,
  "syntax_2mb/folding_uncached": true,
  "lsp/did_change_incremental_1mb": true,
  "index_100k/find_files/zzzz": true,
  "index_100k/find_symbols/renderView": true,
  "startup_20k/reopen_wait_idle": true,
  "search_excluded_subtrees/5k_dependencies": true,
};

export function selectRustPackages(packages: readonly string[] = Object.keys(RUST_BENCHMARKS)): string[] {
  if (packages.length === 0) throw new Error("empty Rust package selection");
  for (const p of packages) {
    if (!Object.hasOwn(RUST_BENCHMARKS, p)) throw new Error(`unknown Rust package: ${JSON.stringify(p)}`);
  }
  return [...new Set(packages)];
}

export function rustPaths(root: string, env: { CARGO_TARGET_DIR?: string; CRITERION_HOME?: string }) {
  const target = resolve(root, env.CARGO_TARGET_DIR ?? "target");
  return { target, criterion: resolve(root, env.CRITERION_HOME ?? join(target, "criterion")) };
}

export function rustBudgets(packages: readonly string[], budgets: Record<string, number>): Record<string, number> {
  const selected = selectRustPackages(packages);
  const ids = new Set(Object.values(RUST_BENCHMARKS).flat());
  for (const id of Object.keys(OBSERVE_ONLY)) {
    if (!ids.has(id)) throw new Error(`unknown Rust observe-only classification: ${id}`);
  }
  for (const [id, value] of Object.entries(budgets)) {
    if (!ids.has(id)) throw new Error(`unknown Rust budget ID: ${id}`);
    if (Object.hasOwn(OBSERVE_ONLY, id)) throw new Error(`Rust observe-only ID has an absolute budget: ${id}`);
    if (!Number.isFinite(value) || value < 0) throw new Error(`invalid Rust budget: ${id}`);
  }
  for (const id of ids) {
    if (!Object.hasOwn(budgets, id) && !Object.hasOwn(OBSERVE_ONLY, id)) {
      throw new Error(`missing Rust budget classification: ${id}`);
    }
  }
  return Object.fromEntries(
    selected
      .flatMap((p) => RUST_BENCHMARKS[p]!)
      .filter((id) => !Object.hasOwn(OBSERVE_ONLY, id))
      .map((id) => [`rust.${id}`, budgets[id]!]),
  );
}

export interface RustArtifacts {
  metrics: Record<string, number>;
  artifacts: Array<{ path: string; modifiedAt: string }>;
  errors: string[];
}

/** Keep valid partial results and file dates even when another selected artifact is invalid. */
export function inspectRustArtifacts(
  dir: string,
  packages: readonly string[],
  started?: number,
  now = Date.now(),
): RustArtifacts {
  const selected = new Set(selectRustPackages(packages));
  const expected = new Set([...selected].flatMap((p) => RUST_BENCHMARKS[p]!));
  const owners = new Map<string, string>();
  const groups = new Map<string, string>();
  for (const [p, ids] of Object.entries(RUST_BENCHMARKS)) {
    for (const id of ids) {
      owners.set(id, p);
      groups.set(id.split("/")[0]!, p);
    }
  }
  const metrics: Record<string, number> = {};
  const artifacts: RustArtifacts["artifacts"] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  function readNew(sub: string) {
    // Criterion sanitizes slashes in ungrouped function names to underscores.
    const top = relative(dir, sub).split(sep)[0]!;
    const pathOwner = [...groups].find(([group]) => top === group || top.startsWith(`${group}_`))?.[1];
    if (pathOwner && !selected.has(pathOwner)) return;
    const bench = join(sub, "new", "benchmark.json");
    const estimates = join(sub, "new", "estimates.json");
    if (!existsSync(bench)) {
      if (existsSync(estimates) && (!pathOwner || selected.has(pathOwner))) {
        throw new Error(`missing Criterion benchmark.json: ${sub}`);
      }
      return;
    }
    const metadata: unknown = JSON.parse(readFileSync(bench, "utf8"));
    const id = metadata && typeof metadata === "object" && "full_id" in metadata ? metadata.full_id : undefined;
    if (typeof id !== "string" || !id) {
      throw new Error(`invalid Criterion full_id: ${bench}`);
    }
    const owner = owners.get(id) ?? groups.get(id.split("/")[0]!);
    if (owner && !selected.has(owner)) return;
    if (!expected.has(id)) throw new Error(`unknown selected Criterion ID: ${id}`);
    if (seen.has(id)) throw new Error(`duplicate Criterion ID: ${id}`);
    seen.add(id);
    for (const file of [bench, estimates]) {
      const modified = statSync(file).mtimeMs;
      artifacts.push({ path: relative(dir, file), modifiedAt: new Date(modified).toISOString() });
      // Allow filesystem timestamp rounding, not future-dated benchmark results.
      if (modified > now + 1000) throw new Error(`future Criterion artifact: ${file}`);
      if (started !== undefined && modified < started) throw new Error(`stale Criterion artifact: ${file}`);
    }
    const est: unknown = JSON.parse(readFileSync(estimates, "utf8"));
    const mean = est && typeof est === "object" && "mean" in est ? est.mean : undefined;
    const value = mean && typeof mean === "object" && "point_estimate" in mean ? mean.point_estimate : undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`invalid Criterion mean estimate: ${estimates}`);
    }
    metrics[id] = value / 1000;
  }
  function visit(path: string) {
    try {
      if (!existsSync(path)) return;
      try {
        readNew(path);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.isDirectory() && !["new", "base", "report"].includes(entry.name)) visit(join(path, entry.name));
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  visit(dir);
  const missing = [...expected].filter((id) => !Object.hasOwn(metrics, id));
  if (missing.length) errors.push(`missing selected Criterion IDs: ${missing.join(", ")}`);
  return { metrics, artifacts, errors };
}

/** Strict convenience interface for consumers that require the complete selected workload. */
export function collectRustMetrics(dir: string, packages: readonly string[], started?: number): Record<string, number> {
  const result = inspectRustArtifacts(dir, packages, started);
  if (result.errors.length) throw new Error(result.errors.join("\n"));
  return result.metrics;
}
