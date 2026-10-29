import { afterEach, describe, expect, it, vi } from "vitest";
import { FIT_INTERVAL_MS, PROCESS_RESIZE_DELAY_MS, fitScheduler, settledResize } from "./fit";
import { isAllowedIdeShortcut, terminalKeyAction } from "./keys";
import { matchCounter } from "./FindBar";
import { buildSearchDecorations } from "./theme";
import { findTerminalLinks, resolvePath, trimUrl } from "./links";
import {
  layoutPanes,
  nextTabName,
  removeFromLayout,
  splitLayout,
  tabFullTitle,
  tabTitle,
  trimMiddle,
  type TerminalTab,
} from "./store";
import type { SessionSnapshot } from "./session";
import { buildTheme, mix, parseColor, terminalFont, toHex } from "./theme";

describe("theme", () => {
  it("parses colour formats", () => {
    expect(parseColor("#0f1012")).toEqual([15, 16, 18, 1]);
    expect(parseColor("#fff")).toEqual([255, 255, 255, 1]);
    expect(parseColor("#00000080")?.[3]).toBeCloseTo(0.5, 2);
    expect(parseColor("rgb(1, 2, 3)")).toEqual([1, 2, 3, 1]);
    expect(parseColor("rgba(1 2 3 / 50%)")).toEqual([1, 2, 3, 0.5]);
    expect(parseColor("color(srgb 1 0 0.5)")).toEqual([255, 0, 127.5, 1]);
    expect(parseColor("var(--x)")).toBeNull();
  });

  it("mixes and formats", () => {
    expect(toHex(mix([0, 0, 0, 1], [255, 255, 255, 1], 0.5))).toBe("#808080");
  });

  it("derives a full palette from tokens", () => {
    const tokens: Record<string, string> = {
      "--bg-app": "#0f1012",
      "--fg": "#b9bbc1",
      "--fg-strong": "#e2e3e6",
      "--accent": "#8fa5d6",
      "--danger": "#c97a6f",
      "--success": "#8fae7e",
      "--warning": "#c9a35f",
      "--syn-keyword": "#8fa5d6",
      "--syn-annotation": "#a89bc4",
      "--syn-string": "#9fb88a",
      "--fg-subtle": "#6d7076",
      "--control-off": "#3a3b3f",
    };
    const theme = buildTheme((n) => tokens[n] ?? "");
    expect(theme.background).toBe("#0f1012");
    expect(theme.foreground).toBe("#b9bbc1");
    expect(theme.cursor).toBe("#8fa5d6");
    expect(theme.red).toBe("#c97a6f");
    expect(theme.brightWhite).toBe("#e2e3e6");
    for (const key of ["black", "cyan", "brightRed", "brightCyan", "selectionBackground"] as const) {
      expect(theme[key]).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(theme.brightRed).not.toBe(theme.red);
  });

  it("falls back when tokens are missing", () => {
    const theme = buildTheme(() => "");
    expect(theme.background).toBe("#0f1012");
    expect(theme.red).toMatch(/^#/);
  });
});

describe("terminal links", () => {
  it("finds URLs and file locations", () => {
    const links = findTerminalLinks("see https://example.com/x). error at src/main.rs:10:5 and ./a/b.ts:3");
    expect(links.map((l) => l.text)).toEqual(["https://example.com/x", "src/main.rs:10:5", "./a/b.ts:3"]);
    const file = links[1]!;
    expect(file.kind === "file" && [file.path, file.line, file.col]).toEqual(["src/main.rs", 10, 5]);
  });

  it("supports paren locations and absolute paths", () => {
    const [l] = findTerminalLinks("/Users/me/p/App.tsx(14,3): error");
    expect(l?.kind === "file" && [l.path, l.line, l.col]).toEqual(["/Users/me/p/App.tsx", 14, 3]);
  });

  it("ignores plain numbers and URL ports", () => {
    expect(findTerminalLinks("12:30 http://localhost:3000").map((l) => l.kind)).toEqual(["url"]);
  });

  it("trims trailing punctuation from URLs", () => {
    expect(trimUrl("https://a.dev/x.")).toBe("https://a.dev/x");
    expect(trimUrl("https://a.dev/(x)")).toBe("https://a.dev/(x)");
    expect(trimUrl("https://a.dev/x)")).toBe("https://a.dev/x");
  });

  it("resolves paths against the cwd", () => {
    expect(resolvePath("src/a.ts", "/p")).toBe("/p/src/a.ts");
    expect(resolvePath("../b.ts", "/p/web")).toBe("/p/b.ts");
    expect(resolvePath("/abs/c.ts", "/p")).toBe("/abs/c.ts");
    expect(resolvePath("~/d.ts", "/p", "/Users/me")).toBe("/Users/me/d.ts");
  });
});

describe("terminal keys", () => {
  const key = (k: Partial<KeyboardEvent>) =>
    ({ key: "", code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...k }) as KeyboardEvent;

  it("sends Ctrl+letter to the shell instead of IDE shortcuts", () => {
    expect(terminalKeyAction(key({ key: "r", code: "KeyR", ctrlKey: true }), false)).toEqual({
      kind: "send",
      data: "\x12",
    });
    expect(terminalKeyAction(key({ key: "d", code: "KeyD", ctrlKey: true }), false)).toEqual({
      kind: "send",
      data: "\x04",
    });
    expect(terminalKeyAction(key({ key: "c", code: "KeyC", ctrlKey: true }), true)).toEqual({
      kind: "send",
      data: "\x03",
    });
    expect(terminalKeyAction(key({ key: "C", code: "KeyC", ctrlKey: true, shiftKey: true }), true)).toEqual({
      kind: "copy",
    });
    expect(terminalKeyAction(key({ key: "V", code: "KeyV", ctrlKey: true, shiftKey: true }), false)).toEqual({
      kind: "paste",
    });
    // Ctrl+Shift+T is New Tab in the IDE keymap; Ctrl+T still goes to the shell.
    expect(terminalKeyAction(key({ key: "T", code: "KeyT", ctrlKey: true, shiftKey: true }), false)).toEqual({
      kind: "pass",
    });
    expect(terminalKeyAction(key({ key: "t", code: "KeyT", ctrlKey: true }), false)).toEqual({
      kind: "send",
      data: "\x14",
    });
    // AZERTY: the key typing "z" is physically KeyW; Ctrl+Z must send ^Z (SIGTSTP), not ^W.
    expect(terminalKeyAction(key({ key: "z", code: "KeyW", ctrlKey: true }), false)).toEqual({
      kind: "send",
      data: "\x1a",
    });
    // Non-QWERTY Ctrl+Shift+C / V / T match the typed letter, not the physical key.
    expect(terminalKeyAction(key({ key: "C", code: "KeyI", ctrlKey: true, shiftKey: true }), true)).toEqual({
      kind: "copy",
    });
    expect(terminalKeyAction(key({ key: "V", code: "KeyPeriod", ctrlKey: true, shiftKey: true }), false)).toEqual({
      kind: "paste",
    });
    expect(terminalKeyAction(key({ key: "T", code: "KeyK", ctrlKey: true, shiftKey: true }), false)).toEqual({
      kind: "pass",
    });
    expect(terminalKeyAction(key({ key: "J", code: "KeyC", ctrlKey: true, shiftKey: true }), true)).toEqual({
      kind: "send",
      data: "\x0a",
    });
  });

  it("implements macOS conveniences", () => {
    expect(terminalKeyAction(key({ key: "c", metaKey: true }), true)).toEqual({ kind: "copy" });
    expect(terminalKeyAction(key({ key: "c", metaKey: true }), false)).toEqual({ kind: "pass" });
    expect(terminalKeyAction(key({ key: "k", metaKey: true }), false)).toEqual({ kind: "clear" });
    expect(terminalKeyAction(key({ key: "t", metaKey: true }), false)).toEqual({ kind: "pass" });
    expect(terminalKeyAction(key({ key: "v", metaKey: true }), false)).toEqual({ kind: "paste" });
    expect(terminalKeyAction(key({ key: "f", metaKey: true }), false)).toEqual({ kind: "find" });
    expect(terminalKeyAction(key({ key: "ArrowLeft", altKey: true }), false)).toEqual({ kind: "send", data: "\x1bb" });
    expect(terminalKeyAction(key({ key: "Escape" }), false)).toEqual({ kind: "send", data: "\x1b" });
  });

  it("leaves other IDE shortcuts alone", () => {
    expect(terminalKeyAction(key({ key: "F12", altKey: true }), false)).toEqual({ kind: "pass" });
    expect(terminalKeyAction(key({ key: "1", metaKey: true }), false)).toEqual({ kind: "pass" });
    expect(terminalKeyAction(key({ key: "a" }), false)).toEqual({ kind: "pass" });
  });

  it("clears a selection with Escape before sending it", () => {
    expect(terminalKeyAction(key({ key: "Escape" }), true)).toEqual({ kind: "clearSelection" });
    expect(terminalKeyAction(key({ key: "Escape", shiftKey: true }), true)).toEqual({ kind: "send", data: "\x1b" });
  });

  it("lets shortcuts of IDEA's allowed actions reach the IDE", () => {
    const bindings: Array<[string, string]> = [
      ["Ctrl+Shift+A", "navigate.findAction"],
      ["Ctrl+N", "navigate.gotoClass"],
      ["Ctrl+E", "navigate.recentFiles"],
      ["Ctrl+K", "vcs.commit"],
      ["Ctrl+Shift+K", "vcs.push"],
      ["Shift+Escape", "toolwindow.hideActive"],
      ["Ctrl+W Ctrl+F", "terminal.find"],
    ];
    expect(isAllowedIdeShortcut("Ctrl+Shift+A", bindings)).toBe(true);
    expect(isAllowedIdeShortcut("Ctrl+N", bindings)).toBe(true);
    expect(isAllowedIdeShortcut("Ctrl+Shift+K", bindings)).toBe(true);
    expect(isAllowedIdeShortcut("Shift+Escape", bindings)).toBe(true);
    expect(isAllowedIdeShortcut("Ctrl+W", bindings)).toBe(true);
    // Ctrl+E (end of line) and actions outside the list stay with the shell.
    expect(isAllowedIdeShortcut("Ctrl+E", bindings)).toBe(false);
    expect(isAllowedIdeShortcut("Ctrl+K", bindings)).toBe(false);
    expect(isAllowedIdeShortcut("Ctrl+R", bindings)).toBe(false);
  });
});

describe("tab names", () => {
  it("numbers duplicates like IDEA", () => {
    expect(nextTabName([])).toBe("Local");
    expect(nextTabName(["Local"])).toBe("Local (2)");
    expect(nextTabName(["Local", "Local (2)"])).toBe("Local (3)");
    expect(nextTabName(["Local"], "api")).toBe("api");
  });
});

describe("terminal find", () => {
  it("formats the match counter", () => {
    expect(matchCounter(null, "x")).toBe("");
    expect(matchCounter({ index: 2, count: 12 }, "x")).toBe("3/12");
    expect(matchCounter({ index: -1, count: 2000 }, "x")).toBe("2000+");
    expect(matchCounter({ index: -1, count: 0 }, "x")).toBe("0 results");
    expect(matchCounter({ index: 0, count: 3 }, "")).toBe("");
  });

  it("builds #rrggbb search decorations from tokens", () => {
    const d = buildSearchDecorations((n) => (n === "--match" ? "#8fa5d6" : n === "--bg-app" ? "#000000" : ""));
    for (const v of Object.values(d)) expect(v).toMatch(/^#[0-9a-f]{6}$/);
    expect(d.matchOverviewRuler).toBe("#8fa5d6");
  });
});

describe("split layout", () => {
  it("nests a split when the orientation changes", () => {
    let l = splitLayout("a", "a", "b", "vertical", "g1");
    expect(l).toEqual({ id: "g1", orientation: "vertical", children: ["a", "b"] });
    l = splitLayout(l, "b", "c", "horizontal", "g2");
    expect(l).toEqual({
      id: "g1",
      orientation: "vertical",
      children: ["a", { id: "g2", orientation: "horizontal", children: ["b", "c"] }],
    });
    l = splitLayout(l, "a", "d", "vertical", "g3");
    expect(layoutPanes(l)).toEqual(["a", "d", "b", "c"]);
  });

  it("collapses single-child splits on removal", () => {
    const l = splitLayout(splitLayout("a", "a", "b", "vertical", "g1"), "b", "c", "horizontal", "g2");
    expect(removeFromLayout(l, "a")).toEqual({ id: "g2", orientation: "horizontal", children: ["b", "c"] });
    expect(removeFromLayout(l, "c")).toEqual({ id: "g1", orientation: "vertical", children: ["a", "b"] });
    expect(removeFromLayout("a", "a")).toBeNull();
  });
});

describe("terminalFont", () => {
  const BASE = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, Menlo, monospace';
  const t = {
    useEditorFont: true,
    fontFamily: "JetBrains Mono",
    fontSize: 10,
    lineHeight: 1,
    fallbackFontFamily: "",
    columnWidth: 1,
  };
  const editor = { fontFamily: "JetBrains Mono", fontSize: 10, lineHeight: 12 };
  const head = (family: string) => family.slice(0, family.indexOf('"Symbols Nerd Font Mono"'));

  it.each([
    // #26: "Use editor font" with the default family must reach the bundled face, not the system monospace.
    [
      "editor font, default family",
      t,
      editor,
      `"JetBrains Mono Variable", "JetBrains Mono", ${BASE.replace(", monospace", "")}, `,
    ],
    [
      "editor font, no editor settings",
      t,
      undefined,
      `"JetBrains Mono Variable", "JetBrains Mono", ${BASE.replace(", monospace", "")}, `,
    ],
    [
      "editor font, custom family",
      t,
      { ...editor, fontFamily: "Fira Code" },
      `"Fira Code", ${BASE.replace(", monospace", "")}, `,
    ],
    [
      "editor font, editor fallback",
      t,
      { ...editor, fallbackFont: "PingFang SC" },
      `"JetBrains Mono Variable", "JetBrains Mono", "PingFang SC", ${BASE.replace(", monospace", "")}, `,
    ],
    [
      "own font, default family",
      { ...t, useEditorFont: false },
      editor,
      `"JetBrains Mono Variable", "JetBrains Mono", ${BASE.replace(", monospace", "")}, `,
    ],
    [
      "own font, custom + fallback",
      { ...t, useEditorFont: false, fontFamily: "Hack", fallbackFontFamily: "PingFang SC" },
      editor,
      `"Hack", "PingFang SC", ${BASE.replace(", monospace", "")}, `,
    ],
  ])("%s resolves through the bundled stack", (_, settings, ed, expected) => {
    const font = terminalFont(settings, ed, BASE);
    expect(head(font.family)).toBe(expected);
    expect(font.family.endsWith(", monospace")).toBe(true);
    expect(font.family).not.toContain("var(");
  });

  it("prefers the terminal's fallback over the editor's", () => {
    const font = terminalFont(
      { ...t, fallbackFontFamily: "Sarasa Mono SC" },
      { ...editor, fallbackFont: "PingFang SC" },
      BASE,
    );
    expect(font.family).toContain('"Sarasa Mono SC"');
    expect(font.family).not.toContain("PingFang SC");
  });

  it("follows the editor's Typography Settings weights with Use editor font", () => {
    const f = terminalFont(t, { ...editor, fontWeight: 300, boldFontWeight: 600 }, BASE);
    expect([f.weight, f.boldWeight]).toEqual([300, 600]);
    const d = terminalFont(t, editor, BASE);
    expect([d.weight, d.boldWeight]).toEqual([400, 700]);
  });

  it("keeps regular / bold for the terminal's own font", () => {
    const f = terminalFont({ ...t, useEditorFont: false }, { ...editor, fontWeight: 300, boldFontWeight: 600 }, BASE);
    expect([f.weight, f.boldWeight]).toEqual([400, 700]);
  });

  it("keeps the terminal's line height with Use editor font", () => {
    expect(terminalFont(t, { ...editor, lineHeight: 21 }, BASE).lineHeight).toBe(1);
    expect(terminalFont({ ...t, lineHeight: 1.2 }, editor, BASE).lineHeight).toBe(1.2);
  });

  it("turns the column width into letter spacing", () => {
    expect(terminalFont({ ...t, useEditorFont: false }, editor, BASE).letterSpacing).toBe(0);
    expect(terminalFont({ ...t, useEditorFont: false, columnWidth: 1.5 }, editor, BASE).letterSpacing).toBe(3);
  });
});

describe("terminal tab titles", () => {
  const tab: TerminalTab = { id: "t1", name: "Local", customName: null, panes: ["s1"], layout: "s1", activePane: "s1" };
  const snap = (appTitle: string | null, commandRunning = true): Record<string, SessionSnapshot> => ({
    s1: { status: "running", exitCode: null, title: "zsh", appTitle, commandRunning, cwd: "/p" },
  });

  it("shows the default name at the prompt, whatever title the shell sets", () => {
    expect(tabTitle(tab, snap("thomas@mac: ~/repo", false))).toBe("Local");
    expect(tabFullTitle(tab, snap("thomas@mac: ~/repo", false))).toBe("Local");
  });

  it("follows the title the running program sets, else the default name", () => {
    expect(tabTitle(tab, snap(null))).toBe("Local");
    expect(tabTitle(tab, snap("vim notes.md"))).toBe("vim notes.md");
    const long = "ssh deploy@build-server-01.internal.example.com";
    expect(tabTitle(tab, snap(long))).toHaveLength(30);
    expect(tabTitle(tab, snap(long))).toBe(trimMiddle(long, 30));
    expect(tabFullTitle(tab, snap(long))).toBe(long);
  });

  it("keeps a name the user gave the tab", () => {
    const renamed = { ...tab, customName: "Server" };
    expect(tabTitle(renamed, snap("top"))).toBe("Server");
    expect(tabFullTitle(renamed, snap("top"))).toBe("Server");
  });

  it("elides the middle", () => {
    expect(trimMiddle("abcdefghij", 5)).toBe("ab…ij");
    expect(trimMiddle("abc", 5)).toBe("abc");
  });
});

describe("fit scheduling", () => {
  afterEach(() => vi.useRealTimers());

  it("refits at most once per interval while resizing, and once after it stops", () => {
    vi.useFakeTimers();
    const fit = vi.fn();
    const f = fitScheduler(fit);
    f.schedule();
    vi.advanceTimersToNextFrame();
    expect(fit).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 6; i++) {
      f.schedule();
      vi.advanceTimersByTime(16);
    }
    expect(fit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(FIT_INTERVAL_MS);
    expect(fit).toHaveBeenCalledTimes(2);
    f.schedule();
    f.cancel();
    vi.advanceTimersByTime(FIT_INTERVAL_MS * 2);
    expect(fit).toHaveBeenCalledTimes(2);
  });

  it("reports only the size the terminal settles on", () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const r = settledResize(report);
    r.resized(80, 20);
    vi.advanceTimersByTime(PROCESS_RESIZE_DELAY_MS / 2);
    r.resized(80, 24);
    vi.advanceTimersByTime(PROCESS_RESIZE_DELAY_MS);
    expect(report).toHaveBeenCalledExactlyOnceWith(80, 24);
  });
});
