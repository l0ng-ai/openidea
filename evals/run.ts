/**
 * Code-intelligence evals (`pnpm eval`): the production workbench in Chromium driving a
 * release `openidea-server` with real language servers, each scenario timed as the user
 * sees it (feedback, first result, complete) and checked against its golden results.
 *
 *   pnpm eval                              every scenario (warm: 1 warm-up + median of 3; cold: once)
 *   pnpm eval --only java.usages --runs 5  scenarios whose id starts with java.usages
 *   pnpm eval --save-baseline              store this run as target/eval/baseline.json
 *   pnpm eval --update-golden              re-record evals/<language>/golden/ (review the diff)
 *   pnpm eval --only <id> --trace          Chrome trace of the slowest run → target/eval/traces/
 *
 * Writes target/eval/report.json (verdicts, failures with diagnostics, machine fingerprint)
 * and target/eval/report.md. Timings go over the remote-development route (one stdio hop
 * more than Tauri IPC): compare them before / after on one machine, not as absolute numbers.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Browser } from "@playwright/test";
import { buildBundle, serveBundle } from "../perf/lib/bundle.ts";
import { runCommand } from "../perf/lib/process.ts";
import { closeServer, DeadlineError, launchBrowser, withDeadline, type BrowserSession } from "../perf/lib/lifecycle.ts";
import {
  errorMessage,
  evidenceJson,
  metricErrors,
  summarizeMetrics,
  summarizeTrials,
  type Trial,
} from "../perf/lib/trials.ts";
import { JAVA_SCENARIOS } from "./java/scenarios.ts";
import { compare, readGolden, toolDrift, writeGolden, type ResultSet } from "./lib/golden.ts";
import { TimeoutError } from "./lib/measure.ts";
import { fingerprint, pinnedTools, sameMachine, toolVersions, type Fingerprint } from "./lib/machine.ts";
import type { EvalScenario } from "./lib/scenario.ts";
import { planSelection } from "./lib/selection.ts";
import { Session } from "./lib/session.ts";
import { idOf, judge, loadBudgets, table, type Condition, type Diagnostics, type Outcome } from "./lib/verdict.ts";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "target", "eval");
const DIST = join(OUT, "dist");
const SCENARIOS: EvalScenario[] = [...JAVA_SCENARIOS];

const { values: args } = parseArgs({
  options: {
    only: { type: "string" },
    condition: { type: "string" },
    runs: { type: "string", default: "3" },
    warmup: { type: "string", default: "1" },
    channel: { type: "string", default: process.env.OPENIDEA_PERF_CHANNEL ?? "chromium" },
    headed: { type: "boolean", default: false },
    "no-build": { type: "boolean", default: false },
    "save-baseline": { type: "boolean", default: false },
    "update-golden": { type: "boolean", default: false },
    "fail-on-regression": { type: "boolean", default: false },
    trace: { type: "boolean", default: false },
    list: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (args.list) {
  for (const s of SCENARIOS) console.log(`${s.id.padEnd(44)} ${s.conditions.join(",").padEnd(10)} ${s.title}`);
  process.exit(0);
}

const { runs, warmup, selected, expected, condition: conditionFilter } = planSelection(SCENARIOS, args);
const trialEvidence: Record<string, Array<Trial & { results?: ResultSet; degraded?: string | null }>> = {};
const evalBudgets = loadBudgets(join(ROOT, "evals", "budgets.json"));

const goldenFile = (id: string) => join(ROOT, "evals", id.slice(0, id.indexOf(".")), "golden", `${id}.json`);

async function serverBinary(): Promise<string> {
  const exe = process.platform === "win32" ? ".exe" : "";
  const bin = process.env.OPENIDEA_SERVER ?? join(ROOT, "target", "release", `openidea-server${exe}`);
  if (!args["no-build"]) {
    console.log("Building openidea-server (cargo build --release)…");
    await runCommand("cargo", ["build", "--release", "-p", "ide-host", "--bin", "openidea-server"], {
      cwd: ROOT,
      timeoutMs: 60 * 60_000,
      label: "cargo build",
    });
  }
  if (!existsSync(bin)) throw new Error(`no server at ${bin}; run without --no-build`);
  return bin;
}

function git(...a: string[]): string {
  try {
    return execFileSync("git", a, { cwd: ROOT, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" }).trim();
  } catch {
    return "";
  }
}

interface Run {
  metrics: Record<string, number>;
  results?: ResultSet;
  degraded?: string | null;
  window: [number, number];
}

async function measureOnce(s: Session, scenario: EvalScenario, trace: string | null, browser: Browser): Promise<Run> {
  await s.reset();
  await scenario.setup(s);
  await s.settle(scenario.server, 1000);
  const from = (s.timeline.stepStart = s.timeline.now());
  if (trace) await browser.startTracing(s.page, { screenshots: true });
  try {
    const m = await scenario.step(s);
    return {
      metrics: { ...m.timing },
      results: m.results,
      degraded: m.degraded,
      window: [from, s.timeline.now()],
    };
  } finally {
    if (trace) writeFileSync(trace, await browser.stopTracing());
  }
}

function diagnose(s: Session, window: [number, number], trace?: string): Diagnostics {
  const w = s.timeline.window(window[0] - 500, window[1]);
  return {
    calls: w.calls.map((c) => ({ ...c })),
    tasks: w.tasks.map((t) => ({ title: t.title, start: t.start, end: t.end })),
    servers: s.timeline.servers.filter((x) => x.at <= window[1]),
    window,
    serverLog: s.serverLog(),
    trace,
  };
}

function outcomeOf(
  scenario: EvalScenario,
  condition: Condition,
  done: Run[],
  tools: Record<string, string>,
  extra: Record<string, number> = {},
): Outcome {
  const golden = readGolden(goldenFile(scenario.id));
  const comparisons = golden ? done.map((r) => compare(r.results ?? {}, golden.groups)) : [];
  const worst = comparisons.reduce<(typeof comparisons)[number] | undefined>(
    (w, c) => (!w || c.recall + c.precision < w.recall + w.precision ? c : w),
    undefined,
  );
  const samples: Array<Record<string, number>> = done.map((r, i) =>
    comparisons[i] ? { ...r.metrics, recall: comparisons[i].recall, precision: comparisons[i].precision } : r.metrics,
  );
  return {
    scenario: scenario.id,
    title: scenario.title,
    condition,
    metrics: { ...summarizeMetrics(samples, ["recall", "precision"]), ...extra },
    samples: Object.fromEntries(
      [...new Set(samples.flatMap((s) => Object.keys(s)))].map((k) => [k, samples.map((x) => x[k]!)]),
    ),
    results: done.at(-1)?.results,
    comparison: worst,
    drift: golden ? toolDrift(golden, tools) : undefined,
    degraded: done.find((r) => r.degraded)?.degraded ?? null,
  };
}

async function runScenario(
  s: Session,
  scenario: EvalScenario,
  condition: Condition,
  browser: Browser,
  tools: Record<string, string>,
  progress: () => void,
  extra: Record<string, number> = {},
): Promise<Outcome> {
  const total = condition === "cold" ? 1 : warmup + runs;
  const done: Run[] = [];
  process.stdout.write(`${idOf({ scenario: scenario.id, condition }).padEnd(52)} `);
  const attempts: Array<Trial & { results?: ResultSet; degraded?: string | null }> = (trialEvidence[
    idOf({ scenario: scenario.id, condition })
  ] = []);
  let phase: Trial["phase"] = condition === "warm" && warmup ? "warmup" : "measured";
  let index = 1;
  try {
    for (let i = 0; i < total; i++) {
      const last = i === total - 1;
      const trace = args.trace && last ? join(OUT, "traces", `${scenario.id}@${condition}.json`) : null;
      phase = condition === "warm" && i < warmup ? "warmup" : "measured";
      index = phase === "warmup" ? i + 1 : condition === "cold" ? 1 : i - warmup + 1;
      const r = await withDeadline(measureOnce(s, scenario, trace, browser), 5 * 60_000, `${scenario.id} trial`);
      const golden = readGolden(goldenFile(scenario.id));
      const comparison = golden && r.results ? compare(r.results, golden.groups) : undefined;
      const metrics = comparison
        ? { ...r.metrics, recall: comparison.recall, precision: comparison.precision }
        : r.metrics;
      const limits = {
        ...evalBudgets.defaults,
        ...evalBudgets.scenarios[scenario.id],
        ...evalBudgets.scenarios[idOf({ scenario: scenario.id, condition })],
      };
      const required = [
        "feedbackMs",
        "firstResultMs",
        "completeMs",
        ...Object.keys(limits).filter((k) => k !== "recall" && k !== "precision"),
      ];
      const errors = metricErrors(metrics, required);
      if (r.degraded) errors.push(r.degraded);
      if (comparison && (comparison.recall < 1 || comparison.precision < 1)) errors.push("result differs from golden");
      attempts.push({
        phase,
        index,
        status: errors.length ? "invalid" : "ok",
        metrics,
        results: r.results,
        degraded: r.degraded,
        error: errors.join("; ") || undefined,
      });
      if (phase === "measured") done.push(r);
      progress();
      process.stdout.write(errors.length ? "!" : phase === "warmup" ? "w" : ".");
    }
    console.log();
    const o = outcomeOf(scenario, condition, done, tools, extra);
    o.error = summarizeTrials(attempts, condition === "cold" ? 1 : runs).error;
    const slowest = done.reduce((a, b) => ((b.metrics.completeMs ?? 0) > (a.metrics.completeMs ?? 0) ? b : a));
    o.diagnostics = diagnose(
      s,
      slowest.window,
      args.trace ? join(OUT, "traces", `${scenario.id}@${condition}.json`) : undefined,
    );
    return o;
  } catch (e) {
    console.log(" failed");
    const message = e instanceof Error ? e.message : String(e);
    const partial = e instanceof TimeoutError ? (e.partial as Record<string, number>) : {};
    const now = s.timeline.now();
    if (!attempts.some((t) => t.phase === phase && t.index === index))
      attempts.push({
        phase,
        index,
        status: e instanceof DeadlineError || e instanceof TimeoutError ? "timeout" : "error",
        metrics: partial,
        error: message,
      });
    progress();
    return {
      ...outcomeOf(scenario, condition, done, tools, extra),
      metrics: { ...partial, ...extra },
      error: message,
      diagnostics: diagnose(s, [s.timeline.stepStart ?? Math.max(0, now - 35_000), now]),
    };
  }
}

async function main() {
  mkdirSync(join(OUT, "traces"), { recursive: true });
  const outcomes: Outcome[] = [];
  const infrastructure: string[] = [];
  const machine: Fingerprint = fingerprint();
  const date = new Date().toISOString();
  let tools: Record<string, string> = {};
  let pins: Record<string, string> = {};
  let runtime: BrowserSession | undefined;
  let server: HttpServer | undefined;
  let browserVersion = "not started";
  const progress = () => {
    writeFileSync(
      join(OUT, "report.json"),
      evidenceJson({
        meta: { date, runs, warmup, machine, tools, pins },
        status: "running",
        pass: false,
        expected,
        outcomes,
        trials: trialEvidence,
      }),
    );
  };
  progress();
  writeFileSync(join(OUT, "report.md"), "# OpenIDEA eval report\n\nRun in progress; no passing verdict.\n");
  try {
    process.env.OPENIDEA_SERVER = await serverBinary();
    if (!args["no-build"]) await buildBundle(ROOT, DIST);
    if (!existsSync(join(DIST, "index.html"))) throw new Error(`no build in ${DIST}; run without --no-build`);
    tools = toolVersions();
    pins = pinnedTools(join(ROOT, ".github", "tool-versions.env"));
    for (const [k, want] of Object.entries(pins)) {
      if (tools[k] !== undefined && !tools[k]!.startsWith(want))
        console.warn(`warning: ${k} ${tools[k]} is not the pinned ${want} (.github/tool-versions.env)`);
    }
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
    const browser = runtime.browser;
    browserVersion = browser.version();
    const warm = selected.filter(
      (s) => s.conditions.includes("warm") && (!conditionFilter || conditionFilter === "warm"),
    );
    for (const fixture of [...new Set(warm.map((s) => s.fixture))]) {
      const scenarios = warm.filter((s) => s.fixture === fixture);
      const s = await Session.start(browser, serving.url, ROOT, {
        fixture,
        workDir: join(OUT, "warm"),
        keepHome: false,
      });
      try {
        await withDeadline(scenarios[0]!.setup(s), 5 * 60_000, "warm fixture setup");
        await s.settle(scenarios[0]!.server);
        for (const scenario of scenarios) {
          const outcome = await runScenario(s, scenario, "warm", browser, tools, progress);
          outcomes.push(outcome);
          progress();
          if (outcome.error) break;
        }
      } finally {
        await s.close();
      }
    }
    const cold = selected.filter(
      (s) => s.conditions.includes("cold") && (!conditionFilter || conditionFilter === "cold"),
    );
    for (const scenario of cold) {
      const started = Date.now();
      const s = await Session.start(browser, serving.url, ROOT, {
        fixture: scenario.fixture,
        workDir: join(OUT, "cold"),
        keepHome: false,
      });
      try {
        await withDeadline(scenario.setup(s), 5 * 60_000, "cold fixture setup");
        await s.settle(scenario.server);
        const readyMs = Date.now() - started - 2000;
        outcomes.push(await runScenario(s, scenario, "cold", browser, tools, progress, { readyMs }));
        progress();
      } finally {
        await s.close();
      }
    }
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

  if (args["update-golden"]) {
    for (const o of outcomes) {
      if (o.error || !o.results) continue;
      writeGolden(goldenFile(o.scenario), { tools, groups: o.results });
      const c = compare(o.results, o.results);
      o.comparison = c;
      o.metrics.recall = c.recall;
      o.metrics.precision = c.precision;
      o.drift = [];
    }
    console.log("Goldens re-recorded: review `git diff evals/` before committing.");
  }

  const baselineFile = join(OUT, "baseline.json");
  let baseline: Outcome[] | null = null;
  if (existsSync(baselineFile)) {
    try {
      const saved = JSON.parse(readFileSync(baselineFile, "utf8")) as { machine: Fingerprint; outcomes: Outcome[] };
      if (sameMachine(saved.machine, machine)) baseline = saved.outcomes;
      else console.warn("warning: target/eval/baseline.json is from another machine or OS: not compared");
    } catch (error) {
      infrastructure.push(`baseline: ${errorMessage(error)}`);
    }
  }
  const repro = (o: Outcome) => `pnpm eval --only ${o.scenario} --condition ${o.condition}`;
  const verdicts = judge(outcomes, evalBudgets, baseline, repro, expected);

  const meta = {
    date,
    commit: git("rev-parse", "--short", "HEAD"),
    dirty: git("status", "--porcelain", "--untracked-files=no") !== "",
    runs,
    warmup,
    machine,
    tools,
    pins,
    browser: browserVersion,
  };
  const report = {
    meta,
    pass: infrastructure.length === 0 && verdicts.every((v) => v.status === "pass"),
    status: infrastructure.length || verdicts.some((v) => v.status === "fail") ? "failed" : "complete",
    expected,
    outcomes,
    trials: trialEvidence,
    infrastructure,
    verdicts: verdicts.map((v) => {
      const o = outcomes.find((x) => idOf(x) === v.id);
      return {
        ...v,
        samples: o?.samples,
        results: o?.results,
        comparison: o?.comparison,
        drift: o?.drift,
        degraded: o?.degraded,
        error: o?.error,
        // Diagnostics only where something needs a look.
        diagnostics: v.status === "fail" || v.regressions.length ? o?.diagnostics : undefined,
      };
    }),
  };
  writeFileSync(join(OUT, "report.json"), evidenceJson(report));
  const failing = verdicts.filter((v) => v.status === "fail");
  const md = [
    "# OpenIDEA eval report",
    "",
    `${meta.date} · \`${meta.commit}\`${meta.dirty ? " (dirty)" : ""} · ${machine.cpu} · ${machine.os} · jdtls ${tools.jdtls ?? "?"} · java ${tools.java ?? "?"}`,
    "",
    table(verdicts, true),
    "",
    ...failing.flatMap((v) => [`- **${v.id}**: ${v.failures.map((f) => f.detail).join("; ")} — \`${v.repro}\``]),
    ...infrastructure.map((error) => `- **Infrastructure**: ${error}`),
    "",
    "## Trials",
    "",
    "| Scenario | Valid / planned measured | Attempted measured | Valid / attempted warmup |",
    "| --- | ---: | ---: | ---: |",
    ...Object.entries(trialEvidence).map(([id, attempts]) => {
      const c = summarizeTrials(attempts, id.endsWith("@cold") ? 1 : runs).counts;
      return `| ${id} | ${c.valid}/${c.planned} | ${c.attempted} | ${c.warmupValid}/${c.warmupAttempted} |`;
    }),
  ].join("\n");
  writeFileSync(join(OUT, "report.md"), md + "\n");

  console.log();
  console.log(table(verdicts, false));
  for (const v of failing) {
    console.log(`\n${v.id} FAILED (${v.repro})`);
    for (const f of v.failures) console.log(`  ${f.kind}: ${f.detail}`);
    const o = outcomes.find((x) => idOf(x) === v.id);
    if (o?.drift?.length) console.log(`  golden recorded with other tools: ${o.drift.join(", ")}`);
    const slow = [...(o?.diagnostics?.calls ?? [])].sort((a, b) => b.ms - a.ms).slice(0, 5);
    if (slow.length)
      console.log(
        `  slowest commands: ${slow.map((c) => `${c.cmd} ${Math.round(c.ms)} ms${c.pending ? " (no answer)" : c.ok ? "" : " (failed)"}`).join(", ")}`,
      );
  }
  console.log(`\nReport: ${join(OUT, "report.json")}`);
  if (args["save-baseline"]) {
    writeFileSync(baselineFile, evidenceJson({ machine, meta, outcomes }));
    console.log(`Baseline saved to ${baselineFile}`);
  }
  const regressed = verdicts.some((v) => v.regressions.length);
  process.exit(infrastructure.length || failing.length || (args["fail-on-regression"] && regressed) ? 1 : 0);
}

await main();
