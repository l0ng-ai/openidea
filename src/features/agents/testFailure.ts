/** "Diagnose with Agent" on a failed test: its failure as an editable draft for the agent. */
import { tx } from "@/platform/i18n";
import { appendToComposer } from "./store";

/** The `arg` of `agents.diagnoseTestFailure`, from the run's test tree. */
export interface TestFailure {
  name: string;
  /** The test's source file (absolute), when the run could resolve it. */
  path?: string | null;
  /** 1-based. */
  line?: number;
  expected?: string;
  actual?: string;
  /** What the run captured for this test: its output and failure details. */
  output: readonly string[];
}

/** Excerpt lines kept in the draft; the rest is counted. */
export const EXCERPT_LINES = 60;

export function isTestFailure(arg: unknown): arg is TestFailure {
  const a = arg as Partial<TestFailure> | null;
  return !!a && typeof a.name === "string" && Array.isArray(a.output);
}

/** The draft text; `location` is the source reference (`@path:line`), if any. */
export function failureDraft(failure: TestFailure, location: string | undefined): string {
  const parts = [tx`The test ${failure.name} failed. Help me find out why.`];
  if (location) parts.push(tx`Test source: ${location}`);
  if (failure.expected !== undefined && failure.actual !== undefined)
    parts.push(`${tx("Expected:")} ${failure.expected}\n${tx("Actual:")} ${failure.actual}`);
  const lines = failure.output.map((l) => l.trimEnd());
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines.at(-1)) lines.pop();
  if (lines.length) {
    const shown = lines.slice(0, EXCERPT_LINES);
    const more = lines.length - shown.length;
    if (more > 0) shown.push(tx`… ${more} more lines`);
    // A fence longer than any backtick run inside keeps the excerpt in one block.
    const longest = Math.max(0, ...shown.map((l) => l.match(/`+/g)?.reduce((m, r) => Math.max(m, r.length), 0) ?? 0));
    const fence = "`".repeat(Math.max(3, longest + 1));
    parts.push(`${fence}\n${shown.join("\n")}\n${fence}`);
  }
  return parts.join("\n\n");
}

/** Appends the failure to the agent message typed last and opens it; the user reviews it and sends it. */
export function diagnoseTestFailure(failure: TestFailure): void {
  const target = failure.path
    ? [{ path: failure.path, lines: failure.line ? { from: failure.line, to: failure.line } : undefined }]
    : [];
  appendToComposer((mentions) => failureDraft(failure, mentions[0]), target);
}
