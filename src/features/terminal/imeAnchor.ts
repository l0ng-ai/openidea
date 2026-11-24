/**
 * Points the IME at the caret a full-screen program draws itself.
 *
 * xterm anchors the IME candidate window on its hidden helper textarea, which it keeps on the
 * terminal cursor: on every render, on `compositionstart`, and again on each `compositionupdate`.
 * A TUI that paints its own cursor hides the terminal's and leaves it wherever the frame's last
 * write ended — pi asks for a column past the right edge of its input box (`ESC[21;411H` in a
 * 206-column terminal, which xterm clamps to the last column) while it draws the caret itself at
 * column 5. The candidate window then opens at the far right of the input box, and every
 * composition started there keeps it there, because xterm re-places the textarea as the input
 * method opens.
 *
 * Nothing in the protocol reports where such a caret is, but the program draws it: a caret painted
 * with reverse video is an inverted cell, which xterm marks `xterm-bg-257`. While the hidden cursor
 * sits at the right edge (`EDGE_COLUMNS`) in the live viewport and one such cell stands out, that
 * cell is taken as the caret: one on the cursor's row wins, and a single one anywhere keeps working
 * when the program's own row tracking drifts. Anything else is a selection or a highlighted row.
 *
 * The textarea is moved with `left`/`top`, i.e. inside the terminal's box: Chromium reports that
 * rectangle to the input method, and a rectangle outside the window makes Windows open the
 * candidate window in the window's corner. xterm rewrites those properties from the cursor on its
 * own schedule, so the position is restored after every render, cursor move and composition event,
 * and again from a `style` observer, which lands in the microtask right after xterm's write.
 */
import type { Terminal } from "@xterm/xterm";

/** xterm's class for a cell drawn in `INVERTED_DEFAULT_COLOR` (reverse video). */
const INVERTED = "xterm-bg-257";

/**
 * How close to the right edge the terminal cursor has to be for the anchor to apply.
 *
 * Such a program asks for a column past the edge, and xterm clamps that to the last cell — but the
 * cursor it ends up with is not always the last cell: a wrapped pending cell (`cursorX` one past
 * the row) and requests clamped a cell or two short both showed up while typing in pi, and every
 * one of them has to count as "the program cannot place its own cursor".
 */
const EDGE_COLUMNS = 3;

export interface ImeAnchorOptions {
  /** The xterm host inside the pane, where `.xterm-screen` lives. */
  host: HTMLElement;
  term: Terminal;
}

/** One cell of the grid, in CSS pixels. */
interface Cell {
  width: number;
  height: number;
}

/** Where the helper textarea belongs, in the screen's own coordinates. */
interface Spot {
  left: number;
  top: number;
}

/**
 * The cell a program drew its caret in.
 *
 * Every inverted cell is a candidate — xterm draws the terminal's own cursor cell inverted too —
 * so the one sitting on the terminal cursor is dropped. The caret cell is normally on the cursor's
 * row, which is where a hardware cursor request clamped by column leaves it, but that row can drift:
 * pi ends up a few rows below its input box once the viewport scrolls. So a single candidate on the
 * cursor's row wins, a single candidate anywhere on screen is taken as well, and anything else is a
 * selection or a highlighted row, not a caret.
 */
function ownCaret(term: Terminal, host: HTMLElement, cell: Cell): Spot | undefined {
  const screen = host.querySelector<HTMLElement>(".xterm-screen");
  if (!screen || cell.width <= 0 || cell.height <= 0) return undefined;
  const cursor = term.buffer.active;
  const screenRect = screen.getBoundingClientRect();
  const cursorCol = Math.min(cursor.cursorX, term.cols - 1);
  const candidates: { rect: DOMRect; row: number }[] = [];
  for (const [row, element] of [...host.querySelectorAll<HTMLElement>(".xterm-rows > div")].entries()) {
    for (const span of element.children) {
      if (!span.classList.contains(INVERTED)) continue;
      const rect = span.getBoundingClientRect();
      // The terminal's own cursor: xterm renders its cell inverted as well.
      if (row === cursor.cursorY && Math.round((rect.left - screenRect.left) / cell.width) === cursorCol) continue;
      if (rect.width > screenRect.width / 2) continue;
      candidates.push({ rect, row });
    }
  }
  const onCursorRow = candidates.filter((c) => c.row === cursor.cursorY);
  const found = onCursorRow.length === 1 ? onCursorRow[0] : candidates.length === 1 ? candidates[0] : undefined;
  if (!found) return undefined;
  return { left: found.rect.left - screenRect.left, top: found.rect.top - screenRect.top };
}

