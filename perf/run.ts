/**
 * UI performance harness: builds the workbench in `--mode perf` (production
 * bundle + sample project + `__openideaPerf` probe), drives interaction scenarios
 * in Chromium and checks the medians against `perf/budgets.json` and the local
 * baseline.
 *
 *   pnpm perf                     all scenarios, 3 measured runs each
 *   pnpm perf -- --only typing,scroll --runs 5
 *   pnpm perf -- --cpu 4          4× CPU slowdown (reported, budgets not enforced)
 *   pnpm perf -- --save-baseline  store this run as target/perf/baseline-<cpu>x.json
 *   pnpm perf -- --only typing --trace   Chrome trace of the last run → target/perf/traces/
 *   pnpm perf -- --only typing --profile --unminified   CPU profile + top functions
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { chromium, type Browser } from "@playwright/test";
import { buildBundle, serveBundle } from "./lib/bundle.ts";
import { Harness, type Metrics, type Scenario } from "./lib/harness.ts";
import { topFunctions, type CpuProfile } from "./lib/profile.ts";
import { installInPage } from "./lib/inpage.ts";
import { evaluate, loadBudgets, printReport, type ScenarioResult } from "./lib/report.ts";
import { median } from "./lib/stats.ts";
import { SCENARIOS } from "./scenarios.ts";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "target", "perf");

const { values: args } = parseArgs({
  options: {
    only: { type: "string" },
    runs: { type: "string", default: "3" },
    warmup: { type: "string", default: "1" },
    cpu: { type: "string", default: "1" },
    channel: { type: "string", default: process.env.OPENIDEA_PERF_CHANNEL ?? "chromium" },
    headed: { type: "boolean", default: false },
    "no-build": { type: "boolean", default: false },
    "save-baseline": { type: "boolean", default: false },
    "fail-on-regression": { type: "boolean", default: false },
    list: { type: "boolean", default: false },
    trace: { type: "boolean", default: false },
    profile: { type: "boolean", default: false },
    unminified: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (args.list) {
  for (const s of SCENARIOS) console.log(`${s.id.padEnd(14)} ${s.title}`);
  process.exit(0);
}

const runs = Math.max(1, Number(args.runs));
const warmup = Math.max(0, Number(args.warmup));
const cpu = Math.max(1, Number(args.cpu));
// Unminified builds keep function names readable in profiles; their bundle size is meaningless.
const DIST = join(OUT, args.unminified ? "dist-unminified" : "dist");
const only = args.only?.split(",").map((s) => s.trim());
const scenarios = only ? SCENARIOS.filter((s) => only.includes(s.id)) : SCENARIOS;
if (only && scenarios.length !== only.length) {
  const known = new Set(SCENARIOS.map((s) => s.id));
  throw new Error(`unknown scenario(s): ${only.filter((o) => !known.has(o)).join(", ")} (see --list)`);
}

function build() {
  buildBundle(ROOT, DIST, args.unminified ? ["--minify", "false"] : []);
}

/** Initial-load JavaScript / CSS from the built index.html (gzip sizes). */
function bundleMetrics(): Metrics {
  const html = readFileSync(join(DIST, "index.html"), "utf8");
  const refs = [...html.matchAll(/(?:src|href)="\/?([^"]+\.(?:js|css))"/g)].map((m) => m[1]!);
  const gz = (f: string) => gzipSync(readFileSync(join(DIST, f))).length / 1024;
  const js = refs.filter((r) => r.endsWith(".js"));
  const css = refs.filter((r) => r.endsWith(".css"));
  return {
    initialJsKb: js.reduce((s, f) => s + gz(f), 0),
    initialCssKb: css.reduce((s, f) => s + gz(f), 0),
  };
}

interface Capture {
  trace?: string;
  profile?: string;
}

