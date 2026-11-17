/**
 * Viewport-scoped selection-occurrence highlights in the terminal.
 *
 * - Scans only the visible rows (plus a small margin), never the scrollback.
 * - Caches per logical line, invalidates rendered/active-screen rows, and
 *   clears on scrollback trims (`IMarker` at row 0) so shifted margin/scrollback
 *   rows never stay stale.
 * - Draws all visible matches in one overlay layer (`.openidea-terminal-selection-matches`)
 *   inside `.xterm-screen` instead of calling `registerDecoration` per match.
 * - Coalesces `onRender` / `onScroll` / `onSelectionChange` to one pass per
 *   animation frame; clears highlights during heavy output bursts and redraws
 *   once output settles.
 * - Handles wrapped lines (`isWrapped`) and wide (CJK / emoji) characters.
 * - Skips multi-line, short (< 2 chars), long (> 200 chars), or whitespace-only
 *   selections, turns off in the alternate buffer (`vim`, `htop`), and respects
 *   `terminal.highlightSelection`.
 */
import type { IBufferLine, IDisposable, IMarker, Terminal } from "@xterm/xterm";
import { workflowSettings } from "@/platform/workflowSettings";

export const MIN_SELECTION_LENGTH = 2;
export const MAX_SELECTION_LENGTH = 200;
export const VIEWPORT_MARGIN_ROWS = 4;
const MAX_WRAP_ROWS = 16;
const MAX_VISIBLE_MATCHES = 200;
const HEAVY_WRITE_WINDOW_MS = 80;
const HEAVY_SETTLE_MS = 150;

export const OVERLAY_CONTAINER_CLASS = "openidea-terminal-selection-matches";
export const OVERLAY_MATCH_CLASS = "openidea-terminal-selection-match";

export interface TerminalBufferMatch {
  row: number;
  col: number;
  size: number;
}

interface CachedLogicalLine {
  span: number;
  matches: TerminalBufferMatch[];
}

export class SelectionLineCache {
  private needle = "";
  private cols = 0;
  private trackedTerm: Terminal | null = null;
  private bufferSub: IDisposable | null = null;
  private headMarker: IMarker | null = null;
  private headMarkerSub: IDisposable | null = null;
  private lastBaseY = 0;
  private lastLength = 0;
  private readonly onTrim?: () => void;
  private readonly lines = new Map<number, CachedLogicalLine>();
  /** Number of logical-line scans performed (exposed for unit tests). */
  scans = 0;

  constructor(onTrim?: () => void) {
    this.onTrim = onTrim;
  }

  private clearHeadMarker() {
    const sub = this.headMarkerSub;
    const marker = this.headMarker;
    this.headMarkerSub = null;
    this.headMarker = null;
    sub?.dispose();
    marker?.dispose();
  }

  syncKey(needle: string, cols: number) {
    if (this.needle !== needle || this.cols !== cols) {
      this.needle = needle;
      this.cols = cols;
      this.clear();
    }
  }

  /**
   * Synchronizes the cache against `term`'s active buffer. Anchors a single
   * marker at row 0 so any top-of-buffer trim (`recycle` at the scrollback
   * limit, `CSI 3 J`, `clear`) disposes it and clears shifted row entries.
   */
  sync(term: Terminal, needle: string) {
    if (this.trackedTerm !== term) {
      this.dispose();
      this.trackedTerm = term;
      this.bufferSub = term.buffer.onBufferChange(() => this.clear());
    }
    const buffer = term.buffer.active;
    if (this.needle !== needle || this.cols !== term.cols) {
      this.needle = needle;
      this.cols = term.cols;
      this.clear();
    } else if (this.lines.size > 0) {
      if (
        !this.headMarker ||
        this.headMarker.isDisposed ||
        this.headMarker.line !== 0 ||
        buffer.baseY < this.lastBaseY ||
        buffer.length < this.lastLength
      ) {
        this.clear();
      } else if (buffer.baseY > this.lastBaseY) {
        this.invalidateRange(this.lastBaseY, buffer.baseY + term.rows - 1);
      }
    }
    this.lastBaseY = buffer.baseY;
    this.lastLength = buffer.length;
    if (!this.headMarker && buffer.type === "normal" && buffer.length > 0) {
      const cursorRow = buffer.baseY + buffer.cursorY;
      const marker = term.registerMarker(cursorRow > 0 ? -cursorRow : 0);
      if (marker && !marker.isDisposed && marker.line === 0) {
        this.headMarker = marker;
        this.headMarkerSub = marker.onDispose(() => {
          this.headMarker = null;
          this.headMarkerSub?.dispose();
          this.headMarkerSub = null;
          this.lines.clear();
          this.lastBaseY = 0;
          this.lastLength = 0;
          this.onTrim?.();
        });
      }
    }
  }

