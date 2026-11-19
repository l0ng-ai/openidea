/**
 * Backend performance gate: runs the criterion benches of the crates on the
 * interactive path and checks their means (µs) against `budgets.json` › rust
 * and the local baseline.
 *
 *   pnpm perf:rust                       run benches, then check
 *   pnpm perf:rust -- --no-run           inspect recorded results (no execution)
 *   pnpm perf:rust -- --package ide-text --save-baseline
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runRust } from "./lib/rustRun.ts";

const ROOT = resolve(import.meta.dirname, "..");

const { values: args } = parseArgs({
  options: {
    package: { type: "string", multiple: true },
    "no-run": { type: "boolean", default: false },
    "save-baseline": { type: "boolean", default: false },
    "fail-on-regression": { type: "boolean", default: false },
  },
});

process.exitCode = await runRust({
  root: ROOT,
  packages: args.package,
  noRun: args["no-run"],
  saveBaseline: args["save-baseline"],
  failOnRegression: args["fail-on-regression"],
});
