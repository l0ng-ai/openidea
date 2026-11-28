import { useEffect, useEffectEvent, useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import { isMacHost } from "@/platform/keymap";
import {
  caretFromDom,
  caretKey,
  caretRect,
  domFromCaret,
  mountedRow,
  moveCaret,
  type CaretPosition,
  type CaretRows,
} from "@/ui/consoleCaret";

export interface ConsoleCaretOptions {
  /** The scrolling output. */
  host: RefObject<HTMLDivElement | null>;
  /** The rows' container, which the caret is drawn in (as its first child). */
  inner: RefObject<HTMLDivElement | null>;
  rows: CaretRows;
  follow: boolean;
  onFollowChange(follow: boolean): void;
  /** Rows a PageUp / PageDown moves. */
  pageRows(): number;
  /** The row at the top of the viewport, where a caret starts when there is none yet. */
  topRow(): number;
  /** Scrolls a row into view; a page move scrolls the view by the `page` rows the caret moved. */
  reveal(row: number, page: number): void;
  /** Called right before the caret sets the browser's selection. */
  markKeyboardSelection(): void;
}

type Span = { anchor: CaretPosition; focus: CaretPosition };

const same = (a: CaretPosition | null | undefined, b: CaretPosition | null | undefined) =>
  a?.row === b?.row && a?.offset === b?.offset;

/** Room kept between the caret and the side of the viewport when scrolling sideways to it. */
const SIDE_MARGIN = 24;

/**
 * The console's caret is the browser's selection (its focus end), so the mouse and the keyboard
 * share it. Movement keys compute the next position over the rows and set the selection; a row
 * that is not mounted yet (PageDown, ⌃End) is scrolled to and selected after the next render.
 */
export function useConsoleCaret(options: ConsoleCaretOptions) {
  const { host, inner, rows } = options;
  /** A move waiting for its row to mount; key repeat moves on from it, not from the stale DOM. */
  const pending = useRef<Span | null>(null);
  /** Where the keyboard last put the caret (a different selection is the user's own). */
  const placed = useRef<CaretPosition | null>(null);
  const goal = useRef<number | null>(null);
  /** The caret sits at the end of the output and stays there as output arrives (IDEA). */
  const atEnd = useRef(false);
  const revealSide = useRef(false);
  /** The drawn caret: placed directly, as it follows layout rather than state. */
  const caretRef = useRef<HTMLDivElement>(null);

  const selected = (): (Span & { collapsed: boolean }) | null => {
    const el = host.current;
    const selection = window.getSelection();
    if (!el || !selection?.focusNode) return null;
    const focus = caretFromDom(el, selection.focusNode, selection.focusOffset);
    if (!focus) return null;
    const anchor = caretFromDom(el, selection.anchorNode, selection.anchorOffset) ?? focus;
    return { anchor, focus, collapsed: selection.isCollapsed };
  };

  const endOf = (): CaretPosition => {
    const last = Math.max(0, rows.count - 1);
    return { row: last, offset: rows.count ? rows.text(last).length : 0 };
  };

  const measure = () => {
    const el = host.current;
    const origin = inner.current;
    const caret = selected();
    const next = el && origin && caret ? caretRect(el, origin, caret.focus) : null;
    const drawn = caretRef.current;
    if (drawn) {
      drawn.hidden = !next;
      if (next) {
        drawn.style.transform = `translate(${next.left}px, ${next.top}px)`;
        drawn.style.height = `${next.height}px`;
      }
    }
    if (!el || !next || !revealSide.current) return;
    revealSide.current = false;
    if (next.left < el.scrollLeft + SIDE_MARGIN) el.scrollTo({ left: Math.max(0, next.left - SIDE_MARGIN) });
    else if (next.left > el.scrollLeft + el.clientWidth - SIDE_MARGIN)
      el.scrollTo({ left: next.left - el.clientWidth + SIDE_MARGIN });
  };

  /** Sets the selection for the pending move once both of its rows are mounted. */
  const apply = () => {
    const el = host.current;
    const move = pending.current;
    if (!el || !move) return;
    // The output was cleared or cut under a move that never landed.
    if (Math.max(move.focus.row, move.anchor.row) >= rows.count) pending.current = null;
    const focusRow = mountedRow(el, move.focus.row);
    const anchorRow = mountedRow(el, move.anchor.row);
    if (!focusRow || !anchorRow) return;
    pending.current = null;
    const anchor = domFromCaret(anchorRow, move.anchor.offset);
    const focus = domFromCaret(focusRow, move.focus.offset);
    options.markKeyboardSelection();
    placed.current = move.focus;
    revealSide.current = true;
    window.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
  };

  const onSelectionChange = useEffectEvent(() => {
    // A click, a drag or a cleared selection: forget the column and the end of the output.
    if (!pending.current && !same(selected()?.focus, placed.current)) {
      placed.current = null;
      goal.current = null;
      atEnd.current = false;
    }
    measure();
  });
  useEffect(() => {
    const listener = () => onSelectionChange();
    document.addEventListener("selectionchange", listener);
    return () => document.removeEventListener("selectionchange", listener);
  }, []);

  // Every render: rows mount and move (new output, folds, soft wrap), so the caret is placed again.
  useLayoutEffect(() => {
    if (atEnd.current && !pending.current && options.follow && rows.count) {
      const caret = selected();
      const end = endOf();
      if (caret?.collapsed && !same(caret.focus, end)) pending.current = { anchor: end, focus: end };
    }
    apply();
    measure();
  });

  /** Handles a caret movement key; returns whether it was one. */
  const onKeyDown = (e: KeyboardEvent): boolean => {
    const key = caretKey(e, isMacHost());
    if (!key || !rows.count) return false;
    e.preventDefault();
    const current = pending.current ?? selected() ?? startSpan();
    const next = moveCaret(rows, current.focus, key.move, options.pageRows(), goal.current);
    goal.current = next.goal;
    const focus = next.position;
    pending.current = { anchor: key.extend ? current.anchor : focus, focus };
    const end = same(focus, endOf());
    atEnd.current = end && !key.extend;
    if (end !== options.follow) options.onFollowChange(end);
    const paged = key.move === "pageUp" || key.move === "pageDown";
    options.reveal(focus.row, paged ? focus.row - current.focus.row : 0);
    apply();
    measure();
    return true;
  };

  /** No caret yet: it is at the end of followed output, else at the top of the viewport. */
  const startSpan = (): Span => {
    const start = options.follow ? endOf() : { row: options.topRow(), offset: 0 };
    return { anchor: start, focus: start };
  };

  /** Typing goes to the input at the end of the output: the caret leaves the output, as in IDEA. */
  const leaveOutput = () => {
    pending.current = null;
    const caret = selected();
    if (!caret?.collapsed) return;
    window.getSelection()?.removeAllRanges();
    measure();
  };

  return { onKeyDown, caretRef, leaveOutput };
}
