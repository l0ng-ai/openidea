/**
 * Problems tool window under a diagnostics storm: a workspace of 2,000 files with 30,000
 * diagnostics, then 200 single-file updates, each rendered by the mounted header tabs and list.
 * One sample is the time for all 200 updates; prints each sample and the median.
 * Skipped unless asked for:
 *
 *   PROBLEMS_BENCH=1 pnpm vitest run src/features/code-insight/problemsStorm.bench.test.tsx --silent=false
 */
import { act, render } from "@testing-library/react";
import { describe, it } from "vitest";
import type { Diagnostic, Severity } from "@/bindings";
import { ProblemsTabs, ProblemsView, useProblemsView } from "./ProblemsView";
import { applyDiagnosticsEvent, clearProblems } from "./problemsStore";

const FILES = 2000;
const LSP_PER_FILE = 10;
const LINT_PER_FILE = 5;
const UPDATES = 200;

let seed = 1;
const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const SEVERITIES: Severity[] = ["error", "warning", "warning", "info", "hint"];

function diagnostics(count: number, salt: number): Diagnostic[] {
  return Array.from({ length: count }, (_, i) => {
    const line = Math.floor(random() * 400);
    const col = Math.floor(random() * 80);
    return {
      range: { start: { line, col }, end: { line, col: col + 4 } },
      severity: SEVERITIES[(i + salt) % SEVERITIES.length]!,
      message: `Problem ${Math.floor(random() * 500)} near symbol${salt}_${i}`,
      source: null,
      code: null,
    } as Diagnostic;
  });
}

const paths = Array.from({ length: FILES }, (_, i) => `/p/src/module${i % 40}/File${i}.ts`);
const initial = paths.map((path, i) => ({
  path,
  lsp: diagnostics(LSP_PER_FILE, i),
  lint: diagnostics(LINT_PER_FILE, i + 1),
}));
const updates = Array.from({ length: UPDATES }, (_, k) => ({
  path: paths[Math.floor(random() * FILES)]!,
  items: diagnostics(LSP_PER_FILE, k + 7),
}));

function loadWorkspace() {
  clearProblems();
  for (const f of initial) {
    applyDiagnosticsEvent(f.path, "lsp", f.lsp);
    applyDiagnosticsEvent(f.path, "eslint", f.lint);
  }
}

function storm(tab: "file" | "project") {
  loadWorkspace();
  useProblemsView.setState({ tab });
  const view = render(
    <>
      <ProblemsTabs />
      <ProblemsView />
    </>,
  );
  // Only the updates are timed, not loading the workspace or the first render.
  const start = performance.now();
  for (const u of updates) act(() => applyDiagnosticsEvent(u.path, "lsp", u.items));
  const ms = performance.now() - start;
  view.unmount();
  return ms;
}

const RUNS = 7;

function measure(tab: "file" | "project") {
  storm(tab); // warm-up
  const samples = Array.from({ length: RUNS }, () => storm(tab)).sort((a, b) => a - b);
  const median = samples[RUNS >> 1]!;
  console.log(
    `${tab} tab: median ${median.toFixed(1)} ms per ${UPDATES} updates (${(median / UPDATES).toFixed(2)} ms/update); ` +
      `samples ${samples.map((s) => s.toFixed(1)).join(", ")}`,
  );
}

describe.skipIf(!process.env.PROBLEMS_BENCH)(
  `Problems: ${FILES} files, ${FILES * (LSP_PER_FILE + LINT_PER_FILE)} diagnostics, ${UPDATES} single-file updates`,
  () => {
    it("Project Errors tab", () => measure("project"), 600_000);
    it("File tab", () => measure("file"), 600_000);
  },
);