  handleWriteParsed(term: Terminal) {
    if (this.lines.size === 0) return;
    const buffer = term.buffer.active;
    if (
      !this.headMarker ||
      this.headMarker.isDisposed ||
      this.headMarker.line !== 0 ||
      buffer.baseY < this.lastBaseY ||
      buffer.length < this.lastLength
    ) {
      this.clear();
      return;
    }
    const invalidStart = Math.min(this.lastBaseY, buffer.baseY);
    this.invalidateRange(invalidStart, buffer.baseY + term.rows - 1);
    this.lastBaseY = buffer.baseY;
    this.lastLength = buffer.length;
  }

  get(baseRow: number): CachedLogicalLine | undefined {
    return this.lines.get(baseRow);
  }

  set(baseRow: number, entry: CachedLogicalLine) {
    this.lines.set(baseRow, entry);
  }

  invalidateRange(startRow: number, endRow: number) {
    const hadEntries = this.lines.size > 0;
    for (const [baseRow, entry] of this.lines) {
      if (baseRow <= endRow && baseRow + entry.span - 1 >= startRow) {
        this.lines.delete(baseRow);
      }
    }
    if (hadEntries && this.lines.size === 0) {
      this.clearHeadMarker();
    }
  }

  prune(minRow: number, maxRow: number) {
    const hadEntries = this.lines.size > 0;
    for (const baseRow of this.lines.keys()) {
      if (baseRow < minRow || baseRow > maxRow) {
        this.lines.delete(baseRow);
      }
    }
    if (hadEntries && this.lines.size === 0) {
      this.clearHeadMarker();
    }
  }

  clear() {
    this.clearHeadMarker();
    this.lines.clear();
    this.lastBaseY = 0;
    this.lastLength = 0;
  }

  dispose() {
    this.clear();
    this.bufferSub?.dispose();
    this.bufferSub = null;
    this.trackedTerm = null;
  }
}

function translateLogicalLine(term: Terminal, baseRow: number, maxRow: number): [string, number[], number] {
  const buffer = term.buffer.active;
  const strings: string[] = [];
  const lineOffsets = [0];
  let lineIndex = baseRow;
  let line = buffer.getLine(lineIndex);
  let span = 0;
  while (line) {
    span++;
    const nextLine = lineIndex < maxRow ? buffer.getLine(lineIndex + 1) : undefined;
    const lineWrapsToNext = nextLine ? nextLine.isWrapped : false;
    let str = line.translateToString(!lineWrapsToNext);
    if (lineWrapsToNext && nextLine) {
      const lastCell = line.getCell(line.length - 1);
      const lastCellIsNull = lastCell && lastCell.getCode() === 0 && lastCell.getWidth() === 1;
      if (lastCellIsNull && nextLine.getCell(0)?.getWidth() === 2) {
        str = str.slice(0, -1);
      }
    }
    strings.push(str);
    if (lineWrapsToNext) {
      lineOffsets.push(lineOffsets[lineOffsets.length - 1]! + str.length);
    } else {
      break;
    }
    lineIndex++;
    line = nextLine;
  }
  return [strings.join(""), lineOffsets, Math.max(1, span)];
}

