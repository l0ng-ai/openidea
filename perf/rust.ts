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
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { evaluate, loadBudgets, printReport, type ScenarioResult } from "./lib/report.ts";

const ROOT = resolve(import.meta.dirname, "..");
const TARGET = resolve(ROOT, process.env.CARGO_TARGET_DIR ?? "target");
const OUT = join(ROOT, "target", "perf");
const PACKAGES = ["ide-text", "ide-language", "ide-index", "ide-search", "ide-host", "ide-heap"];

const { values: args } = parseArgs({
  options: {
    package: { type: "string", multiple: true },
    "no-run": { type: "boolean", default: false },
    "save-baseline": { type: "boolean", default: false },
    "fail-on-regression": { type: "boolean", default: false },
  },
});

const packages = args.package ?? PACKAGES;
const started = Date.now();
if (!args["no-run"]) {
  const r = spawnSync("cargo", ["bench", ...packages.flatMap((p) => ["-p", p]), "--benches"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (r.status !== 0) throw new Error("cargo bench failed");
}

/** Criterion results (`<id>/new/{benchmark,estimates}.json`) → mean in µs. */
function collect(dir: string, out: Record<string, number>) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "report") continue;
    const sub = join(dir, entry.name);
    const bench = join(sub, "new", "benchmark.json");
    if (existsSync(bench) && (args["no-run"] || statSync(bench).mtimeMs >= started)) {
      const { full_id } = JSON.parse(readFileSync(bench, "utf8")) as { full_id: string };
      const est = JSON.parse(readFileSync(join(sub, "new", "estimates.json"), "utf8")) as {
        mean: { point_estimate: number };
      };
      out[full_id] = est.mean.point_estimate / 1000;
    }
    collect(sub, out);
  }
}

const metrics: Record<string, number> = {};
collect(join(TARGET, "criterion"), metrics);
if (Object.keys(metrics).length === 0) throw new Error(`no criterion results under ${join(TARGET, "criterion")}`);

mkdirSync(OUT, { recursive: true });
const budgets = loadBudgets(join(ROOT, "perf", "budgets.json"));
const results: ScenarioResult[] = [{ id: "rust", title: "criterion means (µs)", metrics }];
const baselineFile = join(OUT, "baseline-rust.json");
const baseline = existsSync(baselineFile) ? (JSON.parse(readFileSync(baselineFile, "utf8")) as ScenarioResult[]) : null;
// Only budgets of benches that ran: `--package` may select a subset.
const rustBudgets = Object.fromEntries(
  Object.entries(budgets.rust)
    .filter(([id]) => args["no-run"] || id in metrics || !args.package)
    .map(([id, v]) => [`rust.${id}`, v]),
);
const report = evaluate(results, rustBudgets, baseline, {
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
