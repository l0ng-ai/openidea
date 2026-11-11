/**
 * What a run of the agent's work amounts to, and which finished turns fold away. Pure:
 * the conversation renders the rows these describe.
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
 * The parts of a summary line, most telling first: "Read 4 files", "Edited 2 files"… The
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

/** A finished turn: the message that asked it at `user`, its work in `[user + 1, reply)`. */
export interface FoldedTurn {
  user: number;
  /** Index of the reply that stays in view; the turn's work comes before it. */
  reply: number;
  sentMs: number | null;
  doneMs: number | null;
}

/**
 * The finished turns whose work before their last reply folds into one line. A turn
 * folds when it has ended, ended with a reply, and did something before that reply (and
 * neither the user sent anything into it nor it ran into an error meanwhile); the
 * latest turn stays open while the agent works. Turns asked before `from` aren't shown
 * and so don't fold.
 */
export function foldedTurns(entries: readonly AgentEntry[], from: number, busy: boolean): Map<number, FoldedTurn> {
  const turns = new Map<number, FoldedTurn>();
  const starts: number[] = [];
  entries.forEach((e, i) => {
    if (e.type === "user" && !e.steered && i >= from) starts.push(i);
  });
  starts.forEach((user, k) => {
    const end = starts[k + 1] ?? entries.length;
    const last = k === starts.length - 1;
    if (last && busy) return;
    const asked = entries[user] as Extract<AgentEntry, { type: "user" }>;
    let reply = -1;
    for (let i = end - 1; i > user; i--) {
      const e = entries[i]!;
      if (e.type === "agent" && e.text.trim()) {
        reply = i;
        break;
      }
      // Something after the reply still wants to be seen (an error, an open question).
      if (e.type === "error" || (e.type === "permission" && e.chosen === null)) return;
    }
    if (reply < 0 || reply === user + 1) return;
    // What the user sent into the turn, and an error it ran into, stay in view.
    if (entries.slice(user + 1, reply).some((e) => e.type === "user" || e.type === "error")) return;
    turns.set(user, { user, reply, sentMs: asked.sentMs ?? null, doneMs: asked.doneMs ?? null });
  });
  return turns;
}
