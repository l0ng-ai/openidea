import { describe, expect, it } from "vitest";
import type { AgentEntry } from "@/bindings";
import { foldedTurns } from "../timeline";
import { conversationRows, foldTurnRows, rowEntries, sameRow } from "./conversationRows";

const user = (text: string): AgentEntry => ({
  type: "user",
  text,
  attachments: [],
  steered: false,
  sentMs: 1000,
  doneMs: 5000,
});
const agent = (text: string): AgentEntry => ({ type: "agent", text });
const tool = (id: string, kind = "read", added = 0): AgentEntry => ({
  type: "tool",
  id,
  title: id,
  kind,
  status: "completed",
  locations: [],
  output: null,
  diffs: added ? [{ path: `/${id}.ts`, added, removed: 0 }] : [],
});

const rowsOf = (entries: AgentEntry[]) => {
  const rows = conversationRows(entries, 0);
  return foldTurnRows(rows, foldedTurns(entries, 0));
};

describe("conversationRows", () => {
  it("groups consecutive read-only exploration entries and keeps edits and commands separate", () => {
    const entries: AgentEntry[] = [
      user("a"),
      { type: "thought", text: "inspect" },
      tool("r1", "read"),
      tool("s1", "search"),
      tool("e1", "edit", 3),
      tool("cmd1", "execute"),
      tool("f1", "fetch"),
      tool("r2", "read"),
      agent("done"),
    ];
    const rows = conversationRows(entries, 0);
    expect(rows.map((row) => row.kind)).toEqual(["entry", "process", "entry", "entry", "process", "entry"]);
    expect(rows[1]!.kind === "process" ? rows[1]!.entries.length : 0).toBe(3);
    expect(rows[4]!.kind === "process" ? rows[4]!.entries.length : 0).toBe(2);
  });

  it("flattens grouped runs inside a folded turn to avoid nested folds", () => {
    const entries: AgentEntry[] = [
      user("a"),
      tool("r1", "read"),
      tool("r2", "search"),
      tool("e1", "edit", 2),
      agent("done"),
      user("b"),
      agent("next"),
    ];
    const rows = rowsOf(entries);
    const turn = rows[1]!;
    expect(turn.kind).toBe("turn");
    if (turn.kind === "turn") {
      expect(turn.rows.map((r) => r.kind)).toEqual(["entry", "entry", "entry"]);
    }
  });
});

describe("sameRow", () => {
  const entries = [user("a"), tool("t1", "edit"), tool("t2", "edit"), agent("done"), user("b"), agent("streaming")];

  it("sees the rows of the same conversation as the same, whichever copy it was built from", () => {
    const again = rowsOf(entries);
    expect(again.map((row) => row.kind)).toEqual(["entry", "turn", "entry", "entry", "entry"]);
    rowsOf(entries).forEach((row, i) => expect(sameRow(row, again[i]!)).toBe(true));
  });

  it("leaves the rows a streamed chunk did not touch the same and the grown one different", () => {
    const before = rowsOf(entries);
    const after = rowsOf([...entries.slice(0, -1), agent("streaming on")]);
    expect(after.map((row, i) => sameRow(before[i]!, row))).toEqual([true, true, true, true, false]);
  });

  it("tells a turn whose work changed from one whose work did not", () => {
    const [, turn] = rowsOf(entries);
    const [, edited] = rowsOf([entries[0]!, tool("t1", "edit"), tool("t2", "edit", 7), ...entries.slice(3)]);
    expect(sameRow(turn!, edited!)).toBe(false);
  });

  it("tells a run that gained a call from the run before", () => {
    const run = conversationRows([user("a"), tool("t1", "read"), tool("t2", "read")], 0)[1]!;
    const longer = conversationRows([user("a"), tool("t1", "read"), tool("t2", "read"), tool("t3", "read")], 0)[1]!;
    expect(run.kind).toBe("process");
    expect(sameRow(run, longer)).toBe(false);
  });

  it("tells rows of different places apart even when they hold the same entry", () => {
    const shared = agent("same");
    expect(sameRow(conversationRows([shared], 0)[0]!, conversationRows([user("x"), shared], 1)[0]!)).toBe(false);
  });

  it("tells a turn that finished at another time from the turn before", () => {
    const later = [{ ...(entries[0] as Extract<AgentEntry, { type: "user" }>), doneMs: 9000 }, ...entries.slice(1)];
    expect(sameRow(rowsOf(entries)[1]!, rowsOf(later)[1]!)).toBe(false);
  });
});

describe("rowEntries", () => {
  it("lists the entries a folded turn paints, work first", () => {
    const entries = [user("a"), tool("t1"), tool("t2"), agent("done")];
    const [, turn] = rowsOf(entries);
    expect(rowEntries(turn!)).toEqual([entries[1], entries[2]]);
  });
});
