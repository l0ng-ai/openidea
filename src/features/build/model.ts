/**
 * Pure helpers of the Build tool window: console lines from streamed output,
 * the build → file → message tree, and IDEA's finish summaries.
 */
import type { BuildMessage, BuildResult, Severity } from "@/platform/ipc";

export type BuildStatus = "running" | "success" | "failed" | "cancelled";

export interface ConsoleLine {
  text: string;
  kind: "out" | "err" | "system";
  /** Directory of the step that printed the line (links resolve against it). */
  cwd?: string | null;
}

/** Oldest lines are dropped beyond this (IDEA's console cycle buffer). */
export const MAX_CONSOLE_LINES = 20_000;

/**
 * Appends streamed text (one or more `\n`-terminated lines) to `lines`.
 * `cwd` is the running step's directory (a step may append several chunks).
 */
export function appendOutput(
  lines: ConsoleLine[],
  text: string,
  kind: ConsoleLine["kind"],
  cwd?: string,
): ConsoleLine[] {
  const parts = text.split("\n");
  if (parts.at(-1) === "") parts.pop();
  const next = lines.concat(
    parts.map((t) => ({ text: t.replace(/\r$/, ""), kind, ...(cwd !== undefined ? { cwd } : {}) })),
  );
  return next.length > MAX_CONSOLE_LINES ? next.slice(next.length - MAX_CONSOLE_LINES) : next;
}

export type BuildNode =
  | { kind: "root"; key: string; title: string; status: BuildStatus; errors: number; warnings: number }
  | { kind: "file"; key: string; path: string; messages: BuildMessage[] }
  | { kind: "message"; key: string; message: BuildMessage };

export const ROOT_KEY = "build:root";

const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2, hint: 3 };

const count = (messages: readonly BuildMessage[], s: Severity) => messages.filter((m) => m.severity === s).length;

/** Root node of the tree for the current build. */
export function rootNode(title: string, status: BuildStatus, messages: readonly BuildMessage[]): BuildNode {
  return {
    kind: "root",
    key: ROOT_KEY,
    title,
    status,
    errors: count(messages, "error"),
    warnings: count(messages, "warning"),
  };
}

/** Children of the root: files with messages (errors first), then messages about the build itself. */
export function rootChildren(messages: readonly BuildMessage[]): BuildNode[] {
  const byFile = new Map<string, BuildMessage[]>();
  const general: BuildNode[] = [];
  messages.forEach((m, i) => {
    if (m.path) {
      let list = byFile.get(m.path);
      if (!list) byFile.set(m.path, (list = []));
      list.push(m);
    } else general.push({ kind: "message", key: `build:msg:${i}`, message: m });
  });
  const files: BuildNode[] = [...byFile].map(([path, list]) => ({
    kind: "file",
    key: `build:file:${path}`,
    path,
    messages: [...list].sort(
      (a, b) =>
        (a.range?.start.line ?? 0) - (b.range?.start.line ?? 0) ||
        (a.range?.start.col ?? 0) - (b.range?.start.col ?? 0) ||
        RANK[a.severity] - RANK[b.severity],
    ),
  }));
  const worst = (n: BuildNode) => (n.kind === "file" ? Math.min(...n.messages.map((m) => RANK[m.severity])) : 0);
  files.sort(
    (a, b) => worst(a) - worst(b) || (a.kind === "file" && b.kind === "file" ? a.path.localeCompare(b.path) : 0),
  );
  return [...files, ...general];
}

export function fileChildren(node: Extract<BuildNode, { kind: "file" }>): BuildNode[] {
  return node.messages.map((message, i) => ({ kind: "message", key: `${node.key}\u0000${i}`, message }));
}

/** `450 ms`, `3 s 120 ms`, `1 m 5 s` (IDEA's `StringUtil.formatDuration`). */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  if (total < 1000) return `${total} ms`;
  const m = Math.floor(total / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const rest = total % 1000;
  if (m > 0) return s ? `${m} m ${s} s` : `${m} m`;
  return rest ? `${s} s ${rest} ms` : `${s} s`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Notification / root title text when a build finishes. */
export function finishSummary(result: Pick<BuildResult, "success" | "errors" | "warnings" | "durationMs">): string {
  const duration = formatDuration(result.durationMs ?? 0);
  if (result.success) {
    return result.warnings
      ? `Build completed successfully with ${plural(result.warnings, "warning")} in ${duration}`
      : `Build completed successfully in ${duration}`;
  }
  if (!result.errors) return "Build failed";
  return result.warnings
    ? `Build failed: ${plural(result.errors, "error")}, ${plural(result.warnings, "warning")}`
    : `Build failed: ${plural(result.errors, "error")}`;
}

/** Files that received build diagnostics (to clear before the next build). */
export function messageFiles(messages: readonly BuildMessage[]): string[] {
  return [...new Set(messages.filter((m) => m.path && m.range).map((m) => m.path!))];
}

/** The node with `key` in the tree of `messages` (root excluded). */
export function findNode(messages: readonly BuildMessage[], key: string): BuildNode | undefined {
  for (const c of rootChildren(messages)) {
    if (c.key === key) return c;
    if (c.kind === "file") {
      const hit = fileChildren(c).find((m) => m.key === key);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** The first error in tree order, selected (and navigated to) when a build fails. */
export function firstError(messages: readonly BuildMessage[]): Extract<BuildNode, { kind: "message" }> | undefined {
  for (const c of rootChildren(messages)) {
    const leaves = c.kind === "file" ? fileChildren(c) : [c];
    for (const n of leaves) if (n.kind === "message" && n.message.severity === "error") return n;
  }
  return undefined;
}