/**
 * Keeps the IME anchor on the caret such a program draws. Returns a disposer.
 *
 * Runs after every render rather than on `compositionstart` alone: an input method asks the
 * focused element for its caret rectangle as it opens, and a reposition made from that event races
 * xterm's own handling of the same event, which puts the textarea back on the terminal cursor.
 */
export function installImeAnchor({ host, term }: ImeAnchorOptions): () => void {
  const textarea = term.textarea;
  if (!textarea) return () => {};
  const preedit = host.querySelector<HTMLElement>(".composition-view");
  const elements = preedit ? [textarea, preedit] : [textarea];

  /** The caret cell, or `null` while xterm's own placement is the right one. */
  let target: Spot | null = null;
  /** Whether the anchor currently holds a position of ours that xterm would undo. */
  let moved = false;
  /**
   * The last caret seen, as an offset from the terminal cursor's cell. A frame can miss it — the
   * program may be mid-redraw, or two cells of its caret may be on screen for a moment — and the
   * composition that opens in such a frame must not fall back to the far end of the row.
   */
  let caretFromCursor: Spot | null = null;

  const write = (spot: Spot | undefined) => {
    if (!spot) return;
    const left = `${spot.left}px`;
    const top = `${spot.top}px`;
    for (const { style } of elements) {
      if (style.left !== left) style.left = left;
      if (style.top !== top) style.top = top;
    }
  };

  /** What xterm itself writes: the cursor cell, clamped to the last column. */
  const cursorSpot = (): Spot | undefined => {
    const cols = term.cols;
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen || cols <= 0) return undefined;
    const screenRect = screen.getBoundingClientRect();
    const cell = { width: screenRect.width / cols, height: term.rows > 0 ? screenRect.height / term.rows : 0 };
    if (cell.width <= 0 || cell.height <= 0) return undefined;
    const cursor = term.buffer.active;
    return { left: Math.min(cursor.cursorX, cols - 1) * cell.width, top: cursor.cursorY * cell.height };
  };

  const place = () => {
    const cols = term.cols;
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    const buffer = term.buffer.active;
    target = null;
    const cursor = cursorSpot();
    if (
      screen &&
      cursor &&
      !term.modes.showCursor &&
      buffer.viewportY === buffer.baseY &&
      buffer.cursorX >= cols - EDGE_COLUMNS
    ) {
      const screenRect = screen.getBoundingClientRect();
      const cell = { width: screenRect.width / cols, height: term.rows > 0 ? screenRect.height / term.rows : 0 };
      const anchor = ownCaret(term, host, cell);
      if (anchor) caretFromCursor = { left: anchor.left - cursor.left, top: anchor.top - cursor.top };
      target =
        anchor ??
        (caretFromCursor && { left: cursor.left + caretFromCursor.left, top: cursor.top + caretFromCursor.top });
    } else {
      caretFromCursor = null;
    }
    if (target) {
      if (!moved) preedit?.setAttribute("data-openidea-ime-anchor", "");
      moved = true;
      write(target);
    } else if (moved) {
      // The drawn caret is gone: hand the position back to xterm.
      moved = false;
      preedit?.removeAttribute("data-openidea-ime-anchor");
      write(cursorSpot());
    }
  };

  // Registered after `open()`, so these run after xterm's own render and cursor handlers have
  // put the textarea back on the terminal cursor.
  const render = term.onRender(() => place());
  const cursorMove = term.onCursorMove(() => place());

  // xterm re-places the textarea as the input method opens and on every update; the observer lands
  // in the microtask after that write, before the browser asks for the caret rectangle.
  const observer = new MutationObserver(() => {
    if (target) write(target);
  });
  for (const element of elements) observer.observe(element, { attributes: true, attributeFilter: ["style"] });

  return () => {
    render.dispose();
    cursorMove.dispose();
    observer.disconnect();
    target = null;
    if (moved) {
      moved = false;
      preedit?.removeAttribute("data-openidea-ime-anchor");
      write(cursorSpot());
    }
  };
}
