import type { AgentEntry } from "@/bindings";

export type ToolEntryData = Extract<AgentEntry, { type: "tool" }>;

/** An entry and its index in the whole conversation (not in the painted tail). */
export type IndexedEntry = { index: number; entry: AgentEntry };

/** A row of the conversation: an entry, or a run of reasoning/tool calls folded together. */
export type ConversationRow =
  | { kind: "entry"; index: number; entry: AgentEntry }
  | { kind: "process"; index: number; entries: IndexedEntry[] };

export type EntryRow = Extract<ConversationRow, { kind: "entry" }>;
export type ProcessRow = Extract<ConversationRow, { kind: "process" }>;

export const liveTool = (entry: AgentEntry) =>
  entry.type === "tool" && (entry.status === "running" || entry.status === "pending");

/**
 * Reasoning and tool calls fold together, running calls included: the run keeps its place while
 * a call finishes, and its summary line says what is running. Direct `!` shell commands stay on
 * their own row so their output remains open.
 */
export const isProcessEntry = (entry: AgentEntry) =>
  entry.type === "thought" || (entry.type === "tool" && !entry.id.startsWith("shell-"));

/**
 * The conversation's rows from `from`: a run of reasoning and tool calls becomes one folded row
 * (the work behind a decision), so messages and decisions stay readable.
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

/** The entries a row paints, in order. */
export function rowEntries(row: ConversationRow): AgentEntry[] {
  return row.kind === "process" ? row.entries.map(({ entry }) => entry) : [row.entry];
}

/**
 * Whether two rows paint the same entries. Rows are rebuilt for every streamed chunk: a row's
 * identity says nothing, and only the one the chunk grew differs.
 */
export function sameRow(a: ConversationRow, b: ConversationRow): boolean {
  if (a === b) return true;
  if (a.index !== b.index) return false;
  switch (a.kind) {
    case "entry":
      return b.kind === "entry" && a.entry === b.entry;
    case "process":
      return (
        b.kind === "process" &&
        a.entries.length === b.entries.length &&
        a.entries.every(({ entry }, i) => entry === b.entries[i]!.entry)
      );
  }
}