/**
 * Maps a UTF-16 string offset within `line.translateToString()` to a 0-based
 * buffer column, accounting for width-2 CJK glyphs, width-0 trailing spacer
 * cells, and astral surrogate pairs.
 */
export function stringOffsetToCol(line: IBufferLine | undefined, targetOffset: number): number {
  if (!line || targetOffset <= 0) return 0;
  let strPos = 0;
  let col = 0;
  const len = line.length;
  while (col < len && strPos < targetOffset) {
    const cell = line.getCell(col);
    if (!cell) break;
    const width = cell.getWidth();
    if (width === 0) {
      col++;
      continue;
    }
    const chars = cell.getChars();
    strPos += chars ? chars.length : 1;
    col += width;
  }
  return col;
}

function scanLogicalLineMatches(term: Terminal, baseRow: number, maxRow: number, needle: string): CachedLogicalLine {
  const cols = term.cols;
  const buffer = term.buffer.active;
  const [stringLine, offsets, span] = translateLogicalLine(term, baseRow, maxRow);
  const matches: TerminalBufferMatch[] = [];
  if (stringLine.length < needle.length) {
    return { span, matches };
  }

  let fromIndex = 0;
  while (fromIndex <= stringLine.length - needle.length) {
    const idx = stringLine.indexOf(needle, fromIndex);
    if (idx < 0) break;

    let startRowOffset = 0;
    while (startRowOffset < offsets.length - 1 && idx >= offsets[startRowOffset + 1]!) {
      startRowOffset++;
    }
    let endRowOffset = startRowOffset;
    while (endRowOffset < offsets.length - 1 && idx + needle.length > offsets[endRowOffset + 1]!) {
      endRowOffset++;
    }
    const startColOffset = idx - offsets[startRowOffset]!;
    const endColOffset = idx + needle.length - offsets[endRowOffset]!;
    const startColIndex = stringOffsetToCol(buffer.getLine(baseRow + startRowOffset), startColOffset);
    const endColIndex = stringOffsetToCol(buffer.getLine(baseRow + endRowOffset), endColOffset);
    const matchRow = baseRow + startRowOffset;
    const size = endColIndex - startColIndex + cols * (endRowOffset - startRowOffset);

    if (size > 0) {
      matches.push({ row: matchRow, col: startColIndex, size });
    }
    fromIndex = idx + needle.length;
  }

  return { span, matches };
}

/**
 * Finds case-sensitive occurrences of `term.getSelection()` in the visible
 * viewport rows (`viewportY - marginRows .. viewportY + rows - 1 + marginRows`),
 * excluding the active selection itself and skipping the alternate buffer.
 */