async function runOnce(browser: Browser, url: string, scenario: Scenario, capture: Capture = {}): Promise<Metrics> {
  const context = await browser.newContext({
    baseURL: url,
    viewport: { width: 1400, height: 900 },
    deviceScaleFactor: 1,
  });
  try {
    await context.addInitScript(installInPage);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    if (cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
    const h = new Harness(page, cdp);
    if (!scenario.blank) await h.load();
    if (capture.trace) await browser.startTracing(page, { screenshots: true });
    if (capture.profile) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
      await cdp.send("Profiler.start");
    }
    const metrics = await scenario.run(h);
    if (capture.trace) writeFileSync(capture.trace, await browser.stopTracing());
    if (capture.profile) {
      const { profile } = (await cdp.send("Profiler.stop")) as { profile: CpuProfile };
      writeFileSync(capture.profile, JSON.stringify(profile));
      console.log(`
  top self time (${capture.profile}):`);
      for (const f of topFunctions(profile, 25)) {
        console.log(
          `  ${f.selfMs.toFixed(1).padStart(8)} ms ${f.totalMs.toFixed(1).padStart(8)} ms  ${f.name}  ${f.where}`,
        );
      }
    }
    if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`);
    return metrics;
  } finally {
    await context.close();
  }
}

function aggregate(samples: Metrics[]): Metrics {
  const keys = [...new Set(samples.flatMap((s) => Object.keys(s)))];
  return Object.fromEntries(keys.map((k) => [k, median(samples.map((s) => s[k]!).filter(Number.isFinite))]));
}

async function main() {
  mkdirSync(join(OUT, "traces"), { recursive: true });
  mkdirSync(join(OUT, "profiles"), { recursive: true });
  if (!args["no-build"]) build();
  if (!existsSync(join(DIST, "index.html"))) throw new Error(`no build in ${DIST}; run without --no-build`);

  const results: ScenarioResult[] = args.unminified
    ? []
    : [{ id: "bundle", title: "Initial bundle (gzip)", metrics: bundleMetrics() }];
  const { server, url } = await serveBundle(DIST);
  const browser = await chromium
    .launch({
      channel: args.channel === "chromium" ? undefined : args.channel,
      headless: !args.headed,
      // Keep rAF / timers at full rate even when the window is not focused.
      args: [
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
      ],
    })
    .catch((e: Error) => {
      throw new Error(
        `${e.message}\nInstall the browser with \`pnpm exec playwright install chromium\` or pass --channel msedge|chrome.`,
      );
    });
  try {
    for (const s of scenarios) {
      process.stdout.write(`${s.id.padEnd(14)} `);
      const samples: Metrics[] = [];
      try {
        for (let i = 0; i < warmup + runs; i++) {
          const last = i === warmup + runs - 1;
          const m = await runOnce(browser, url, s, {
            trace: args.trace && last ? join(OUT, "traces", `${s.id}.json`) : undefined,
            profile: args.profile && last ? join(OUT, "profiles", `${s.id}.cpuprofile`) : undefined,
          });
          if (i >= warmup) samples.push(m);
          process.stdout.write(i < warmup ? "w" : ".");
        }
        results.push({ id: s.id, title: s.title, metrics: aggregate(samples) });
        console.log();
      } catch (e) {
        console.log(" failed");
        results.push({ id: s.id, title: s.title, metrics: {}, error: e instanceof Error ? e.message : String(e) });
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  const baselineFile = join(OUT, `baseline-${cpu}x.json`);
  const baseline = existsSync(baselineFile)
    ? (JSON.parse(readFileSync(baselineFile, "utf8")) as ScenarioResult[])
    : null;
  const budgets = loadBudgets(join(ROOT, "perf", "budgets.json"));
  const report = evaluate(results, budgets.ui, baseline, {
    enforceBudgets: cpu === 1,
    tolerance: budgets.regressionTolerance,
    floor: budgets.regressionFloor,
  });
  const meta = { date: new Date().toISOString(), cpu, runs, channel: args.channel, browser: browser.version() };
  writeFileSync(join(OUT, "report.json"), JSON.stringify({ meta, ...report }, null, 2));
  writeFileSync(join(OUT, "report.md"), printReport(report, meta));
  if (args["save-baseline"]) {
    writeFileSync(baselineFile, JSON.stringify(results, null, 2));
    console.log(`Baseline saved to ${baselineFile}`);
  }
  const failed = report.failures > 0 || (args["fail-on-regression"] && report.regressions > 0);
  process.exit(failed ? 1 : 0);
}

await main();
