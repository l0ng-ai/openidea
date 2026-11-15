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
      fitWindowWidth: false,
      playfulStatus: false,
      playfulAfterSeconds: 0,
      playfulWords: {},
      thinking: "auto",
      toolCalls: "grouped",
      expandToolOutput: false,
      sendWith: "enter",
      whileRunning: "queue",
      newTaskApprovals: "bypass",
      defaults: {},
      mcpServers: {},
    });
    const stored = validateSettings({
      agents: { showUsageLimits: false, showCost: true, showWorkTime: "no", fitWindowWidth: true },
    }).agents;
    expect(stored).toMatchObject({
      showContextUsage: true,
      showWorkTime: true,
      showUsageLimits: false,
      showCost: true,
      fitWindowWidth: true,
    });
    expect(validateSettings({ agents: { fitWindowWidth: "yes" } }).agents.fitWindowWidth).toBe(false);
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

  it("keeps the user's playful words by activity, an emptied list included", () => {
    const stored = validateSettings({
      agents: { playfulWords: { reading: ["Squinting…", " ", 3], working: [], editing: "nope" } },
    }).agents;
    expect(stored.playfulWords).toEqual({ reading: ["Squinting…"], working: [] });
  });

  it("keeps the playful quiet time in whole seconds within its range", () => {
    const after = (v: unknown) => validateSettings({ agents: { playfulAfterSeconds: v } }).agents.playfulAfterSeconds;
    expect(after(0)).toBe(0);
    expect(after(2.6)).toBe(3);
    expect(after(-5)).toBe(0);
    expect(after(100_000)).toBe(600);
    expect(after("soon")).toBe(0);
  });
});
