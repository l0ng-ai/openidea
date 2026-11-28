/**
 * The caret of console output (Run, Debug): IDEA's console is a read-only editor, so Home / End
 * go to the start / end of the line, PageUp / PageDown move a page, ⌃Home / ⌃End (⌘ on macOS) go
 * to the start / end of the output and Shift extends the selection. Output rows are virtualized
 * DOM, so a position is a row and a UTF-16 offset into that row's text.
 */

export interface CaretPosition {
  row: number;
  offset: number;
}

export type CaretMove =
  | "left"
  | "right"
  | "up"
  | "down"
  | "lineStart"
  | "lineEnd"
  | "pageUp"
  | "pageDown"
  | "textStart"
  | "textEnd";

type Keys = Pick<KeyboardEvent, "key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey">;

/** The caret movement a keystroke stands for, or null when it is not one (word moves are not). */
export function caretKey(e: Keys, mac: boolean): { move: CaretMove; extend: boolean } | null {
  const primary = mac ? e.metaKey : e.ctrlKey;
  if (e.altKey || (mac ? e.ctrlKey : e.metaKey)) return null;
  const move = ((): CaretMove | null => {
    switch (e.key) {
      case "ArrowLeft":
        return primary ? (mac ? "lineStart" : null) : "left";
      case "ArrowRight":
        return primary ? (mac ? "lineEnd" : null) : "right";
      case "ArrowUp":
        return primary ? null : "up";
      case "ArrowDown":
        return primary ? null : "down";
      case "Home":
        return primary ? "textStart" : "lineStart";
      case "End":
        return primary ? "textEnd" : "lineEnd";
      case "PageUp":
        return primary ? null : "pageUp";
      case "PageDown":
        return primary ? null : "pageDown";
      default:
        return null;
    }
  })();
  return move ? { move, extend: e.shiftKey } : null;
}

export interface CaretRows {
  count: number;
  /** The row's text (a fold placeholder or the input row is empty). */
  text(row: number): string;
}

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * Where `move` takes the caret. `goal` is the column Up / Down / PageUp / PageDown keep through
 * shorter lines (IDEA keeps it until the caret moves sideways); the result carries the next one.
 */
export function moveCaret(
  rows: CaretRows,
  from: CaretPosition,
  move: CaretMove,
  page: number,
  goal: number | null = null,
): { position: CaretPosition; goal: number | null } {
  const last = Math.max(0, rows.count - 1);
  const row = Math.min(Math.max(from.row, 0), last);
  const text = rows.count ? rows.text(row) : "";
  const offset = Math.min(Math.max(from.offset, 0), text.length);
  const at = (r: number, o: number, g: number | null = null) => ({ position: { row: r, offset: o }, goal: g });
  const vertical = (delta: number) => {
    const target = Math.min(Math.max(row + delta, 0), last);
    const column = goal ?? offset;
    return at(target, Math.min(column, rows.count ? rows.text(target).length : 0), column);
  };
  switch (move) {
    case "left":
      if (offset > 0) return at(row, offset - (offset > 1 && isLowSurrogate(text.charCodeAt(offset - 1)) ? 2 : 1));
      return row > 0 ? at(row - 1, rows.text(row - 1).length) : at(row, 0);
    case "right":
      if (offset < text.length) return at(row, offset + (isLowSurrogate(text.charCodeAt(offset + 1)) ? 2 : 1));
      return row < last ? at(row + 1, 0) : at(row, offset);
    case "up":
      return vertical(-1);
    case "down":
      return vertical(1);
    case "pageUp":
      return vertical(-Math.max(1, page));
    case "pageDown":
      return vertical(Math.max(1, page));
    case "lineStart":
      return at(row, 0);
    case "lineEnd":
      return at(row, text.length);
    case "textStart":
      return at(0, 0);
    case "textEnd":
      return at(last, rows.count ? rows.text(last).length : 0);
  }
}

/** Marks DOM inside a row that is not part of its text (fold placeholders, typed input). */
const CARET_SKIP = "data-caret-skip";

/** The row's text nodes, without the placeholders and the line break after the text. */
function textNodes(row: Element): Text[] {
  const nodes: Text[] = [];
  const walker = row.ownerDocument.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentNode === row) continue;
    if (node.parentElement?.closest(`[${CARET_SKIP}], button`)) continue;
    nodes.push(node as Text);
  }
  return nodes;
}

/** The row element (`data-index`) under `host` that holds `node`. */
export function rowElement(host: Element, node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : node?.parentElement;
  const row = element?.closest<HTMLElement>("[data-index]");
  return row && host.contains(row) ? row : null;
}

/** A DOM selection point as a row and offset into its text, or null outside the rows. */
export function caretFromDom(host: Element, node: Node | null, offset: number): CaretPosition | null {
  const row = rowElement(host, node);
  if (!row || !node) return null;
  const nodes = textNodes(row);
  const before = row.ownerDocument.createRange();
  before.setStart(row, 0);
  before.setEnd(node, offset);
  let at = 0;
  for (const text of nodes) {
    if (text === node) return { row: Number(row.dataset.index), offset: at + Math.min(offset, text.length) };
    if (before.comparePoint(text, text.length) === 0) at += text.length;
  }
  return { row: Number(row.dataset.index), offset: at };
}

/** The DOM point of `offset` in a mounted row's text. */
export function domFromCaret(row: Element, offset: number): { node: Node; offset: number } {
  let at = 0;
  const nodes = textNodes(row);
  for (const text of nodes) {
    if (offset <= at + text.length) return { node: text, offset: offset - at };
    at += text.length;
  }
  const end = nodes[nodes.length - 1];
  return end ? { node: end, offset: end.length } : { node: row, offset: 0 };
}

/** The mounted row of index `row` under `host`. */
export function mountedRow(host: Element, row: number): HTMLElement | null {
  return host.querySelector<HTMLElement>(`[data-index="${row}"]`);
}

/** Where to draw the caret for `position`, relative to `origin`, or null when its row is not mounted. */
export function caretRect(
  host: Element,
  origin: Element,
  position: CaretPosition,
): { left: number; top: number; height: number } | null {
  const row = mountedRow(host, position.row);
  if (!row) return null;
  const base = origin.getBoundingClientRect();
  const point = domFromCaret(row, position.offset);
  const range = row.ownerDocument.createRange();
  range.setStart(point.node, point.offset);
  range.collapse(true);
  // jsdom has no layout for ranges; a blank row has no text box to measure.
  const rects = typeof range.getClientRects === "function" ? range.getClientRects() : [];
  const rect = rects[rects.length - 1];
  if (rect) return { left: rect.left - base.left, top: rect.top - base.top, height: rect.height };
  const box = row.getBoundingClientRect();
  const padding = parseFloat(getComputedStyle(row).paddingLeft) || 0;
  return { left: box.left - base.left + padding, top: box.top - base.top, height: box.height };
}
