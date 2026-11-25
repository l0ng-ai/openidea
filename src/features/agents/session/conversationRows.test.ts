import { describe, expect, it } from "vitest";
import type { AgentEntry } from "@/bindings";
import { summarizeWork } from "../timeline";
import { conversationRows, rowEntries, sameRow } from "./conversationRows";

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

describe("conversationRows", () => {
  it("groups consecutive reasoning, exploration, edits and commands into one run", () => {
    const entries: AgentEntry[] = [
      user("a"),
      { type: "thought", text: "inspect" },
      tool("r1", "read"),
      tool("s1", "search"),
      tool("e1", "edit", 3),
      tool("cmd1", "execute"),
      tool("cmd2", "execute"),
      agent("done"),
    ];
    const rows = conversationRows(entries, 0);
    expect(rows.map((row) => row.kind)).toEqual(["entry", "process", "entry"]);
    expect(rows[1]!.kind === "process" ? rows[1]!.entries.length : 0).toBe(6);
    const work = summarizeWork(rowEntries(rows[1]!));
    expect([work.edited, work.run, work.read, work.search]).toEqual([1, 2, 1, 1]);
  });

  it("keeps direct composer shell commands separate from grouped runs", () => {
    const entries: AgentEntry[] = [
      user("a"),
      tool("r1", "read"),
      tool("shell-1", "execute"),
      tool("cmd1", "execute"),
      tool("cmd2", "execute"),
      agent("done"),
    ];
    const rows = conversationRows(entries, 0);
    expect(rows.map((row) => row.kind)).toEqual(["entry", "entry", "entry", "process", "entry"]);
    expect(rows[3]!.kind === "process" ? rows[3]!.entries.map((e) => e.index) : []).toEqual([3, 4]);
  });
});

describe("sameRow", () => {
  const entries = [user("a"), tool("t1", "edit"), tool("t2", "execute"), agent("done"), user("b"), agent("streaming")];

  it("sees the rows of the same conversation as the same, whichever copy it was built from", () => {
    const again = conversationRows(entries, 0);
    expect(again.map((row) => row.kind)).toEqual(["entry", "process", "entry", "entry", "entry"]);
    conversationRows(entries, 0).forEach((row, i) => expect(sameRow(row, again[i]!)).toBe(true));
  });

  it("leaves the rows a streamed chunk did not touch the same and the grown one different", () => {
    const before = conversationRows(entries, 0);
    const after = conversationRows([...entries.slice(0, -1), agent("streaming on")], 0);
    expect(after.map((row, i) => sameRow(before[i]!, row))).toEqual([true, true, true, true, false]);
  });

  it("tells a run whose entry changed from one whose entries did not", () => {
    const [, run] = conversationRows(entries, 0);
    const [, edited] = conversationRows(
      [entries[0]!, tool("t1", "edit"), tool("t2", "edit", 7), ...entries.slice(3)],
      0,
    );
    expect(sameRow(run!, edited!)).toBe(false);
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
});

describe("rowEntries", () => {
  it("lists the entries a process row paints, in order", () => {
    const entries = [user("a"), tool("t1"), tool("t2"), agent("done")];
    const [, run] = conversationRows(entries, 0);
    expect(rowEntries(run!)).toEqual([entries[1], entries[2]]);
  });
});
