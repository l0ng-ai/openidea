import { describe, expect, it } from "vitest";
import { validateSettings } from "../model/schema";

describe("agent chat settings", () => {
  it("defaults every meter but the cost to on and keeps stored values", () => {
    expect(validateSettings({}).agents).toEqual({
      showContextUsage: true,
      showWorkTime: true,
      showUsageLimits: true,
      showCost: false,
      foldTurns: true,
      smoothText: true,
      thinking: "auto",
      toolCalls: "grouped",
      expandToolOutput: false,
      sendWith: "enter",
      whileRunning: "queue",
      newTaskApprovals: "bypass",
      defaults: {},
      mcpServers: {},
    });
    const stored = validateSettings({ agents: { showUsageLimits: false, showCost: true, showWorkTime: "no" } }).agents;
    expect(stored).toMatchObject({
      showContextUsage: true,
      showWorkTime: true,
      showUsageLimits: false,
      showCost: true,
    });
  });

  it("keeps valid chat choices and per-agent defaults", () => {
    const stored = validateSettings({
      agents: {
        thinking: "collapsed",
        toolCalls: "nope",
        sendWith: "modEnter",
        newTaskApprovals: "ask",
        defaults: { claude: { model: "opus", effort: 3 }, codex: "x" },
      },
    }).agents;
    expect(stored).toMatchObject({
      thinking: "collapsed",
      toolCalls: "grouped",
      sendWith: "modEnter",
      newTaskApprovals: "ask",
      defaults: { claude: { model: "opus" }, codex: {} },
    });
    expect(validateSettings({ agents: { newTaskApprovals: "never" } }).agents.newTaskApprovals).toBe("bypass");
  });
});
