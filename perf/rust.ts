/**
 * Backend performance gate: runs the criterion benches of the crates on the
 * interactive path and checks their means (µs) against `budgets.json` › rust
 * and the local baseline.
 *
 *   pnpm perf:rust                       run benches, then check
 *   pnpm perf:rust -- --no-run           check the latest criterion results only
 *   pnpm perf:rust -- --package ide-text --save-baseline
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { evaluate, loadBudgets, printReport, type ScenarioResult } from "./lib/report.ts";
import { collectRustMetrics, rustBudgets, rustPaths, selectRustPackages } from "./lib/rust.ts";

const ROOT = resolve(import.meta.dirname, "..");
const { target: TARGET, criterion: CRITERION } = rustPaths(ROOT, process.env);
const OUT = join(ROOT, "target", "perf");

const { values: args } = parseArgs({
  options: {
    package: { type: "string", multiple: true },
    "no-run": { type: "boolean", default: false },
    "save-baseline": { type: "boolean", default: false },
    "fail-on-regression": { type: "boolean", default: false },
  },
});

const packages = selectRustPackages(args.package);
const budgets = loadBudgets(join(ROOT, "perf", "budgets.json"));
const selectedBudgets = rustBudgets(packages, budgets.rust);
const started = Date.now();
if (!args["no-run"]) {
  const r = spawnSync("cargo", ["bench", ...packages.flatMap((p) => ["-p", p]), "--benches"], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, CARGO_TARGET_DIR: TARGET, CRITERION_HOME: CRITERION },
  });
  if (r.status !== 0) throw new Error("cargo bench failed");
}

const metrics = collectRustMetrics(CRITERION, packages, args["no-run"] ? undefined : started);

mkdirSync(OUT, { recursive: true });
const results: ScenarioResult[] = [{ id: "rust", title: "criterion means (µs)", metrics }];
const baselineFile = join(OUT, "baseline-rust.json");
const baseline = existsSync(baselineFile) ? (JSON.parse(readFileSync(baselineFile, "utf8")) as ScenarioResult[]) : null;
const report = evaluate(results, selectedBudgets, baseline, {
  expected: ["rust"],
  enforceBudgets: true,
  tolerance: budgets.regressionTolerance,
  floor: budgets.regressionFloor,
});
const meta = { date: new Date().toISOString(), unit: "µs (mean)", packages: packages.join(" ") };
writeFileSync(join(OUT, "report-rust.json"), JSON.stringify({ meta, ...report }, null, 2));
writeFileSync(join(OUT, "report-rust.md"), printReport(report, meta));
if (args["save-baseline"]) {
  writeFileSync(baselineFile, JSON.stringify(results, null, 2));
  console.log(`Baseline saved to ${baselineFile}`);
}
process.exit(report.failures > 0 || (args["fail-on-regression"] && report.regressions > 0) ? 1 : 0);
