import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { usePlatform } from "@/platform/platformInfo";
import { BuildView } from "./BuildView";
import { useBuildRun } from "./store";
import type { ConsoleLine } from "./model";

/** Like a real viewport scrolled to the end: only the last 30 rows are mounted. */
const MOUNTED = 30;
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 20,
    getVirtualItems: () =>
      Array.from({ length: Math.min(count, MOUNTED) }, (_, i) => {
        const index = count - Math.min(count, MOUNTED) + i;
        return { index, start: index * 20, size: 20, key: index };
      }),
    scrollToIndex: () => {},
    measureElement: () => {},
    measure: () => {},
  }),
}));

const clipboard = vi.hoisted(() => ({ writeText: vi.fn(async (_text: string) => {}) }));

const LINES: ConsoleLine[] = Array.from({ length: 2_500 }, (_, i) => ({
  kind: "out",
  text: `t3row${String(i).padStart(5, "0")} ${"x".repeat(20)}`,
}));
const ALL = LINES.map((l) => l.text).join("\n");

beforeEach(() => {
  usePlatform.setState({ os: "macos" });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
  clipboard.writeText.mockClear();
  useBuildRun.setState({ status: "success", lines: LINES, messages: [], selected: null });
});
afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
});

function setup() {
  render(<BuildView />);
  const log = screen.getByRole("log", { name: "Build output" });
  log.focus();
  return log;
}

describe("Build output Select All + Copy", () => {
  it("copies every line after ⌘A / ⌘C, not only the mounted rows", () => {
    const log = setup();
    expect(log.firstElementChild!.children).toHaveLength(MOUNTED);
    fireEvent.keyDown(log, { key: "a", code: "KeyA", metaKey: true });
    fireEvent.keyDown(log, { key: "c", code: "KeyC", metaKey: true });
    expect(clipboard.writeText).toHaveBeenCalledWith(ALL);
  });

  it("copies every line on native Copy (Edit › Copy) after ⌘A", () => {
    const log = setup();
    fireEvent.keyDown(log, { key: "a", code: "KeyA", metaKey: true });
    const setData = vi.fn();
    fireEvent.copy(log, { clipboardData: { setData } });
    expect(setData).toHaveBeenCalledWith("text/plain", ALL);
  });

  it("selects the output on Edit › Select All (macOS menu ⌘A) and copies every line", () => {
    const log = setup();
    // The native Select All asks the body with `selectstart`; no keydown reaches the webview.
    const selectStart = new Event("selectstart", { bubbles: true, cancelable: true });
    document.body.dispatchEvent(selectStart);
    expect(selectStart.defaultPrevented).toBe(true);
    const selection = window.getSelection()!;
    expect(log.contains(selection.anchorNode) && log.contains(selection.focusNode)).toBe(true);
    const setData = vi.fn();
    fireEvent.copy(log, { clipboardData: { setData } });
    expect(setData).toHaveBeenCalledWith("text/plain", ALL);
  });

  it("leaves Select All alone when the output does not have focus", () => {
    setup();
    (document.activeElement as HTMLElement | null)?.blur();
    const selectStart = new Event("selectstart", { bubbles: true, cancelable: true });
    document.body.dispatchEvent(selectStart);
    expect(selectStart.defaultPrevented).toBe(false);
  });
});
