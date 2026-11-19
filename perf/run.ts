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
import type { Server } from "node:http";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import type { Browser, BrowserContext } from "@playwright/test";
import { buildBundle, serveBundle } from "./lib/bundle.ts";
import { Harness, type Metrics, type Scenario } from "./lib/harness.ts";
import { topFunctions, type CpuProfile } from "./lib/profile.ts";
import { installInPage } from "./lib/inpage.ts";
import { countOption } from "./lib/options.ts";
import { evaluate, loadBudgets, printReport, type ScenarioResult } from "./lib/report.ts";
import { closeServer, DeadlineError, launchBrowser, withDeadline, type BrowserSession } from "./lib/lifecycle.ts";
import { errorMessage, evidenceJson, metricErrors, summarizeTrials, type Trial } from "./lib/trials.ts";
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

const runs = countOption("runs", args.runs!, 1);
const warmup = countOption("warmup", args.warmup!, 0);
const cpu = Number(args.cpu);
if (!args.cpu?.trim() || !Number.isFinite(cpu) || cpu < 1) {
  throw new Error("--cpu must be a finite number >= 1");
}
// Unminified builds keep function names readable in profiles; their bundle size is meaningless.
const DIST = join(OUT, args.unminified ? "dist-unminified" : "dist");
const only = args.only === undefined ? undefined : [...new Set(args.only.split(",").map((s) => s.trim()))];
const known = new Set(SCENARIOS.map((s) => s.id));
if (known.size !== SCENARIOS.length) throw new Error("duplicate scenario ID");
if (only?.some((id) => !known.has(id))) {
  throw new Error(`unknown scenario(s): ${only.filter((id) => !known.has(id)).join(", ")} (see --list)`);
}
const scenarios = only ? SCENARIOS.filter((s) => only.includes(s.id)) : SCENARIOS;
if (!scenarios.length) throw new Error("empty workload");
const budgets = loadBudgets(join(ROOT, "perf", "budgets.json"));
for (const key of Object.keys(budgets.ui)) {
  const id = key.slice(0, key.indexOf("."));
  if (id !== "bundle" && !known.has(id)) throw new Error(`budget references unknown scenario: ${key}`);
}
const expected = [...(args.unminified ? [] : ["bundle"]), ...scenarios.map((s) => s.id)];

async function build() {
  await buildBundle(ROOT, DIST, args.unminified ? ["--minify", "false"] : []);
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
  let context: BrowserContext | undefined;
  let finished = false;
  const execute = async () => {
    context = await browser.newContext({
      baseURL: url,
      viewport: { width: 1400, height: 900 },
      deviceScaleFactor: 1,
    });
    if (finished) {
      await withDeadline(context.close(), 5000, "late context close");
      throw new Error("trial already ended");
    }
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
  };
  try {
    return await withDeadline(execute(), 5 * 60_000, `${scenario.id} trial`);
  } finally {
    finished = true;
    if (context) await withDeadline(context.close(), 5000, "context close");
  }
}

