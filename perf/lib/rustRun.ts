import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { evaluate, loadBudgets, printReport, type Budgets, type Report, type ScenarioResult } from "./report.ts";
import { inspectRustArtifacts, rustBudgets, rustPaths, selectRustPackages, type RustArtifacts } from "./rust.ts";
import { runCommand } from "./process.ts";

// Includes cold compilation and the complete Criterion workload. Tests inject shorter deadlines.
const CARGO_TIMEOUT_MS = 60 * 60 * 1000;
const CLEANUP_GRACE_MS = 1000;

type CargoOutcome = { error?: string };
type RunManifest = {
  id: string;
  packages: string[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
  cargo?: CargoOutcome;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Keep cargo output alongside partial Criterion artifacts, including spawn and timeout failures. */
async function runCargo(
  command: { file: string; args: string[] },
  cwd: string,
  env: NodeJS.ProcessEnv,
  logs: string,
  timeoutMs: number,
  graceMs: number,
): Promise<CargoOutcome> {
  const stdout = openSync(join(logs, "cargo.stdout.log"), "a");
  let stderr: number | undefined;
  try {
    stderr = openSync(join(logs, "cargo.stderr.log"), "a");
    await runCommand(command.file, command.args, {
      cwd,
      env,
      timeoutMs,
      graceMs,
      label: "cargo bench",
      stdio: ["ignore", stdout, stderr],
    });
    return {};
  } catch (error) {
    return { error: message(error) };
  } finally {
    closeSync(stdout);
    if (stderr !== undefined) closeSync(stderr);
  }
}

function inspectionSource(criterion: string, packages: string[], now: number) {
  const runs = join(criterion, "runs");
  // Pre-manifest Criterion output is still useful, but is explicitly labelled inspection-only.
  if (!existsSync(runs)) return { criterion, kind: "legacy inspection" };
  const manifests = readdirSync(runs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const root = join(runs, entry.name);
      const manifest = JSON.parse(readFileSync(join(root, "run.json"), "utf8")) as RunManifest;
      if (
        manifest.id !== entry.name ||
        !Array.isArray(manifest.packages) ||
        !manifest.packages.length ||
        manifest.packages.some((p) => typeof p !== "string") ||
        !Number.isFinite(Date.parse(manifest.startedAt)) ||
        Date.parse(manifest.startedAt) > now + 1000
      )
        throw new Error(`invalid or future Rust run manifest: ${root}`);
      selectRustPackages(manifest.packages);
      return { root, manifest };
    })
    .filter(({ manifest }) => packages.every((p) => manifest.packages.includes(p)))
    .sort(
      (a, b) =>
        Date.parse(b.manifest.startedAt) - Date.parse(a.manifest.startedAt) ||
        b.manifest.id.localeCompare(a.manifest.id),
    );
  const source = manifests[0];
  if (!source) throw new Error(`no Rust artifact run covers selected packages: ${packages.join(" ")}`);
  const { root, manifest } = source;
  if (!manifest.finishedAt) throw new Error(`Rust artifact run is still running or incomplete: ${root}`);
  if (
    !Number.isFinite(Date.parse(manifest.finishedAt)) ||
    Date.parse(manifest.finishedAt) < Date.parse(manifest.startedAt) ||
    Date.parse(manifest.finishedAt) > now + 1000
  )
    throw new Error(`invalid or future Rust run completion date: ${root}`);
  return { criterion: join(root, "criterion"), kind: "recorded run inspection", manifest };
}

/** Execute or inspect one Rust trial; infrastructure failures are results, never stale passing reports. */
export async function runRust(options: {
  root: string;
  packages?: string[];
  noRun?: boolean;
  saveBaseline?: boolean;
  failOnRegression?: boolean;
  env?: NodeJS.ProcessEnv;
  command?: { file: string; args: string[] };
  timeoutMs?: number;
  cleanupGraceMs?: number;
}): Promise<number> {
  const env = options.env ?? process.env;
  const out = join(options.root, "target", "perf");
  const baselineFile = join(out, "baseline-rust.json");
  const errors: string[] = [];
  let packages = options.packages ?? [];
  let selectedBudgets: Record<string, number> = {};
  let budgets: Budgets | undefined;
  let baseline: ScenarioResult[] | null = null;
  let evidence: RustArtifacts = { metrics: {}, artifacts: [], errors: [] };
  let manifest: RunManifest | undefined;
  let runRoot: string | undefined;
  let artifactRoot: string | undefined;
  let source = options.noRun ? "inspection (no cargo execution)" : "current execution";
  const startedAt = new Date().toISOString();
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, "report-rust.json"),
    JSON.stringify(
      {
        meta: { date: startedAt, mode: options.noRun ? "inspection" : "execution", packages },
        status: "running",
        results: [],
        artifacts: [],
      },
      null,
      2,
    ),
  );
  writeFileSync(join(out, "report-rust.md"), "# OpenIDEA performance report\n\nRun in progress; no passing verdict.\n");
  try {
    packages = selectRustPackages(options.packages);
    budgets = loadBudgets(join(options.root, "perf", "budgets.json"));
    selectedBudgets = rustBudgets(packages, budgets.rust);
    const paths = rustPaths(options.root, env);
    let artifactStarted: number | undefined;
    if (options.noRun) {
      const inspection = inspectionSource(paths.criterion, packages, Date.now());
      artifactRoot = inspection.criterion;
      source = inspection.kind;
      manifest = inspection.manifest;
      if (manifest?.error) errors.push(`recorded run failed: ${manifest.error}`);
      artifactStarted = manifest ? Date.parse(manifest.startedAt) : undefined;
    } else {
      const timeoutMs = options.timeoutMs ?? Number(env.PERF_RUST_TIMEOUT_MS ?? CARGO_TIMEOUT_MS);
      const graceMs = options.cleanupGraceMs ?? CLEANUP_GRACE_MS;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
        throw new Error("invalid PERF_RUST_TIMEOUT_MS");
      if (!Number.isFinite(graceMs) || graceMs <= 0 || graceMs > 2_147_483_647)
        throw new Error("invalid Rust cleanup deadline");
      const runs = join(paths.criterion, "runs");
      mkdirSync(runs, { recursive: true });
      runRoot = mkdtempSync(join(runs, "run-"));
      artifactRoot = join(runRoot, "criterion");
      mkdirSync(artifactRoot);
      manifest = { id: basename(runRoot), packages, startedAt };
      writeFileSync(join(runRoot, "run.json"), JSON.stringify(manifest, null, 2));
      console.log(`Rust cargo logs and artifacts: ${runRoot}`);
      manifest.cargo = await runCargo(
        options.command ?? { file: "cargo", args: ["bench", ...packages.flatMap((p) => ["-p", p]), "--benches"] },
        options.root,
        { ...env, CARGO_TARGET_DIR: paths.target, CRITERION_HOME: artifactRoot },
        runRoot,
        timeoutMs,
        graceMs,
      );
      if (manifest.cargo.error) errors.push(manifest.cargo.error);
      artifactStarted = Date.parse(startedAt);
    }
    evidence = inspectRustArtifacts(
      artifactRoot,
      packages,
      artifactStarted,
      options.noRun && manifest?.finishedAt ? Date.parse(manifest.finishedAt) : Date.now(),
    );
    errors.push(...evidence.errors);
    if (existsSync(baselineFile)) baseline = JSON.parse(readFileSync(baselineFile, "utf8")) as ScenarioResult[];
  } catch (error) {
    errors.push(message(error));
    baseline = null;
  }
  if (runRoot && manifest) {
    manifest.finishedAt = new Date().toISOString();
    if (errors.length) manifest.error = errors.join("\n");
    try {
      writeFileSync(join(runRoot, "run.json"), JSON.stringify(manifest, null, 2));
    } catch (error) {
      errors.push(`Rust run manifest: ${message(error)}`);
    }
  }
  const results: ScenarioResult[] = [
    {
      id: "rust",
      title: "criterion means (µs)",
      metrics: evidence.metrics,
      ...(errors.length ? { error: errors.join("\n") } : {}),
    },
  ];
  let report: Report;
  try {
    report = evaluate(results, selectedBudgets, baseline, {
      expected: ["rust"],
      enforceBudgets: true,
      tolerance: budgets?.regressionTolerance,
      floor: budgets?.regressionFloor,
    });
  } catch (error) {
    errors.push(`Rust report evaluation: ${message(error)}`);
    results[0]!.error = errors.join("\n");
    report = evaluate(results, selectedBudgets, null, { expected: ["rust"], enforceBudgets: true });
  }
  const meta = {
    date: new Date().toISOString(),
    unit: "µs (mean)",
    packages: packages.join(" "),
    mode: options.noRun ? "inspection" : "execution",
    source,
    artifactRoot: artifactRoot ?? "unavailable",
    artifactRunId: manifest?.id ?? "unrecorded",
    artifactStartedAt: manifest?.startedAt ?? "unknown (legacy artifacts; see file dates)",
    artifactFinishedAt: manifest?.finishedAt ?? "unknown",
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, "report-rust.json"),
    JSON.stringify(
      { meta, status: report.failures ? "failed" : "complete", ...report, results, artifacts: evidence.artifacts },
      null,
      2,
    ),
  );
  writeFileSync(join(out, "report-rust.md"), printReport(report, meta));
  if (errors.length) console.error(errors.join("\n"));
  if (options.saveBaseline) {
    writeFileSync(baselineFile, JSON.stringify(results, null, 2));
    console.log(`Baseline saved to ${baselineFile}`);
  }
  return report.failures > 0 || (options.failOnRegression && report.regressions > 0) ? 1 : 0;
}
