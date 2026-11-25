import { describe, expect, it } from "vitest";
import type { AgentEntry } from "@/bindings";
import { summarizeWork, thoughtDurations, toolDuration, toolRun, workParts } from "./timeline";

const user = (text: string, extra: Partial<Extract<AgentEntry, { type: "user" }>> = {}): AgentEntry => ({
  type: "user",
  text,
  attachments: [],
  sentMs: 1000,
  doneMs: 5000,
  ...extra,
});
const tool = (kind: string, extra: Partial<Extract<AgentEntry, { type: "tool" }>> = {}): AgentEntry => ({
  type: "tool",
  id: kind,
  title: kind,
  kind,
  status: "completed",
  locations: [],
  output: null,
  diffs: [],
  ...extra,
});

describe("summarizeWork", () => {
  it("counts tool calls by what they did and edits by file", () => {
    const s = summarizeWork([
      { type: "thought", text: "hmm" },
      tool("read"),
      tool("read"),
      tool("search"),
      tool("edit", { diffs: [{ path: "/a.ts", added: 3, removed: 1 }] }),
      tool("edit", { diffs: [{ path: "/a.ts", added: 2, removed: 0 }] }),
      tool("edit", { locations: ["/b.ts"] }),
      tool("execute", { title: "git status" }),
      tool("execute", { title: "pnpm test" }),
      tool("mcp_custom"),
    ]);
    expect(s).toMatchObject({ thoughts: 1, read: 2, search: 1, edited: 2, run: 2, other: 1, added: 5, removed: 1 });
    expect(workParts(s)).toEqual([
      { text: "Edited {count} files", count: 2 },
      { text: "Ran {count} commands", count: 2 },
      { text: "Read {count} files", count: 2 },
      { text: "Searched once", count: 1 },
      { text: "1 other tool call", count: 1 },
    ]);
  });
});

// Fragments of a real Hermes 0.22.2 ACP stream (`hermes acp`), as the timeline folds them.
describe("Hermes tool calls", () => {
  type Tool = Extract<AgentEntry, { type: "tool" }>;
  const call = (kind: string, extra: Partial<Tool> = {}) => tool(kind, extra) as Tool;
  const terminal = call("execute", {
    title: "terminal: echo ok + 2 commands",
    output:
      "$ echo ok >> notes.txt && wc -l notes.txt && cat notes.txt\n" +
      "terminal result\n- **output:** 3 notes.txt\nline1\nline2\nok\n- **exit_code:** 0",
    startedMs: 1000,
    endedMs: 2400,
  });

  it("splits a terminal call into its command, output and exit code", () => {
    expect(toolRun(terminal)).toEqual({
      command: "echo ok >> notes.txt && wc -l notes.txt && cat notes.txt",
      output: "3 notes.txt\nline1\nline2\nok",
      exitCode: 0,
    });
    expect(toolRun({ ...terminal, output: "$ false\nterminal result\n- **output:**\n- **exit_code:** 1" })).toEqual({
      command: "false",
      output: "",
      exitCode: 1,
    });
  });

  it("keeps plain output of other agents as it is", () => {
    expect(toolRun(call("execute", { output: "ok" }))).toEqual({ command: null, output: "ok", exitCode: null });
  });

  it("times a call once it ended", () => {
    expect(toolDuration(terminal)).toBe(1400);
    expect(toolDuration({ ...terminal, endedMs: null })).toBeNull();
    expect(toolDuration(call("read"))).toBeNull();
  });

  it("times each thought until what came next or the end of its turn", () => {
    const entries: AgentEntry[] = [
      user("go", { doneMs: 9000 }),
      { type: "thought", text: "plan", startedMs: 1000 },
      tool("search", { startedMs: 2500 }),
      { type: "thought", text: "done", startedMs: 6000 },
      { type: "agent", text: "ok" },
      { type: "thought", text: "old" },
    ];
    expect([...thoughtDurations(entries)]).toEqual([
      [1, 1500],
      [3, 3000],
    ]);
  });
});
