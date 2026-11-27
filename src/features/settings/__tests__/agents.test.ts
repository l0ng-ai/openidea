import { describe, expect, it } from "vitest";
import { validateSettings } from "../model/schema";

describe("agent chat settings", () => {
  it("defaults every meter but the cost to on and keeps stored values", () => {
    expect(validateSettings({}).agents).toEqual({
      showContextUsage: true,
      showWorkTime: true,
      showUsageLimits: true,
      showCost: false,
      smoothText: true,
      fitWindowWidth: false,
      thinking: "auto",
      toolCalls: "grouped",
      expandToolOutput: false,
      sendWith: "enter",
      whileRunning: "queue",
      newTaskApprovals: "bypass",
      chatUseUiFont: true,
      chatFontFamily: "Inter",
      chatFontFallback: "",
      chatFontSize: 13,
      codeUseDefaultFont: true,
      codeFontFamily: "JetBrains Mono",
      codeFontFallback: "",
      codeFontSize: 13,
      defaults: {},
      mcpServers: {},
      skills: {},
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
    const fonts = validateSettings({
      agents: { chatUseUiFont: false, chatFontFamily: "Maple Mono NF CN", chatFontSize: 16, codeFontSize: 999 },
    }).agents;
    expect(fonts).toMatchObject({ chatUseUiFont: false, chatFontFamily: "Maple Mono NF CN", chatFontSize: 16 });
    expect(fonts.codeFontSize).toBe(72);
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
