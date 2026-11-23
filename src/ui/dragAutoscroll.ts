import type { MouseEvent as ReactMouseEvent } from "react";

type TextField = HTMLInputElement | HTMLTextAreaElement;

let canvas: HTMLCanvasElement | null = null;

function textWidth(field: TextField): ((text: string) => number) | null {
  canvas ??= document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const s = getComputedStyle(field);
  ctx.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
  return (text) => ctx.measureText(text).width;
}

/** Column of `line` whose left edge is nearest to `x` (px from the line start). */
function columnAt(line: string, x: number, width: (text: string) => number): number {
  let lo = 0;
  let hi = line.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (width(line.slice(0, mid + 1)) < x) lo = mid + 1;
    else hi = mid;
  }
  if (lo < line.length && width(line.slice(0, lo + 1)) - x < x - width(line.slice(0, lo))) lo++;
  return lo;
}

/**
 * WebKitGTK extends a text field's selection while the mouse is dragged past
 * its left or right edge, but never scrolls the text along. While the pointer
 * is outside, move the selection focus and the scroll position ourselves, faster
 * the further out the pointer is, like IDEA's text fields.
 */
export function startDragAutoscroll(e: ReactMouseEvent<TextField>) {
  const field = e.currentTarget;
  if (e.defaultPrevented || e.button !== 0 || e.detail > 1 || field.selectionStart === null) return;
  // The canvas measures the real value, while the browser draws masking characters.
  if (field instanceof HTMLInputElement && field.type === "password") return;
  if (field.scrollWidth <= field.clientWidth || getComputedStyle(field).direction === "rtl") return;
  const width = textWidth(field);
  if (!width) return;
  let pointerX = e.clientX;
  let pointerY = e.clientY;
  let frame = 0;
  let anchor: number | null = null;
  let focus = 0;

  const edges = () => {
    const s = getComputedStyle(field);
    const rect = field.getBoundingClientRect();
    const left = rect.left + field.clientLeft;
    const start = left + parseFloat(s.paddingLeft);
    return {
      start,
      end: left + field.clientWidth - parseFloat(s.paddingRight),
      top: rect.top,
      bottom: rect.bottom,
    };
  };
  const overshoot = () => {
    const { start, end, top, bottom } = edges();
    if (field instanceof HTMLTextAreaElement && (pointerY < top || pointerY > bottom)) return 0;
    return pointerX < start ? pointerX - start : pointerX > end ? pointerX - end : 0;
  };

  const tick = () => {
    frame = 0;
    if (!field.isConnected || field.selectionStart === null) return stop();
    const over = overshoot();
    if (!over) {
      anchor = null;
      return;
    }
    if (anchor === null) {
      const backward = field.selectionDirection === "backward";
      anchor = (backward ? field.selectionEnd : field.selectionStart) ?? 0;
      focus = (backward ? field.selectionStart : field.selectionEnd) ?? 0;
    }
    const value = field.value;
    const lineStart = focus > 0 ? value.lastIndexOf("\n", focus - 1) + 1 : 0;
    const newline = value.indexOf("\n", focus);
    const line = value.slice(lineStart, newline < 0 ? value.length : newline);
    const { start, end } = edges();
    const visible = end - start;
    const step = Math.sign(over) * Math.min(Math.max(Math.abs(over) / 2, 2), 40);
    // Scroll by pixels even when the next caret position is more than one step away.
    const previous = field.scrollLeft;
    field.scrollLeft = previous + step;
    const scrolled = field.scrollLeft;
    focus = lineStart + columnAt(line, scrolled + (over < 0 ? 0 : visible), width);
    field.setSelectionRange(Math.min(anchor, focus), Math.max(anchor, focus), focus < anchor ? "backward" : "forward");
    field.scrollLeft = scrolled;
    if (scrolled !== previous) frame = requestAnimationFrame(tick);
  };

  const move = (ev: MouseEvent) => {
    if (!(ev.buttons & 1)) return stop();
    if (!field.isConnected) return stop();
    pointerX = ev.clientX;
    pointerY = ev.clientY;
    if (!overshoot()) {
      cancelAnimationFrame(frame);
      frame = 0;
      anchor = null;
      return;
    }
    // Our focus wins over WebKit's, which jumps to the line's start or end.
    ev.preventDefault();
    if (!frame) tick();
  };
  const stop = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    window.removeEventListener("mousemove", move, true);
    window.removeEventListener("mouseup", stop, true);
    window.removeEventListener("blur", stop);
    field.removeEventListener("blur", stop);
    field.removeEventListener("dragstart", stop);
  };
  window.addEventListener("mousemove", move, true);
  window.addEventListener("mouseup", stop, true);
  window.addEventListener("blur", stop);
  field.addEventListener("blur", stop);
  field.addEventListener("dragstart", stop);
}
