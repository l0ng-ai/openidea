// @vitest-environment jsdom
import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findVisibleSelectionMatches,
  installSelectionHighlights,
  OVERLAY_CONTAINER_CLASS,
  OVERLAY_MATCH_CLASS,
  SelectionLineCache,
} from "./highlight";

function writeAsync(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

describe("terminal selection occurrence highlights", () => {
  const terms: Array<{ term: Terminal; host: HTMLDivElement }> = [];

  const createTerm = (cols = 40, rows = 5) => {
    window.matchMedia ??= (() =>
      ({
        matches: false,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const term = new Terminal({ allowProposedApi: true, cols, rows, scrollback: 200 });
    term.open(host);
    terms.push({ term, host });
    return term;
  };

  afterEach(() => {
    while (terms.length) {
      const { term, host } = terms.pop()!;
      term.dispose();
      host.remove();
    }
  });

  it("scans only visible rows (plus margin), never the distant scrollback", async () => {
    const term = createTerm(40, 4);
    for (let i = 0; i < 40; i++) {
      await writeAsync(term, `line-${i} req-42 req-42\r\n`);
    }
    const lastRow = term.buffer.active.baseY;
    // Select the first "req-42" on the last visible row (col 8, len 6)
    term.select(8, lastRow, 6);
    expect(term.getSelection()).toBe("req-42");

    const cache = new SelectionLineCache();
    const matches = findVisibleSelectionMatches(term, cache, 2);
    // Distant scrollback rows (e.g. row 0..20) must never be scanned or returned
    expect(matches.every((m) => m.row >= term.buffer.active.viewportY - 2)).toBe(true);
    expect(cache.scans).toBeLessThanOrEqual(8);
  });

  it("caches per line and rescans only invalidated rows", async () => {
    const term = createTerm(40, 5);
    await writeAsync(term, "pid-99 other pid-99\r\npid-99 second\r\nthird line\r\n");
    term.select(0, 0, 6);

    const cache = new SelectionLineCache();
    const first = findVisibleSelectionMatches(term, cache, 2);
    expect(first).toEqual([
      { row: 0, col: 13, size: 6 },
      { row: 1, col: 0, size: 6 },
    ]);
    const initialScans = cache.scans;
    expect(initialScans).toBeGreaterThan(0);

    // Second pass with unchanged lines hits the cache (0 new scans)
    const second = findVisibleSelectionMatches(term, cache, 2);
    expect(second).toEqual(first);
    expect(cache.scans).toBe(initialScans);

    // Invalidating row 1 rescans only row 1
    cache.invalidateRange(1, 1);
    findVisibleSelectionMatches(term, cache, 2);
    expect(cache.scans).toBe(initialScans + 1);
  });

  it("maps wrapped lines (isWrapped) and wide CJK characters to exact cell columns", async () => {
    const term = createTerm(12, 6);
    // "中文ab中文" -> '中'(2) '文'(2) 'a'(1) 'b'(1) '中'(2) '文'(2) = 10 cols
    await writeAsync(term, "中文ab中文\r\n");
    // Select first "中文" (cols 0..4)
    term.select(0, 0, 4);
    expect(term.getSelection()).toBe("中文");

    const cjkMatches = findVisibleSelectionMatches(term);
    expect(cjkMatches).toEqual([{ row: 0, col: 6, size: 4 }]);

    // Wrapped line across 12-column terminal: "0123456789tok_en_012345tok_en"
    term.reset();
    await writeAsync(term, "0123456789tok_en_012345tok_en\r\n");
    // First "tok_en" starts at col 10 of row 0 and wraps 4 cols into row 1 (size 6)
    term.select(10, 0, 6);
    expect(term.getSelection()).toBe("tok_en");

    const wrappedMatches = findVisibleSelectionMatches(term);
    expect(wrappedMatches).toEqual([{ row: 1, col: 11, size: 6 }]);
  });

  it("skips multi-line, short, or whitespace-only selections and turns off in alternate buffer", async () => {
    const term = createTerm(40, 6);
    await writeAsync(term, "a a a\r\n   \r\nfoo bar foo\r\nfoo baz\r\n");

    term.select(0, 0, 1);
    expect(findVisibleSelectionMatches(term)).toEqual([]);

    term.select(0, 1, 3);
    expect(findVisibleSelectionMatches(term)).toEqual([]);

    term.selectLines(2, 3);
    expect(findVisibleSelectionMatches(term)).toEqual([]);

    term.select(0, 2, 3);
    expect(findVisibleSelectionMatches(term)).toHaveLength(2);

    // Enter alternate screen buffer (vim / htop)
    await writeAsync(term, "\x1b[?1049hfoo bar foo\r\n");
    expect(term.buffer.active.type).toBe("alternate");
    expect(findVisibleSelectionMatches(term)).toEqual([]);
  });

  it("draws highlights in one overlay layer, coalesces frames, and clears during heavy output", async () => {
    const term = createTerm(40, 6);
    const registerSpy = vi.spyOn(term, "registerDecoration");
    let enabled = true;
    const controller = installSelectionHighlights(term, {
      isEnabled: () => enabled,
    });

    await writeAsync(term, "err_code other err_code\r\nerr_code third\r\n");
    term.select(0, 0, 8);
    controller.refresh();

    // Zero registerDecoration calls: uses one overlay container instead
    expect(registerSpy).not.toHaveBeenCalled();
    const overlay = term.element?.querySelector(`.${OVERLAY_CONTAINER_CLASS}`);
    expect(overlay).not.toBeNull();
    const visibleBoxes = () =>
      [...(overlay?.querySelectorAll<HTMLElement>(`.${OVERLAY_MATCH_CLASS}`) ?? [])].filter(
        (el) => el.style.display !== "none",
      );
    expect(visibleBoxes()).toHaveLength(2);

    // Disabling the setting clears the overlay
    enabled = false;
    controller.refresh();
    expect(visibleBoxes()).toHaveLength(0);

    enabled = true;
    controller.refresh();
    expect(visibleBoxes()).toHaveLength(2);

    // Heavy output burst clears the overlay immediately and redraws once settled
    await writeAsync(term, "streaming line 1\r\n");
    await writeAsync(term, "streaming line 2 err_code\r\n");
    expect(visibleBoxes()).toHaveLength(0);

    await new Promise((r) => setTimeout(r, 220));
    controller.refresh();
    expect(visibleBoxes().length).toBeGreaterThanOrEqual(2);

    controller.dispose();
  });
});
