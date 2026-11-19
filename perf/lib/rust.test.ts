import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectRustMetrics,
  inspectRustArtifacts,
  RUST_BENCHMARKS,
  rustBudgets,
  rustPaths,
  selectRustPackages,
} from "./rust.ts";
import { runRust } from "./rustRun.ts";

const TEXT_BENCHMARKS = RUST_BENCHMARKS["ide-text"]!.length;

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rust-validity-"));
  roots.push(root);
  return root;
}
function artifact(root: string, id: string, value: unknown = 1000, directory = id) {
  const dir = join(root, directory, "new");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "benchmark.json"), JSON.stringify({ full_id: id }));
  writeFileSync(join(dir, "estimates.json"), JSON.stringify({ mean: { point_estimate: value } }));
  return dir;
}
function complete(root: string, packages: readonly string[]) {
  for (const p of packages) for (const id of RUST_BENCHMARKS[p]!) artifact(root, id);
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Rust workload contract", () => {
  it("owns 41 unique IDs and exactly seven observe-only metrics", () => {
    const ids = Object.values(RUST_BENCHMARKS).flat();
    expect(ids).toHaveLength(41);
    expect(new Set(ids).size).toBe(41);
    const budgets = JSON.parse(readFileSync(resolve(import.meta.dirname, "../budgets.json"), "utf8")).rust;
    const selected = rustBudgets(selectRustPackages(), budgets);
    expect(Object.keys(selected)).toHaveLength(34);
    expect(ids.filter((id) => !(id in budgets))).toEqual([
      "lsp/did_change_incremental_1mb",
      "syntax_2mb/outline_uncached",
      "syntax_2mb/folding_uncached",
      "index_100k/find_files/zzzz",
      "index_100k/find_symbols/renderView",
      "startup_20k/reopen_wait_idle",
      "search_excluded_subtrees/5k_dependencies",
    ]);
    expect(Object.keys(rustBudgets(["ide-text"], budgets))).toHaveLength(9);
    const missing = { ...budgets };
    delete missing["text/open_1mb"];
    expect(() => rustBudgets(["ide-text"], missing)).toThrow(/classification/);
    expect(() => rustBudgets(["ide-text"], { ...budgets, "text/new": 1 })).toThrow(/unknown/);
    expect(() => rustBudgets(["ide-text"], { ...budgets, "syntax_2mb/outline_uncached": 1 })).toThrow(/observe-only/);
  });

  it("rejects unknown or empty packages and deduplicates before cargo", () => {
    expect(() => selectRustPackages([])).toThrow(/empty/);
    expect(() => selectRustPackages([""])).toThrow(/unknown/);
    expect(() => selectRustPackages(["not-a-crate"])).toThrow(/unknown/);
    expect(selectRustPackages(["ide-text", "ide-text"])).toEqual(["ide-text"]);
  });

  it("reports unknown packages without invoking cargo", async () => {
    const root = fixture();
    const marker = join(root, "cargo-invoked");
    writeFileSync(join(root, "cargo"), `#!/bin/sh\n: > '${marker}'\nexit 99\n`, { mode: 0o755 });
    const code = await runRust({
      root,
      packages: ["not-a-crate"],
      env: { ...process.env, PATH: root },
    });
    expect(code).toBe(1);
    const report = JSON.parse(readFileSync(join(root, "target/perf/report-rust.json"), "utf8"));
    expect(report.errors[0].error).toMatch(/unknown Rust package/);
    expect(existsSync(marker)).toBe(false);
  });

  it("resolves target and Criterion overrides relative to cargo's cwd", () => {
    expect(rustPaths("/work", {})).toEqual({ target: "/work/target", criterion: "/work/target/criterion" });
    expect(rustPaths("/work", { CARGO_TARGET_DIR: "private" })).toEqual({
      target: "/work/private",
      criterion: "/work/private/criterion",
    });
    expect(rustPaths("/work", { CARGO_TARGET_DIR: "/private", CRITERION_HOME: "results" })).toEqual({
      target: "/private",
      criterion: "/work/results",
    });
  });

  it("accepts a complete full workload and converts nanoseconds to microseconds", () => {
    const root = fixture();
    complete(root, selectRustPackages());
    expect(Object.keys(collectRustMetrics(root, selectRustPackages()))).toHaveLength(41);
    expect(collectRustMetrics(root, ["ide-text"])["text/open_1mb"]).toBe(1);
  });

  it("requires selected IDs independently of budgets, including observe-only IDs", () => {
    const root = fixture();
    expect(() => collectRustMetrics(root, ["ide-text"])).toThrow(/missing/);
    complete(root, ["ide-language"]);
    rmSync(join(root, "syntax_2mb/outline_uncached"), { recursive: true });
    expect(() => collectRustMetrics(root, ["ide-language"])).toThrow(/outline_uncached/);
    expect(() => collectRustMetrics(root, selectRustPackages())).toThrow(/missing/);
  });

  it.each([
    ["ide-language", "syntax_2mb/outline_uncached"],
    ["ide-language", "syntax_2mb/folding_uncached"],
    ["ide-lsp", "lsp/did_change_incremental_1mb"],
    ["ide-index", "index_100k/find_files/zzzz"],
    ["ide-index", "index_100k/find_symbols/renderView"],
    ["ide-index", "startup_20k/reopen_wait_idle"],
    ["ide-search", "search_excluded_subtrees/5k_dependencies"],
  ])("requires observe-only metric %s / %s", (p, id) => {
    const root = fixture();
    complete(root, [p]);
    rmSync(join(root, id), { recursive: true });
    expect(() => collectRustMetrics(root, [p])).toThrow(/missing selected/);
  });

  it("ignores known unselected artifacts, including their malformed estimates", () => {
    const root = fixture();
    complete(root, ["ide-text"]);
    artifact(root, "heap/index_1m_objects", "bad");
    const unrelated = artifact(root, "heap/dominators_1m_random");
    writeFileSync(join(unrelated, "benchmark.json"), "{");
    expect(Object.keys(collectRustMetrics(root, ["ide-text"]))).toHaveLength(TEXT_BENCHMARKS);
  });

  it("rejects duplicate IDs and unknown selected IDs even with complete expected results", () => {
    const root = fixture();
    complete(root, ["ide-text"]);
    artifact(root, "text/open_1mb", 1000, "duplicate");
    expect(() => collectRustMetrics(root, ["ide-text"])).toThrow(/duplicate/);
    rmSync(join(root, "duplicate"), { recursive: true });
    artifact(root, "text/renamed");
    expect(() => collectRustMetrics(root, ["ide-text"])).toThrow(/unknown/);
  });

  it.each([null, "1000", -1, {}])("rejects invalid means: %j", (value) => {
    const root = fixture();
    complete(root, ["ide-text"]);
    artifact(root, "text/open_1mb", value);
    expect(() => collectRustMetrics(root, ["ide-text"])).toThrow(/estimate/);
  });

  it("accepts zero and rejects malformed metadata, absent estimates, and invalid JSON", () => {
    const root = fixture();
    complete(root, ["ide-text"]);
    const dir = artifact(root, "text/open_1mb", 0);
    expect(collectRustMetrics(root, ["ide-text"])["text/open_1mb"]).toBe(0);
    writeFileSync(join(dir, "benchmark.json"), "{}");
    expect(() => collectRustMetrics(root, ["ide-text"])).toThrow(/full_id/);
    artifact(root, "text/open_1mb");
    rmSync(join(dir, "estimates.json"));
    expect(() => collectRustMetrics(root, ["ide-text"])).toThrow();
    writeFileSync(join(dir, "estimates.json"), "{");
    expect(() => collectRustMetrics(root, ["ide-text"])).toThrow();
    writeFileSync(join(dir, "estimates.json"), "{}");
    expect(() => collectRustMetrics(root, ["ide-text"])).toThrow(/estimate/);
  });

  it.each(["benchmark.json", "estimates.json"])("requires fresh %s for a newly run workload", (file) => {
    const root = fixture();
    complete(root, ["ide-text"]);
    const dir = artifact(root, "text/open_1mb");
    utimesSync(join(dir, file), new Date(0), new Date(0));
    expect(() => collectRustMetrics(root, ["ide-text"], 1)).toThrow(/stale/);
    expect(Object.keys(collectRustMetrics(root, ["ide-text"]))).toHaveLength(TEXT_BENCHMARKS);
  });
  it("rejects overflowing JSON numeric estimates, including observe-only metrics", () => {
    const root = fixture();
    complete(root, ["ide-language"]);
    const dir = artifact(root, "syntax_2mb/outline_uncached");
    writeFileSync(join(dir, "estimates.json"), '{"mean":{"point_estimate":1e309}}');
    expect(() => collectRustMetrics(root, ["ide-language"])).toThrow(/estimate/);
  });

  it.each(["benchmark.json", "estimates.json"])("rejects future %s even in inspection mode", (file) => {
    const root = fixture();
    complete(root, ["ide-text"]);
    const date = new Date(Date.now() + 60_000);
    utimesSync(join(root, "text/open_1mb/new", file), date, date);
    expect(() => collectRustMetrics(root, ["ide-text"])).toThrow(/future Criterion artifact/);
  });

  it("retains partial valid metrics and dated artifacts after malformed selected output", () => {
    const root = fixture();
    complete(root, ["ide-text"]);
    writeFileSync(join(root, "text/open_1mb/new/estimates.json"), "{");
    const result = inspectRustArtifacts(root, ["ide-text"]);
    expect(Object.keys(result.metrics)).toHaveLength(TEXT_BENCHMARKS - 1);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.artifacts).toContainEqual(expect.objectContaining({ path: "text/open_1mb/new/benchmark.json" }));
  });
});
