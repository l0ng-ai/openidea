import type { Diagnostic } from "@/bindings";
import { tx } from "@/platform/i18n";
import { call, commands, isErrorKind, nextRequestId, onIdeEvent } from "@/platform/ipc";
import { toolWindowService } from "@/workbench/contributions";
import {
  collectSnapshotResults,
  commitFileDiff,
  commitFiles,
  readCommitFile,
  type CommittedSnapshot,
} from "./commitContents";
import { openVcsDiff, type DiffData } from "./diffInput";
import type { CommitCheckContext, CommitCheckResult } from "./commitCheckRegistry";

// ---------------------------------------------------------------------------
// Diagnostics seen per file (Analyze code)

const diagnostics = new Map<string, Map<string, Diagnostic[]>>();
/** Paths that received at least one diagnostics event. */
const analyzed = new Set<string>();
const waiters = new Set<() => void>();

export function installDiagnosticsTracking(): () => void {
  return onIdeEvent("diagnostics", (e) => {
    let sources = diagnostics.get(e.path);
    if (!sources) diagnostics.set(e.path, (sources = new Map()));
    if (e.items.length) sources.set(e.source, e.items);
    else sources.delete(e.source);
    analyzed.add(e.path);
    waiters.forEach((w) => w());
  });
}

export function problemCounts(paths: readonly string[]): { errors: number; warnings: number; files: number } {
  let errors = 0;
  let warnings = 0;
  let files = 0;
  for (const p of paths) {
    const items = [...(diagnostics.get(p)?.values() ?? [])].flat();
    const e = items.filter((d) => d.severity === "error").length;
    const w = items.filter((d) => d.severity === "warning").length;
    errors += e;
    warnings += w;
    if (e + w) files++;
  }
  return { errors, warnings, files };
}

/** Waits until every path was analysed (or `timeout`). */
function waitForAnalysis(paths: readonly string[], timeout: number): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (paths.every((p) => analyzed.has(p))) finish();
    };
    const timer = setTimeout(() => finish(), timeout);
    const finish = () => {
      clearTimeout(timer);
      waiters.delete(check);
      resolve();
    };
    waiters.add(check);
    check();
  });
}

async function analyzeWorkingFiles(paths: string[]) {
  const opened: number[] = [];
  for (const path of paths.filter((p) => !analyzed.has(p))) {
    try {
      opened.push((await call(commands.docOpen(path))).id);
    } catch {
      // Binary or unreadable.
    }
  }
  try {
    await waitForAnalysis(paths, opened.length ? 2000 : 0);
  } finally {
    opened.forEach((id) => void commands.docClose(id));
  }
}

type Snapshot = { errors: number; warnings: number; diff: DiffData };

async function analyzeSnapshot(diff: DiffData, text: string, signal?: AbortSignal): Promise<Snapshot | null> {
  signal?.throwIfAborted();
  const request = nextRequestId();
  const cancel = () => void commands.cancelRequest(request).catch(() => {});
  signal?.addEventListener("abort", cancel, { once: true });
  let items;
  try {
    items = await call(commands.lspSnapshotDiagnostics(diff.path, text, request));
  } catch (error) {
    if (isErrorKind(error, "unavailable") || isErrorKind(error, "permissionDenied")) return null;
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
  signal?.throwIfAborted();
  const problems = items.filter((d) => d.severity === "error" || d.severity === "warning");
  if (!problems.length) return null;
  const errors = problems.filter((d) => d.severity === "error").length;
  const first = problems[0]!;
  return {
    errors,
    warnings: problems.length - errors,
    diff: {
      ...diff,
      line: first.range.start.line,
      col: first.range.start.col,
      annotations: problems.map((d) => ({
        side: "right",
        line: d.range.start.line,
        author: d.source ?? d.server ?? "",
        body: d.message,
      })),
    },
  };
}

function summarize(snapshots: Snapshot[], current = { errors: 0, warnings: 0, files: 0 }) {
  return {
    errors: current.errors + snapshots.reduce((total, item) => total + item.errors, 0),
    warnings: current.warnings + snapshots.reduce((total, item) => total + item.warnings, 0),
    files: current.files + snapshots.length,
    workingProblems: current.files,
    diffs: snapshots.map(({ diff }) => diff),
  };
}

export async function analyzeCommit(ctx: CommitCheckContext) {
  const selection = await ctx.selection();
  const files = commitFiles(ctx.included, selection);
  const working = files.filter((f) => f.source === "working").map((f) => f.path);
  const [, snapshots] = await Promise.all([
    analyzeWorkingFiles(working),
    collectSnapshotResults(
      files.filter((f) => f.source !== "working"),
      async (file) => {
        const result = await readCommitFile(file, selection.amend);
        return result.kind === "ready"
          ? analyzeSnapshot(commitFileDiff(file, result.snapshot, 0), result.snapshot.text)
          : null;
      },
    ),
  ]);
  return analysisProblem(summarize(snapshots, ctx.diagnostics(working)));
}

export async function analyzeCommittedChanges(files: readonly CommittedSnapshot[], signal: AbortSignal) {
  const snapshots = await collectSnapshotResults(files, async ({ diff, read }) => {
    const result = await read();
    if (result.kind === "unavailable") throw result.error;
    return result.kind === "text" ? analyzeSnapshot(diff, result.text, signal) : null;
  });
  return analysisProblem(summarize(snapshots));
}

function analysisProblem(analysis: ReturnType<typeof summarize>): CommitCheckResult | null {
  const { errors, warnings, files: n, workingProblems, diffs } = analysis;
  if (errors + warnings === 0) return null;
  const errorCount = errors === 1 ? tx`${errors} error` : tx`${errors} errors`;
  const warningCount = warnings === 1 ? tx`${warnings} warning` : tx`${warnings} warnings`;
  const found = !warnings ? errorCount : !errors ? warningCount : tx`${errorCount} and ${warningCount}`;
  return {
    severity: "error",
    text: n === 1 ? tx`${found} found in ${n} file` : tx`${found} found in ${n} files`,
    fix: {
      label: "Review",
      run: () => {
        if (workingProblems) {
          try {
            toolWindowService().show("problems", true);
          } catch {
            // No Problems tool window.
          }
        }
        if (diffs[0]) return openVcsDiff({ ...diffs[0], chain: diffs });
      },
    },
  };
}
