import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RUST_BENCHMARKS } from "./rust.ts";
import { runRust } from "./rustRun.ts";

const TEXT_BENCHMARKS = RUST_BENCHMARKS["ide-text"]!.length;

const roots: string[] = [];
const ownedPids: number[] = [];
beforeEach(() => {
  vi.stubEnv("CARGO_TARGET_DIR", "target");
  vi.stubEnv("CRITERION_HOME", "target/criterion");
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rust-run-"));
  roots.push(root);
  mkdirSync(join(root, "perf"));
  writeFileSync(join(root, "perf/budgets.json"), readFileSync(resolve(import.meta.dirname, "../budgets.json")));
  mkdirSync(join(root, "target/perf"), { recursive: true });
  writeFileSync(join(root, "target/perf/report-rust.json"), '{"sentinel":"old passing report"}');
  writeFileSync(join(root, "target/perf/report-rust.md"), "old passing report");
  return root;
}
function report(root: string) {
  return JSON.parse(readFileSync(join(root, "target/perf/report-rust.json"), "utf8"));
}
function artifacts(root: string, packages: readonly string[], date = new Date()) {
  for (const p of packages)
    for (const id of RUST_BENCHMARKS[p]!) {
      const directory = join(root, id, "new");
      mkdirSync(directory, { recursive: true });
      for (const [file, content] of [
        ["benchmark.json", { full_id: id }],
        ["estimates.json", { mean: { point_estimate: 1 } }],
      ] as const) {
        const path = join(directory, file);
        writeFileSync(path, JSON.stringify(content));
        utimesSync(path, date, date);
      }
    }
}
function recorded(root: string, id: string, packages: string[], started: number, error?: string) {
  const runRoot = join(root, "target/criterion/runs", id);
  mkdirSync(runRoot, { recursive: true });
  writeFileSync(
    join(runRoot, "run.json"),
    JSON.stringify({
      id,
      packages,
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date(started + 5000).toISOString(),
      ...(error ? { error } : {}),
    }),
  );
  artifacts(join(runRoot, "criterion"), packages, new Date(started + 1000));
  return runRoot;
}
function childCommand(tail: string, ids = RUST_BENCHMARKS["ide-text"]!) {
  return {
    file: process.execPath,
    args: [
      "-e",
      `
    const fs = require('node:fs');
    const path = require('node:path');
    for (const id of ${JSON.stringify(ids)}) {
      const directory = path.join(process.env.CRITERION_HOME, id, 'new');
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'benchmark.json'), JSON.stringify({full_id:id}));
      fs.writeFileSync(path.join(directory, 'estimates.json'), JSON.stringify({mean:{point_estimate:1}}));
    }
    console.error('partial cargo evidence');
    ${tail}
  `,
    ],
  };
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const pid of ownedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Rust trial lifecycle", () => {
  it.each(["nonzero", "timeout"])("replaces old reports and cleans descendants after %s", async (failure) => {
    const root = fixture();
    const pidFile = join(root, "descendant.pid");
    const heartbeat = join(root, "heartbeat");
    const command = childCommand(`
      const {spawn} = require('node:child_process');
      const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(`
        const fs = require('node:fs');
        process.on('SIGTERM', () => {});
        fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
        setInterval(() => fs.appendFileSync(${JSON.stringify(heartbeat)}, '.'), 10);
      `)}], {stdio:'ignore'});
      const ready = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(pidFile)})) return;
        clearInterval(ready);
        ${failure === "nonzero" ? "process.exit(7);" : "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"}
      }, 5);
    `);
    const started = Date.now();
    const code = await runRust({
      root,
      packages: ["ide-text"],
      command,
      timeoutMs: failure === "timeout" ? 500 : 3000,
      cleanupGraceMs: 100,
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(code).toBe(1);
    const current = report(root);
    expect(current.sentinel).toBeUndefined();
    expect(current.errors.map((entry: { error: string }) => entry.error).join(" ")).toMatch(
      failure === "timeout" ? /timed out/ : /exit 7/,
    );
    expect(Object.keys(current.results[0].metrics)).toHaveLength(TEXT_BENCHMARKS);
    expect(current.meta.mode).toBe("execution");
    const runRoot = resolve(current.meta.artifactRoot, "..");
    expect(readFileSync(join(runRoot, "cargo.stderr.log"), "utf8")).toContain("partial cargo evidence");
    expect(JSON.parse(readFileSync(join(runRoot, "run.json"), "utf8")).error).toBeTruthy();
    expect(readFileSync(join(root, "target/perf/report-rust.md"), "utf8")).not.toContain("old passing report");
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    ownedPids.push(pid);
    const before = existsSync(heartbeat) ? readFileSync(heartbeat, "utf8") : "";
    // Observe the real child's heartbeat after cleanup; fake timers cannot advance a subprocess.
    await new Promise((done) => setTimeout(done, 100));
    expect(existsSync(heartbeat) ? readFileSync(heartbeat, "utf8") : "").toBe(before);
  });

  it("replaces old reports on spawn failure", async () => {
    const root = fixture();
    expect(
      await runRust({ root, packages: ["ide-text"], command: { file: join(root, "missing-cargo"), args: [] } }),
    ).toBe(1);
    expect(report(root).errors[0].error).toMatch(/spawn failed/);
    expect(readFileSync(join(root, "target/perf/report-rust.md"), "utf8")).toContain("spawn failed");
  });

  it.each(["missing", "malformed"])("reports %s artifacts after a successful child", async (kind) => {
    const root = fixture();
    const command = childCommand(
      kind === "malformed"
        ? `fs.writeFileSync(path.join(process.env.CRITERION_HOME,'text/open_1mb/new/estimates.json'),'{');`
        : "",
      kind === "missing" ? [] : undefined,
    );
    expect(await runRust({ root, packages: ["ide-text"], command, timeoutMs: 3000 })).toBe(1);
    expect(report(root).errors.length).toBeGreaterThan(0);
    expect(readFileSync(join(root, "target/perf/report-rust.md"), "utf8")).not.toContain("old passing report");
    if (kind === "malformed") expect(Object.keys(report(root).results[0].metrics)).toHaveLength(TEXT_BENCHMARKS - 1);
  });

  it("never reuses old or concurrent roots as current execution", async () => {
    const root = fixture();
    const earlier = recorded(root, "old", ["ide-text"], Date.now() - 60_000);
    const concurrent = recorded(root, "other", ["ide-text"], Date.now() - 30_000);
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(concurrent, "criterion/text/open_1mb/new/estimates.json"), future, future);
    expect(await runRust({ root, packages: ["ide-text"], command: childCommand("", []), timeoutMs: 3000 })).toBe(1);
    const current = report(root);
    expect(current.results[0].metrics).toEqual({});
    expect(current.meta.artifactRoot).not.toBe(join(earlier, "criterion"));
    expect(current.meta.artifactRoot).not.toBe(join(concurrent, "criterion"));
    expect(current.errors[0].error).toMatch(/missing selected/);
  });

  it("inspects selected scope and original dates without claiming a new execution", async () => {
    const root = fixture();
    const runRoot = recorded(root, "selected", ["ide-text", "ide-search"], Date.now() - 60_000);
    recorded(root, "unselected-newer", ["ide-heap"], Date.now() - 30_000);
    expect(await runRust({ root, packages: ["ide-text"], noRun: true })).toBe(0);
    const current = report(root);
    expect(current.meta.mode).toBe("inspection");
    expect(current.meta.artifactRoot).toBe(join(runRoot, "criterion"));
    expect(current.meta.artifactStartedAt).toBe(JSON.parse(readFileSync(join(runRoot, "run.json"), "utf8")).startedAt);
    expect(current.artifacts).toHaveLength(2 * TEXT_BENCHMARKS);
    expect(
      current.artifacts.every((file: { modifiedAt: string }) => Date.parse(file.modifiedAt) < Date.now() - 10_000),
    ).toBe(true);
    expect(Object.keys(current.results[0].metrics)).toHaveLength(TEXT_BENCHMARKS);
  });

  it("keeps legacy inspection useful and reports artifact dates", async () => {
    const root = fixture();
    // Whole seconds: file times don't keep every millisecond on all file systems.
    const date = new Date(Math.floor((Date.now() - 120_000) / 1000) * 1000);
    artifacts(join(root, "target/criterion"), ["ide-text"], date);
    expect(await runRust({ root, packages: ["ide-text"], noRun: true })).toBe(0);
    const current = report(root);
    expect(current.meta.source).toBe("legacy inspection");
    expect(current.artifacts[0].modifiedAt).toBe(date.toISOString());
  });

  it.each(["scope", "future", "running", "failed"])("rejects invalid recorded inspection: %s", async (kind) => {
    const root = fixture();
    const runRoot = recorded(
      root,
      "recorded",
      kind === "scope" ? ["ide-heap"] : ["ide-text"],
      Date.now() - 60_000,
      kind === "failed" ? "cargo failed earlier" : undefined,
    );
    const path = join(runRoot, "run.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    if (kind === "future") manifest.startedAt = new Date(Date.now() + 60_000).toISOString();
    if (kind === "running") delete manifest.finishedAt;
    writeFileSync(path, JSON.stringify(manifest));
    expect(await runRust({ root, packages: ["ide-text"], noRun: true })).toBe(1);
    const error = report(root).errors[0].error;
    expect(error).toMatch(
      { scope: /covers selected/, future: /future/, running: /still running/, failed: /failed earlier/ }[kind]!,
    );
  });

  it("rejects artifacts modified after their recorded completion", async () => {
    const root = fixture();
    const runRoot = recorded(root, "recorded", ["ide-text"], Date.now() - 60_000);
    const file = join(runRoot, "criterion/text/open_1mb/new/estimates.json");
    const now = new Date();
    utimesSync(file, now, now);
    expect(await runRust({ root, packages: ["ide-text"], noRun: true })).toBe(1);
    expect(report(root).errors[0].error).toMatch(/future Criterion artifact/);
  });
});
