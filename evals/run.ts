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
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Browser } from "@playwright/test";
import { buildBundle, serveBundle } from "../perf/lib/bundle.ts";
import { median } from "../perf/lib/stats.ts";
import { JAVA_SCENARIOS } from "./java/scenarios.ts";
import { compare, readGolden, toolDrift, writeGolden, type ResultSet } from "./lib/golden.ts";
import { TimeoutError } from "./lib/measure.ts";
import { fingerprint, pinnedTools, sameMachine, toolVersions, type Fingerprint } from "./lib/machine.ts";
import type { EvalScenario } from "./lib/scenario.ts";
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

const runs = Math.max(1, Number(args.runs));
const warmup = Math.max(0, Number(args.warmup));
const only = args.only?.split(",").map((s) => s.trim());
const conditionFilter = args.condition as Condition | undefined;
const selected = SCENARIOS.filter((s) => !only || only.some((o) => s.id === o || s.id.startsWith(`${o}.`)));
if (only && !selected.length) throw new Error(`no scenario matches ${args.only} (see --list)`);

const goldenFile = (id: string) => join(ROOT, "evals", id.slice(0, id.indexOf(".")), "golden", `${id}.json`);

function serverBinary(): string {
  const exe = process.platform === "win32" ? ".exe" : "";
  const bin = process.env.OPENIDEA_SERVER ?? join(ROOT, "target", "release", `openidea-server${exe}`);
  if (!args["no-build"]) {
    console.log("Building openidea-server (cargo build --release)…");
    const r = spawnSync("cargo", ["build", "--release", "-p", "ide-host", "--bin", "openidea-server"], {
      cwd: ROOT,
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (r.status !== 0) throw new Error("cargo build failed");
  }
  if (!existsSync(bin)) throw new Error(`no server at ${bin}; run without --no-build`);
  return bin;
}

function git(...a: string[]): string {
  try {
    return execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** Medians of the timings; correctness from the worst run. */
function summarize(samples: Array<Record<string, number>>): Record<string, number> {
  const keys = [...new Set(samples.flatMap((s) => Object.keys(s)))];
  return Object.fromEntries(
    keys.map((k) => {
      const values = samples.map((s) => s[k]!).filter(Number.isFinite);
      return [k, k === "recall" || k === "precision" ? Math.min(...values) : median(values)];
    }),
  );
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
    metrics: { ...summarize(samples), ...extra },
    samples: Object.fromEntries(Object.keys(samples[0] ?? {}).map((k) => [k, samples.map((x) => x[k]!)])),
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
  extra: Record<string, number> = {},
): Promise<Outcome> {
  const total = condition === "cold" ? 1 : warmup + runs;
  const done: Run[] = [];
  process.stdout.write(`${idOf({ scenario: scenario.id, condition }).padEnd(52)} `);
  try {
    for (let i = 0; i < total; i++) {
      const last = i === total - 1;
      const trace = args.trace && last ? join(OUT, "traces", `${scenario.id}@${condition}.json`) : null;
      const r = await measureOnce(s, scenario, trace, browser);
      if (condition === "cold" || i >= warmup) done.push(r);
      process.stdout.write(condition === "warm" && i < warmup ? "w" : ".");
    }
    console.log();
    const o = outcomeOf(scenario, condition, done, tools, extra);
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
  process.env.OPENIDEA_SERVER = serverBinary();
  if (!args["no-build"]) buildBundle(ROOT, DIST);
  if (!existsSync(join(DIST, "index.html"))) throw new Error(`no build in ${DIST}; run without --no-build`);

  const tools = toolVersions();
  const pins = pinnedTools(join(ROOT, ".github", "tool-versions.env"));
  const machine: Fingerprint = fingerprint();
  for (const [k, want] of Object.entries(pins)) {
    if (tools[k] !== undefined && !tools[k]!.startsWith(want))
      console.warn(`warning: ${k} ${tools[k]} is not the pinned ${want} (.github/tool-versions.env)`);
  }

  const { server, url } = await serveBundle(DIST);
  const browser = await chromium.launch({
    channel: args.channel === "chromium" ? undefined : args.channel,
    headless: !args.headed,
    args: [
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
    ],
  });
  const outcomes: Outcome[] = [];
  try {
    // Warm: one session per fixture, its project imported once, scenarios one after another.
    const warm = selected.filter(
      (s) => s.conditions.includes("warm") && (!conditionFilter || conditionFilter === "warm"),
    );
    for (const fixture of [...new Set(warm.map((s) => s.fixture))]) {
      const scenarios = warm.filter((s) => s.fixture === fixture);
      const s = await Session.start(browser, url, ROOT, { fixture, workDir: join(OUT, "warm"), keepHome: false });
      try {
        await scenarios[0]!.setup(s);
        await s.settle(scenarios[0]!.server);
        for (const scenario of scenarios) outcomes.push(await runScenario(s, scenario, "warm", browser, tools));
      } finally {
        await s.close();
      }
    }
    // Cold: a fresh server and project import per scenario, measured once after the import settles.
    const cold = selected.filter(
      (s) => s.conditions.includes("cold") && (!conditionFilter || conditionFilter === "cold"),
    );
    for (const scenario of cold) {
      const started = Date.now();
      const s = await Session.start(browser, url, ROOT, {
        fixture: scenario.fixture,
        workDir: join(OUT, "cold"),
        keepHome: false,
      });
      try {
        await scenario.setup(s);
        await s.settle(scenario.server);
        // Settling waits out the quiet period at its end.
        const readyMs = Date.now() - started - 2000;
        outcomes.push(await runScenario(s, scenario, "cold", browser, tools, { readyMs }));
      } finally {
        await s.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
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
    const saved = JSON.parse(readFileSync(baselineFile, "utf8")) as { machine: Fingerprint; outcomes: Outcome[] };
    if (sameMachine(saved.machine, machine)) baseline = saved.outcomes;
    else console.warn("warning: target/eval/baseline.json is from another machine or OS: not compared");
  }
  const repro = (o: Outcome) => `pnpm eval --only ${o.scenario} --condition ${o.condition}`;
  const verdicts = judge(outcomes, loadBudgets(join(ROOT, "evals", "budgets.json")), baseline, repro);

  const meta = {
    date: new Date().toISOString(),
    commit: git("rev-parse", "--short", "HEAD"),
    dirty: git("status", "--porcelain", "--untracked-files=no") !== "",
    runs,
    warmup,
    machine,
    tools,
    pins,
    browser: browser.version(),
  };
  const report = {
    meta,
    pass: verdicts.every((v) => v.status === "pass"),
    verdicts: verdicts.map((v) => {
      const o = outcomes.find((x) => idOf(x) === v.id)!;
      return {
        ...v,
        samples: o.samples,
        results: o.results,
        comparison: o.comparison,
        drift: o.drift,
        degraded: o.degraded,
        error: o.error,
        // Diagnostics only where something needs a look.
        diagnostics: v.status === "fail" || v.regressions.length ? o.diagnostics : undefined,
      };
    }),
  };
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  const failing = verdicts.filter((v) => v.status === "fail");
  const md = [
    "# OpenIDEA eval report",
    "",
    `${meta.date} · \`${meta.commit}\`${meta.dirty ? " (dirty)" : ""} · ${machine.cpu} · ${machine.os} · jdtls ${tools.jdtls ?? "?"} · java ${tools.java ?? "?"}`,
    "",
    table(verdicts, true),
    "",
    ...failing.flatMap((v) => [`- **${v.id}**: ${v.failures.map((f) => f.detail).join("; ")} — \`${v.repro}\``]),
  ].join("\n");
  writeFileSync(join(OUT, "report.md"), md + "\n");

  console.log();
  console.log(table(verdicts, false));
  for (const v of failing) {
    console.log(`\n${v.id} FAILED (${v.repro})`);
    for (const f of v.failures) console.log(`  ${f.kind}: ${f.detail}`);
    const o = outcomes.find((x) => idOf(x) === v.id)!;
    if (o.drift?.length) console.log(`  golden recorded with other tools: ${o.drift.join(", ")}`);
    const slow = [...(o.diagnostics?.calls ?? [])].sort((a, b) => b.ms - a.ms).slice(0, 5);
    if (slow.length)
      console.log(
        `  slowest commands: ${slow.map((c) => `${c.cmd} ${Math.round(c.ms)} ms${c.pending ? " (no answer)" : c.ok ? "" : " (failed)"}`).join(", ")}`,
      );
  }
  console.log(`\nReport: ${join(OUT, "report.json")}`);
  if (args["save-baseline"]) {
    writeFileSync(baselineFile, JSON.stringify({ machine, meta, outcomes }, null, 2));
    console.log(`Baseline saved to ${baselineFile}`);
  }
  const regressed = verdicts.some((v) => v.regressions.length);
  process.exit(failing.length || (args["fail-on-regression"] && regressed) ? 1 : 0);
}

await main();
