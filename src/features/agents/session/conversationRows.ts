import type { AgentEntry } from "@/bindings";
import { type FoldedTurn } from "../timeline";

export type ToolEntryData = Extract<AgentEntry, { type: "tool" }>;

/** An entry and its index in the whole conversation (not in the painted tail). */
export type IndexedEntry = { index: number; entry: AgentEntry };

/** A row of the conversation: an entry, or a run of reasoning/tool calls folded together. */
export type ConversationRow =
  | { kind: "entry"; index: number; entry: AgentEntry }
  | { kind: "process"; index: number; entries: IndexedEntry[] }
  /** A finished turn's work before its reply, folded into one line under its message. */
  | { kind: "turn"; index: number; turn: FoldedTurn; rows: ConversationRow[] };

export type EntryRow = Extract<ConversationRow, { kind: "entry" }>;

export const liveTool = (entry: AgentEntry) =>
  entry.type === "tool" && (entry.status === "running" || entry.status === "pending");

/**
 * Reasoning and tool calls fold together, running ones included: the run keeps its place while
 * a call finishes, and its summary line says what is running.
 */
export const isProcessEntry = (entry: AgentEntry) => entry.type === "thought" || entry.type === "tool";

/**
 * The conversation's rows from `from`: a run of reasoning and finished tool calls becomes
 * one folded row (the work behind a decision), so messages and decisions stay readable.
 */
export function conversationRows(entries: readonly AgentEntry[], from: number, group = true): ConversationRow[] {
  if (!group) return entries.slice(from).map((entry, i) => ({ kind: "entry", index: from + i, entry }));
  const rows: ConversationRow[] = [];
  let run: IndexedEntry[] = [];
  const flush = () => {
    if (run.length > 1) rows.push({ kind: "process", index: run[0]!.index, entries: run });
    else if (run.length === 1) rows.push({ kind: "entry", ...run[0]! });
    run = [];
  };
  entries.slice(from).forEach((entry, i) => {
    if (isProcessEntry(entry)) run.push({ index: from + i, entry });
    else {
      flush();
      rows.push({ kind: "entry", index: from + i, entry });
    }
  });
  flush();
  return rows;
}

/** `rows` with the work of each turn in `turns` (keyed by its message) folded into one row. */
export function foldTurnRows(rows: ConversationRow[], turns: ReadonlyMap<number, FoldedTurn>): ConversationRow[] {
  if (!turns.size) return rows;
  const out: ConversationRow[] = [];
  let open: Extract<ConversationRow, { kind: "turn" }> | null = null;
  for (const row of rows) {
    if (open && row.index < open.turn.reply) {
      open.rows.push(row);
      continue;
    }
    open = null;
    out.push(row);
    const turn = row.kind === "entry" ? turns.get(row.index) : undefined;
    if (turn) {
      open = { kind: "turn", index: row.index + 1, turn, rows: [] };
      out.push(open);
    }
  }
  return out;
}