export function findVisibleSelectionMatches(
  term: Terminal,
  cache?: SelectionLineCache,
  marginRows = VIEWPORT_MARGIN_ROWS,
): TerminalBufferMatch[] {
  const buffer = term.buffer.active;
  if (buffer.type === "alternate") return [];

  const text = term.getSelection();
  if (
    text.length < MIN_SELECTION_LENGTH ||
    text.length > MAX_SELECTION_LENGTH ||
    text.includes("\n") ||
    text.includes("\r") ||
    !text.trim()
  ) {
    return [];
  }

  const cols = term.cols;
  if (cols <= 0 || term.rows <= 0) return [];
  const selPos = term.getSelectionPosition();
  const selStart = selPos ? selPos.start.y * cols + selPos.start.x : -1;
  const selEnd = selPos ? selPos.end.y * cols + selPos.end.x : -1;

  const totalRows = Math.max(buffer.length, buffer.baseY + term.rows);
  if (totalRows <= 0) return [];

  const viewStart = Math.max(0, buffer.viewportY - marginRows);
  const viewEnd = Math.min(totalRows - 1, buffer.viewportY + term.rows - 1 + marginRows);
  const maxWrapEnd = Math.min(totalRows - 1, viewEnd + MAX_WRAP_ROWS);

  cache?.sync(term, text);
  cache?.prune(Math.max(0, viewStart - MAX_WRAP_ROWS), maxWrapEnd);

  const visited = new Set<number>();
  const out: TerminalBufferMatch[] = [];

  for (let row = viewStart; row <= viewEnd; row++) {
    let baseRow = row;
    let steps = 0;
    while (baseRow > 0 && steps < MAX_WRAP_ROWS && buffer.getLine(baseRow)?.isWrapped) {
      baseRow--;
      steps++;
    }
    if (visited.has(baseRow)) continue;
    visited.add(baseRow);

    let entry = cache?.get(baseRow);
    if (!entry) {
      if (cache) cache.scans++;
      entry = scanLogicalLineMatches(term, baseRow, maxWrapEnd, text);
      cache?.set(baseRow, entry);
    }

    for (const match of entry.matches) {
      const matchStart = match.row * cols + match.col;
      const matchEnd = matchStart + match.size;
      const overlapsSelection = selPos !== undefined && matchStart < selEnd && selStart < matchEnd;
      if (!overlapsSelection) {
        out.push(match);
        if (out.length >= MAX_VISIBLE_MATCHES) return out;
      }
    }
  }

  return out;
}

export interface SelectionHighlightOptions {
  isEnabled?: () => boolean;
  isSearchSelection?: () => boolean;
}

export interface SelectionHighlightController extends IDisposable {
  readonly cache: SelectionLineCache;
  refresh(): void;
  clear(): void;
}

