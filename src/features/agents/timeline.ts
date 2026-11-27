/**
 * What a run of the agent's work amounts to. Pure: the conversation renders the rows these
 * describe.
 */
import type { AgentEntry } from "@/bindings";

type ToolEntry = Extract<AgentEntry, { type: "tool" }>;

/** Tool calls of a run counted by what they did; edits count the files they changed. */
export interface WorkSummary {
  thoughts: number;
  read: number;
  search: number;
  edited: number;
  run: number;
  fetch: number;
  other: number;
  added: number;
  removed: number;
  subagents: number;
}

export function summarizeWork(entries: Iterable<AgentEntry>): WorkSummary {
  const s: WorkSummary = {
    thoughts: 0,
    read: 0,
    search: 0,
    edited: 0,
    run: 0,
    fetch: 0,
    other: 0,
    added: 0,
    removed: 0,
    subagents: 0,
  };
  const edited = new Set<string>();
  for (const e of entries) {
    if (e.type === "thought") s.thoughts++;
    else if (e.type === "subagent") s.subagents++;
    else if (e.type === "tool") countTool(s, e, edited);
  }
  s.edited = edited.size;
  return s;
}

function countTool(s: WorkSummary, e: ToolEntry, edited: Set<string>) {
  for (const d of e.diffs) {
    edited.add(d.path);
    s.added += d.added;
    s.removed += d.removed;
  }
  switch (e.kind) {
    case "read":
      s.read++;
      break;
    case "search":
      s.search++;
      break;
    case "execute":
      s.run++;
      break;
    case "fetch":
      s.fetch++;
      break;
    case "edit":
    case "delete":
    case "move":
      if (!e.diffs.length) e.locations.forEach((l) => edited.add(l));
      break;
    case "think":
      break;
    default:
      s.other++;
  }
}

/**
 * The parts of a summary line, most telling first: "Edited 2 files", "Ran 3 commands"… The
 * caller translates each with its count.
 */
export function workParts(s: WorkSummary): Array<{ text: string; count: number }> {
  const parts: Array<[string, string, number]> = [
    ["Edited 1 file", "Edited {count} files", s.edited],
    ["Ran 1 command", "Ran {count} commands", s.run],
    ["Read 1 file", "Read {count} files", s.read],
    ["Searched once", "Searched {count} times", s.search],
    ["Fetched 1 page", "Fetched {count} pages", s.fetch],
    ["1 subagent", "{count} subagents", s.subagents],
    ["1 other tool call", "{count} other tool calls", s.other],
  ];
  return parts.filter(([, , n]) => n > 0).map(([one, many, count]) => ({ text: count === 1 ? one : many, count }));
}

/** A command a tool ran and how it ended, read from its output (Hermes: `$ cmd`, `- **exit_code:** 0`). */
export interface ToolRun {
  command: string | null;
  output: string;
  exitCode: number | null;
}

/** Splits an `execute` tool's text into its command, output and exit code, where it names them. */
export function toolRun(entry: ToolEntry): ToolRun {
  const text = entry.output ?? "";
  const command = /^\$ (.+)$/m.exec(text)?.[1] ?? null;
  const code = /^- \*\*exit_code:\*\* (-?\d+)\s*$/m.exec(text);
  const output = /^- \*\*output:\*\* ?([\s\S]*?)(?=^- \*\*exit_code:\*\*|(?![\s\S]))/m.exec(text)?.[1];
  return {
    command,
    output: (output ?? (command ? text.replace(`$ ${command}`, "") : text)).trim(),
    exitCode: code ? Number(code[1]) : null,
  };
}

/** How long a tool call took, once it ended; `null` while it runs or when its times aren't known. */
export function toolDuration(entry: ToolEntry): number | null {
  const { startedMs, endedMs } = entry;
  return startedMs != null && endedMs != null ? Math.max(0, endedMs - startedMs) : null;
}

/**
 * How long each finished thought took, by index: from its start to the start of what came
 * next that keeps time (a tool call, another thought) or else the end of its turn.
 */
export function thoughtDurations(entries: readonly AgentEntry[]): Map<number, number> {
  const out = new Map<number, number>();
  let open: { index: number; started: number } | null = null;
  let turnEnd: number | null = null;
  // An untimed entry (older history) says nothing about when the open thought ended.
  const close = (at: number | null | undefined) => {
    if (at == null) return;
    if (open) out.set(open.index, Math.max(0, at - open.started));
    open = null;
  };
  entries.forEach((e, i) => {
    if (e.type === "user" && !e.steered) {
      close(turnEnd);
      open = null;
      turnEnd = e.doneMs ?? null;
    } else if (e.type === "tool") close(e.startedMs);
    else if (e.type === "thought" && e.startedMs != null) {
      close(e.startedMs);
      open = { index: i, started: e.startedMs };
    }
  });
  close(turnEnd);
  return out;
}
