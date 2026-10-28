/** Pure helpers: task grouping, entry updates, labels. */
import type { AgentEntry, AgentStatus, AgentSubagentStatus, AgentTask } from "@/bindings";

export const SESSION_KIND = "agent-session";
export const HOME_KIND = "agent-home";
export const HOME_KEY = "agent:new";
export const TOOL_WINDOW = "agents";

export const sessionKey = (task: string) => `agent:${task}`;

/** Key of a conversation in the entries store: the task's own, or its subagent `subagent`'s. */
export const entriesKey = (task: string, subagent: string | null) => (subagent ? `${task}/${subagent}` : task);

export type SubagentEntry = Extract<AgentEntry, { type: "subagent" }>;

/** The card of subagent `id` in its parent's `entries`. */
export const findSubagent = (entries: AgentEntry[] | undefined, id: string) =>
  entries?.find((e): e is SubagentEntry => e.type === "subagent" && e.id === id);

export const subagentWorking = (s: AgentSubagentStatus) => s === "running" || s === "needsInput";

/** "Explore", else what it was started for. */
export const subagentTitle = (e: SubagentEntry) => e.title ?? e.description ?? "Subagent";

export function subagentStatusLabel(s: AgentSubagentStatus): string {
  switch (s) {
    case "running":
      return "Running";
    case "needsInput":
      return "Needs input";
    case "done":
      return "Done";
    case "cancelled":
      return "Stopped";
    case "failed":
      return "Failed";
  }
}

const PROVIDER_ICONS = new Set(["claude", "codex", "gemini", "copilot", "cursor", "opencode", "qwen", "kimi", "goose", "auggie", "kiro", "vibe"]);

/** The agent's logo; custom agents get the generic agents icon. */
export const providerIcon = (provider: string) =>
  PROVIDER_ICONS.has(provider) ? `agent-${provider}` : "toolwindow-agents";

export interface TaskGroup {
  status: "needsInput" | "failed" | "running" | "ready" | "archived";
  label: string;
  tasks: AgentTask[];
}

/** Groups in attention order: what waits for the user comes first. */
const GROUPS: Array<[TaskGroup["status"], string, AgentStatus[]]> = [
  ["needsInput", "Needs Input", ["needsInput"]],
  ["failed", "Failed", ["failed"]],
  ["running", "Running", ["running", "starting"]],
  ["ready", "Ready to Review", ["ready"]],
  ["archived", "Archived", ["archived"]],
];

export function groupTasks(tasks: Iterable<AgentTask>): TaskGroup[] {
  const sorted = [...tasks].sort((a, b) => (b.updatedMs ?? 0) - (a.updatedMs ?? 0));
  return GROUPS.map(([status, label, members]) => ({
    status,
    label,
    tasks: sorted.filter((t) => members.includes(t.status)),
  })).filter((g) => g.tasks.length > 0);
}

export const isBusy = (s: AgentStatus) => s === "running" || s === "starting" || s === "needsInput";

/** `entries` with `entry` at `index` (appended when `index` is the length; gaps wait for a reload). */
export function upsertEntry(entries: AgentEntry[], index: number, entry: AgentEntry): AgentEntry[] | null {
  if (index > entries.length) return null;
  const next = entries.slice();
  next[index] = entry;
  return next;
}

/** "agent/fix-lexer" → "fix-lexer". */
export const branchLabel = (branch: string | null) => (branch ?? "").replace(/^agent\//, "");

export function statusLabel(s: AgentStatus): string {
  switch (s) {
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "needsInput":
      return "Needs input";
    case "ready":
      return "Ready";
    case "failed":
      return "Failed";
    case "archived":
      return "Archived";
  }
}

/** "3m", "2h", "5d" since `ms`. */
export function age(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** The status change worth a notification, if any. */
export function attentionChange(prev: AgentStatus | undefined, next: AgentStatus): "finished" | "failed" | "input" | null {
  if (prev === next || prev === undefined) return null;
  if (next === "needsInput") return "input";
  if (!isBusy(prev)) return null;
  if (next === "ready") return "finished";
  if (next === "failed") return "failed";
  return null;
}