export function installSelectionHighlights(
  term: Terminal,
  opts: SelectionHighlightOptions = {},
): SelectionHighlightController {
  const isEnabled = opts.isEnabled ?? (() => workflowSettings().terminal.highlightSelection);
  const isSearchSelection = opts.isSearchSelection ?? (() => false);
  let overlay: HTMLDivElement | null = null;
  const pool: HTMLDivElement[] = [];
  let activeBoxes = 0;
  let rafId = 0;
  let lastWriteMs = -Infinity;
  let heavyOutput = false;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  const syncInactiveOverlay = (): boolean => {
    if (!term.hasSelection() || isSearchSelection() || !isEnabled()) {
      if (rafId !== 0 || activeBoxes > 0) {
        cancelFrame();
        clearOverlay();
      }
      return true;
    }
    return false;
  };

  const cache = new SelectionLineCache(() => {
    if (!syncInactiveOverlay() && !heavyOutput) {
      scheduleFrame();
    }
  });

  const ensureOverlay = (): HTMLDivElement | null => {
    if (overlay && overlay.isConnected) return overlay;
    const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) return null;
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = OVERLAY_CONTAINER_CLASS;
      overlay.setAttribute("aria-hidden", "true");
    }
    screen.prepend(overlay);
    return overlay;
  };

  const hideBoxesFrom = (startIndex: number) => {
    for (let i = startIndex; i < activeBoxes; i++) {
      const box = pool[i];
      if (box) box.style.display = "none";
    }
    activeBoxes = startIndex;
  };

  const clearOverlay = () => {
    hideBoxesFrom(0);
  };

  const cellDimensions = (screen: HTMLElement): { cellWidth: number; cellHeight: number } => {
    const w = parseFloat(screen.style.width) || screen.clientWidth;
    const h = parseFloat(screen.style.height) || screen.clientHeight;
    const cellWidth = w > 0 && term.cols > 0 ? w / term.cols : 8;
    const cellHeight = h > 0 && term.rows > 0 ? h / term.rows : 16;
    return { cellWidth, cellHeight };
  };

  const recompute = () => {
    rafId = 0;
    if (
      !isEnabled() ||
      isSearchSelection() ||
      heavyOutput ||
      !term.hasSelection() ||
      term.buffer.active.type === "alternate"
    ) {
      clearOverlay();
      return;
    }

    const container = ensureOverlay();
    if (!container || !container.parentElement) {
      clearOverlay();
      return;
    }

    const matches = findVisibleSelectionMatches(term, cache);
    if (!matches.length) {
      clearOverlay();
      return;
    }

    const { cellWidth, cellHeight } = cellDimensions(container.parentElement);
    const cols = term.cols;
    const rows = term.rows;
    const viewportY = term.buffer.active.viewportY;
    let boxIdx = 0;

    for (const match of matches) {
      let currentCol = match.col;
      let remaining = match.size;
      let currentRow = match.row;
      while (remaining > 0) {
        const width = Math.min(cols - currentCol, remaining);
        const viewportRow = currentRow - viewportY;
        if (viewportRow >= 0 && viewportRow < rows) {
          let box = pool[boxIdx];
          if (!box) {
            box = document.createElement("div");
            box.className = OVERLAY_MATCH_CLASS;
            pool.push(box);
            container.appendChild(box);
          }
          box.style.display = "block";
          box.style.top = `${viewportRow * cellHeight}px`;
          box.style.left = `${currentCol * cellWidth}px`;
          box.style.width = `${width * cellWidth}px`;
          box.style.height = `${cellHeight}px`;
          boxIdx++;
        }
        currentCol = 0;
        remaining -= width;
        currentRow++;
      }
    }

    hideBoxesFrom(boxIdx);
  };

  const scheduleFrame = () => {
    if (rafId !== 0 || heavyOutput) return;
    rafId = window.requestAnimationFrame(recompute);
  };

  const cancelFrame = () => {
    if (rafId !== 0) {
      window.cancelAnimationFrame(rafId);
      rafId = 0;
    }
  };

  const onWriteParsed = () => {
    cache.handleWriteParsed(term);
    if (syncInactiveOverlay()) return;
    const now = performance.now();
    const isBurst = now - lastWriteMs <= HEAVY_WRITE_WINDOW_MS;
    lastWriteMs = now;
    if (isBurst || heavyOutput) {
      heavyOutput = true;
      cancelFrame();
      clearOverlay();
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = undefined;
        heavyOutput = false;
        cache.clear();
        scheduleFrame();
      }, HEAVY_SETTLE_MS);
    } else {
      scheduleFrame();
    }
  };

  const disposables: IDisposable[] = [
    term.onSelectionChange(() => {
      if (syncInactiveOverlay()) return;
      scheduleFrame();
    }),
    term.onScroll(() => {
      if (syncInactiveOverlay()) return;
      if (!heavyOutput) {
        scheduleFrame();
      }
    }),
    term.onRender(({ start, end }) => {
      const viewportY = term.buffer.active.viewportY;
      cache.invalidateRange(viewportY + start, viewportY + end);
      if (!syncInactiveOverlay() && !heavyOutput) {
        scheduleFrame();
      }
    }),
    term.onResize(() => {
      cache.clear();
      if (!syncInactiveOverlay() && !heavyOutput) {
        scheduleFrame();
      }
    }),
    term.onWriteParsed(onWriteParsed),
    term.buffer.onBufferChange(() => {
      cache.clear();
      if (term.buffer.active.type === "alternate") {
        cancelFrame();
        clearOverlay();
      } else if (!syncInactiveOverlay()) {
        scheduleFrame();
      }
    }),
  ];

  return {
    cache,
    refresh() {
      cache.clear();
      cancelFrame();
      recompute();
    },
    clear() {
      cancelFrame();
      clearOverlay();
    },
    dispose() {
      cancelFrame();
      if (settleTimer !== undefined) {
        clearTimeout(settleTimer);
        settleTimer = undefined;
      }
      for (const d of disposables) d.dispose();
      overlay?.remove();
      overlay = null;
      pool.length = 0;
      activeBoxes = 0;
      cache.dispose();
    },
  };
}