async function main() {
  mkdirSync(join(OUT, "traces"), { recursive: true });
  mkdirSync(join(OUT, "profiles"), { recursive: true });
  const results: ScenarioResult[] = [];
  const trials: Record<string, Trial[]> = {};
  const counts: Record<string, unknown> = {};
  const infrastructure: string[] = [];
  const baselineFile = join(OUT, `baseline-${cpu}x.json`);
  let baseline: ScenarioResult[] | null = null;
  let runtime: BrowserSession | undefined;
  let server: Server | undefined;
  let browserVersion = "not started";
  let completed = false;
  const meta = { date: new Date().toISOString(), cpu, runs, warmup, channel: args.channel };
  const progress = () => {
    writeFileSync(
      join(OUT, "report.json"),
      evidenceJson({ meta, status: "running", expected, results, trials, counts }),
    );
  };
  progress();
  writeFileSync(join(OUT, "report.md"), "# OpenIDEA performance report\n\nRun in progress; no passing verdict.\n");
  try {
    baseline = existsSync(baselineFile) ? (JSON.parse(readFileSync(baselineFile, "utf8")) as ScenarioResult[]) : null;
    if (!args["no-build"]) await build();
    if (!existsSync(join(DIST, "index.html"))) throw new Error(`no build in ${DIST}; run without --no-build`);
    if (!args.unminified) results.push({ id: "bundle", title: "Initial bundle (gzip)", metrics: bundleMetrics() });
    const serving = await serveBundle(DIST);
    server = serving.server;
    runtime = await launchBrowser({
      channel: args.channel === "chromium" ? undefined : args.channel,
      headless: !args.headed,
      args: [
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
      ],
    });
    browserVersion = runtime.browser.version();
    for (const s of scenarios) {
      process.stdout.write(`${s.id.padEnd(14)} `);
      const attempts: Trial[] = (trials[s.id] = []);
      const required = Object.keys(budgets.ui)
        .filter((key) => key.startsWith(`${s.id}.`))
        .map((key) => key.slice(s.id.length + 1));
      for (let i = 0; i < warmup + runs; i++) {
        const phase = i < warmup ? "warmup" : "measured";
        const index = phase === "warmup" ? i + 1 : i - warmup + 1;
        try {
          const last = i === warmup + runs - 1;
          const metrics = await runOnce(runtime.browser, serving.url, s, {
            trace: args.trace && last ? join(OUT, "traces", `${s.id}.json`) : undefined,
            profile: args.profile && last ? join(OUT, "profiles", `${s.id}.cpuprofile`) : undefined,
          });
          const errors = metricErrors(metrics, required);
          attempts.push({
            phase,
            index,
            status: errors.length ? "invalid" : "ok",
            metrics,
            error: errors.join("; ") || undefined,
          });
          process.stdout.write(errors.length ? "!" : phase === "warmup" ? "w" : ".");
        } catch (error) {
          attempts.push({
            phase,
            index,
            status: error instanceof DeadlineError ? "timeout" : "error",
            metrics: {},
            error: errorMessage(error),
          });
          process.stdout.write(" failed");
          progress();
          break;
        }
        progress();
      }
      const summary = summarizeTrials(attempts, runs);
      counts[s.id] = summary.counts;
      results.push({ id: s.id, title: s.title, metrics: summary.metrics, error: summary.error });
      progress();
      console.log();
    }
    completed = true;
  } catch (error) {
    infrastructure.push(errorMessage(error));
  } finally {
    if (runtime) {
      try {
        await runtime.close();
      } catch (error) {
        infrastructure.push(`browser cleanup: ${errorMessage(error)}`);
      }
    }
    if (server) {
      try {
        await closeServer(server);
      } catch (error) {
        infrastructure.push(`server cleanup: ${errorMessage(error)}`);
      }
    }
  }
  const report = evaluate(results, budgets.ui, baseline, {
    expected,
    enforceBudgets: cpu === 1,
    tolerance: budgets.regressionTolerance,
    floor: budgets.regressionFloor,
  });
  for (const error of infrastructure) report.errors.push({ id: "infrastructure", error });
  report.failures += infrastructure.length;
  const finalMeta = { ...meta, browser: browserVersion };
  writeFileSync(
    join(OUT, "report.json"),
    evidenceJson({
      meta: finalMeta,
      status: report.failures ? "failed" : "complete",
      ...report,
      expected,
      results,
      trials,
      counts,
      infrastructure,
    }),
  );
  const trialTable = [
    "",
    "## Trials",
    "",
    "| Scenario | Valid / planned measured | Attempted measured | Valid / attempted warmup |",
    "| --- | ---: | ---: | ---: |",
    ...Object.entries(trials).map(([id, attempts]) => {
      const c = summarizeTrials(attempts, runs).counts;
      return `| ${id} | ${c.valid}/${c.planned} | ${c.attempted} | ${c.warmupValid}/${c.warmupAttempted} |`;
    }),
  ].join("\n");
  writeFileSync(join(OUT, "report.md"), printReport(report, finalMeta) + trialTable + "\n");
  if (args["save-baseline"] && completed) {
    writeFileSync(baselineFile, evidenceJson(results));
    console.log(`Baseline saved to ${baselineFile}`);
  }
  const failed = report.failures > 0 || (args["fail-on-regression"] && report.regressions > 0);
  process.exit(failed ? 1 : 0);
}

await main();
