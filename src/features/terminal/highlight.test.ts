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

  const createTerm = (cols = 40, rows = 5, scrollback = 200) => {
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
    const term = new Terminal({ allowProposedApi: true, cols, rows, scrollback });
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

  it.each(["linefeed", "soft-wrap"] as const)(
    "clears cached margin rows when a full scrollback trims on %s",
    async (mode) => {
      // rows=4, scrollback=6 -> max buffer length is 10; marginRows=4 caches rows 2..5 above viewport 6..9.
      const term = createTerm(16, 4, 6);
      const controller = installSelectionHighlights(term, { isEnabled: () => true });

      for (let i = 0; i < 9; i++) {
        // Row 6 (first visible row before trim) has "tok_id"; margin row 5 above it does not.
        const body = i === 6 ? "tok_id hit" : `row-${i}`;
        await writeAsync(term, `${body}\r\n`);
      }
      await writeAsync(term, "tok_id sel");
      expect(term.buffer.active.length).toBe(10);
      expect(term.buffer.active.baseY).toBe(6);

      // Select "tok_id" on row 9; initial pass caches margin row 5 as [] and row 6 as [{ row: 6, col: 0, size: 6 }].
      term.select(0, 9, 6);
      expect(term.getSelection()).toBe("tok_id");
      controller.refresh();
      expect(findVisibleSelectionMatches(term, controller.cache)).toEqual([{ row: 6, col: 0, size: 6 }]);

      // Wait past HEAVY_WRITE_WINDOW_MS so a single new line does not trigger burst-clear.
      await new Promise((r) => setTimeout(r, 100));
      if (mode === "linefeed") {
        await writeAsync(term, "\r\nnext");
      } else {
        // Overflow 16-col row 9 ("tok_id sel" = 10 cols) without LF so xterm trims via soft-wrap scroll.
        await writeAsync(term, "0123456789");
      }

      // Buffer length stays at the cap (10), while "tok_id hit" shifted from row 6 into margin row 5.
      expect(term.buffer.active.length).toBe(10);
      expect(term.buffer.active.baseY).toBe(6);

      // Scrolling up 1 line brings row 5 into viewport row 0; it must not return the stale [] entry.
      term.scrollLines(-1);
      expect(term.buffer.active.viewportY).toBe(5);
      expect(findVisibleSelectionMatches(term, controller.cache)).toEqual([{ row: 5, col: 0, size: 6 }]);

      await new Promise((r) => window.requestAnimationFrame(() => r(undefined)));
      const overlay = term.element?.querySelector(`.${OVERLAY_CONTAINER_CLASS}`);
      const visibleBoxes = [...(overlay?.querySelectorAll<HTMLElement>(`.${OVERLAY_MATCH_CLASS}`) ?? [])].filter(
        (el) => el.style.display !== "none",
      );
      expect(visibleBoxes).toHaveLength(1);
      expect(visibleBoxes[0]?.style.top).toBe("0px");

      controller.dispose();
    },
  );

  it("updates highlights when scrolled up in a full scrollback and clears when selection is trimmed out", async () => {
    const term = createTerm(24, 4, 4);
    const controller = installSelectionHighlights(term, { isEnabled: () => true });

    // Fill all 8 rows (scrollback=4 + rows=4): row 0, row 2, and row 3 have "dup_tok".
    await writeAsync(term, "dup_tok\r\nrow-1\r\ndup_tok a\r\ndup_tok b\r\nrow-4\r\nrow-5\r\nrow-6\r\nrow-7");
    expect(term.buffer.active.length).toBe(8);

    term.scrollToTop();
    expect(term.buffer.active.viewportY).toBe(0);
    // selectLines sets selectionEnd so xterm's handleTrim clears the selection without firing onSelectionChange.
    term.selectLines(0, 0);
    expect(term.getSelection()).toBe("dup_tok");
    controller.refresh();

    const overlay = term.element?.querySelector(`.${OVERLAY_CONTAINER_CLASS}`);
    const visibleBoxes = () =>
      [...(overlay?.querySelectorAll<HTMLElement>(`.${OVERLAY_MATCH_CLASS}`) ?? [])].filter(
        (el) => el.style.display !== "none",
      );
    expect(visibleBoxes()).toHaveLength(2);

    // Wait past burst window; 1 new line at bottom trims row 0 (and the selection on row 0) without firing onSelectionChange.
    await new Promise((r) => setTimeout(r, 100));
    await writeAsync(term, "\r\nrow-8");
    await new Promise((r) => window.requestAnimationFrame(() => r(undefined)));
    expect(term.hasSelection()).toBe(false);
    expect(visibleBoxes()).toHaveLength(0);

    // Now "dup_tok a" is at row 1 and "dup_tok b" is at row 2; select row 1 while pinned at viewportY=0.
    term.select(0, 1, 7);
    expect(term.getSelection()).toBe("dup_tok");
    controller.refresh();
    expect(findVisibleSelectionMatches(term, controller.cache)).toEqual([{ row: 2, col: 0, size: 7 }]);

    // Trim once more at viewportY=0 (onRender does not fire for scrollback rows): match shifts from row 2 -> row 1.
    await new Promise((r) => setTimeout(r, 100));
    await writeAsync(term, "\r\nrow-9");
    await new Promise((r) => window.requestAnimationFrame(() => r(undefined)));
    expect(term.getSelection()).toBe("dup_tok");
    expect(term.buffer.active.viewportY).toBe(0);
    expect(findVisibleSelectionMatches(term, controller.cache)).toEqual([{ row: 1, col: 0, size: 7 }]);

    controller.dispose();
  });

  it("invalidates stale rows across CSI 3 J scrollback erase and multi-line single writes", async () => {
    const term = createTerm(30, 4, 100);
    const controller = installSelectionHighlights(term, { isEnabled: () => true });

    await writeAsync(term, "alpha_key one\r\nalpha_key two\r\nthree\r\nprompt$ ");
    // Select "alpha_key" on row 0; row 3 ("prompt$ ") is cached with 0 matches.
    term.select(0, 0, 9);
    controller.refresh();
    expect(findVisibleSelectionMatches(term, controller.cache)).toEqual([{ row: 1, col: 0, size: 9 }]);

    // Single write prints "alpha_key" onto row 3 and advances baseY/viewportY to 5 so row 3 lands in the top margin (missed by onRender).
    await new Promise((r) => setTimeout(r, 100));
    await writeAsync(term, "alpha_key\r\nn1\r\nn2\r\nn3\r\nn4\r\nn5");
    expect(term.buffer.active.viewportY).toBe(5);
    expect(findVisibleSelectionMatches(term, controller.cache)).toEqual([
      { row: 1, col: 0, size: 9 },
      { row: 3, col: 8, size: 9 },
    ]);

    // Move selection into the current viewport, then emit CSI 3 J (erase scrollback), shifting viewport rows down to 0..3.
    await writeAsync(term, " alpha_key");
    term.select(3, 8, 9);
    expect(term.getSelection()).toBe("alpha_key");
    controller.refresh();

    await new Promise((r) => setTimeout(r, 100));
    await writeAsync(term, "\x1b[3J");
    expect(term.buffer.active.baseY).toBe(0);
    // Old cached matches from erased scrollback rows 0..3 must not reappear.
    expect(findVisibleSelectionMatches(term, controller.cache)).toEqual([]);

    controller.dispose();
  });
});
