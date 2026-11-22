import { Direction, repositionTooltips, type EditorView, type Rect, type TooltipView } from "@codemirror/view";
import { hoverCard } from "@/editor/lsp/hover";
import { tx } from "@/platform/i18n";
import { lockDragCursor } from "@/ui/dragCursor";
import styles from "./decorationHover.module.css";

type Edge = "n" | "e" | "s" | "w" | "se";
type Bounds = Pick<DOMRect, "left" | "top" | "width" | "height">;

/** Keep sizing local to plugin cards; CodeMirror still owns placement and dismissal. */
export function resizableDecorationHover(
  view: EditorView,
  markdown: HTMLElement,
  options: {
    anchor?: () => HTMLElement | null;
    position: number;
    close: () => void;
    containsSource: (event: MouseEvent) => boolean;
  },
): TooltipView & { content: HTMLElement } {
  const content = document.createElement("div");
  content.className = styles.content!;
  content.tabIndex = 0;
  content.setAttribute("role", "region");
  content.setAttribute("aria-label", tx("Conversation"));
  content.append(markdown);
  const dom = hoverCard([content]);
  dom.classList.add(styles.card!);
  const win = dom.ownerDocument.defaultView!;
  const offset = { x: 0, y: 0 };
  let bounds: Bounds | null = null;
  let chrome = { width: 0, height: 0 };
  let above = true;
  let disposed = false;
  let stopDrag: (() => void) | undefined;

  const anchorRect = () =>
    options.anchor ? options.anchor()?.getBoundingClientRect() : view.coordsAtPos(options.position);

  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
  const limits = () => {
    const margin = Number.parseFloat(win.getComputedStyle(dom).getPropertyValue("--space-3")) || 12;
    return {
      margin,
      width: Math.max(1, win.innerWidth - margin * 2),
      height: Math.max(1, win.innerHeight - margin * 2),
    };
  };
  const apply = (next: Bounds) => {
    if (disposed) return;
    const { margin, width: maxWidth, height: maxHeight } = limits();
    const width = clamp(next.width, Math.min(240, maxWidth), maxWidth);
    const height = clamp(next.height, Math.min(120, maxHeight), maxHeight);
    bounds = {
      left: clamp(next.left, margin, win.innerWidth - margin - width),
      top: clamp(next.top, margin, win.innerHeight - margin - height),
      width,
      height,
    };
    dom.dataset.resized = "";
    dom.style.width = `${Math.max(1, width - chrome.width)}px`;
    dom.style.height = `${Math.max(1, height - chrome.height)}px`;
    repositionTooltips(view);
  };
  const measure = () => {
    const surface = dom.closest<HTMLElement>(".cm-tooltip") ?? dom;
    const rect = surface.getBoundingClientRect();
    const card = dom.getBoundingClientRect();
    chrome = { width: Math.max(0, rect.width - card.width), height: Math.max(0, rect.height - card.height) };
    above = surface.classList.contains("cm-tooltip-above");
    return rect;
  };
  const resize = (edge: Edge, start: Bounds, dx: number, dy: number) => {
    const { margin, width, height } = limits();
    const minWidth = Math.min(240, width),
      minHeight = Math.min(120, height);
    let left = start.left,
      top = start.top;
    let right = left + start.width,
      bottom = top + start.height;
    if (edge === "w") left = clamp(left + dx, margin, right - minWidth);
    if (edge === "n") top = clamp(top + dy, margin, bottom - minHeight);
    if (edge.includes("e")) right = clamp(right + dx, left + minWidth, win.innerWidth - margin);
    if (edge.includes("s")) bottom = clamp(bottom + dy, top + minHeight, win.innerHeight - margin);
    apply({ left, top, width: right - left, height: bottom - top });
  };
  const labels = {
    n: tx("Resize conversation from the top"),
    e: tx("Resize conversation from the right"),
    s: tx("Resize conversation from the bottom"),
    w: tx("Resize conversation from the left"),
    se: tx("Resize conversation from the corner"),
  };
  for (const edge of ["n", "e", "s", "w", "se"] as const) {
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = styles.resizeHandle!;
    handle.dataset.edge = edge;
    handle.setAttribute("aria-label", labels[edge]);
    handle.addEventListener("pointerdown", (event) => {
      if (disposed || event.button !== 0 || event.isPrimary === false) return;
      event.preventDefault();
      event.stopPropagation();
      stopDrag?.();
      const start = measure();
      const releaseCursor = lockDragCursor(
        edge === "se" ? "nwse-resize" : edge === "e" || edge === "w" ? "ew-resize" : "ns-resize",
      );
      const move = (e: PointerEvent) => {
        if (e.pointerId !== event.pointerId) return;
        if (!(e.buttons & 1)) return finish();
        resize(edge, start, e.clientX - event.clientX, e.clientY - event.clientY);
      };
      const end = (e: PointerEvent) => {
        if (e.pointerId === event.pointerId) finish();
      };
      const key = (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        finish();
      };
      const finish = () => {
        win.removeEventListener("pointermove", move);
        win.removeEventListener("pointerup", end);
        win.removeEventListener("pointercancel", end);
        win.removeEventListener("blur", finish);
        win.removeEventListener("keydown", key, true);
        handle.removeEventListener("lostpointercapture", end);
        if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId);
        releaseCursor();
        stopDrag = undefined;
      };
      stopDrag = finish;
      win.addEventListener("pointermove", move);
      win.addEventListener("pointerup", end);
      win.addEventListener("pointercancel", end);
      win.addEventListener("blur", finish);
      win.addEventListener("keydown", key, true);
      handle.addEventListener("lostpointercapture", end);
      handle.setPointerCapture?.(event.pointerId);
    });
    handle.addEventListener("keydown", (event) => {
      if (disposed || stopDrag) return;
      const step = event.shiftKey ? 32 : 8;
      const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
      const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
      if (
        !(
          (dx && (edge === "e" || edge === "w" || edge === "se")) ||
          (dy && (edge === "n" || edge === "s" || edge === "se"))
        )
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      resize(edge, measure(), dx, dy);
    });
    dom.append(handle);
  }
  const contains = (rect: Rect, x: number, y: number) =>
    x >= rect.left - 4 && x <= rect.right + 4 && y >= rect.top - 4 && y <= rect.bottom + 4;
  const bridge = (a: Rect, b: Rect, x: number, y: number) => {
    if (a.bottom > b.top || y < a.bottom - 4 || y > b.top + 4) return false;
    const fraction = a.bottom === b.top ? 0.5 : clamp((y - a.bottom) / (b.top - a.bottom), 0, 1);
    return x >= a.left + (b.left - a.left) * fraction - 4 && x <= a.right + (b.right - a.right) * fraction + 4;
  };
  const transpose = (rect: Rect): Rect => ({ left: rect.top, right: rect.bottom, top: rect.left, bottom: rect.right });
  const keepOpen = (event: MouseEvent) => {
    if (stopDrag || options.containsSource(event)) return true;
    const target = event.type === "mouseleave" ? event.relatedTarget : event.target;
    if (target instanceof Node && (dom.contains(target) || options.anchor?.()?.contains(target))) return true;
    const anchor = anchorRect();
    if (!anchor) return false;
    const surface = (dom.closest<HTMLElement>(".cm-tooltip") ?? dom).getBoundingClientRect();
    const { clientX: x, clientY: y } = event;
    return (
      contains(anchor, x, y) ||
      contains(surface, x, y) ||
      bridge(anchor, surface, x, y) ||
      bridge(surface, anchor, x, y) ||
      bridge(transpose(anchor), transpose(surface), y, x) ||
      bridge(transpose(surface), transpose(anchor), y, x)
    );
  };
  // The provider is explicitly activated; observe its lifetime without intercepting other providers.
  const moveOver = (event: MouseEvent) => {
    if (!keepOpen(event)) options.close();
  };
  const clickOutside = (event: PointerEvent) => {
    if (!(event.target instanceof Node) || (!dom.contains(event.target) && !options.anchor?.()?.contains(event.target)))
      options.close();
  };
  const closeOnEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape") options.close();
  };
  win.addEventListener("mousemove", moveOver, true);
  win.addEventListener("pointerdown", clickOutside, true);
  win.addEventListener("keydown", closeOnEscape, true);
  win.addEventListener("blur", options.close);
  dom.ownerDocument.documentElement.addEventListener("mouseleave", options.close);

  const fitViewport = () => {
    stopDrag?.();
    if (bounds) apply(bounds);
  };
  win.addEventListener("resize", fitViewport);
  return {
    dom,
    content,
    offset,
    resize: false,
    getCoords: () => {
      const anchor = anchorRect();
      if (!anchor) {
        // Keep unrendered anchors clipped while satisfying TooltipView's non-null contract.
        const top = view.scrollDOM.getBoundingClientRect().top - 1;
        return { left: 0, right: 0, top, bottom: top };
      }
      if (bounds) {
        offset.x =
          view.textDirection === Direction.RTL ? anchor.left - bounds.width - bounds.left : bounds.left - anchor.left;
        offset.y = above ? anchor.top - bounds.top - bounds.height : bounds.top - anchor.bottom;
      }
      return anchor;
    },
    destroy: () => {
      disposed = true;
      stopDrag?.();
      win.removeEventListener("resize", fitViewport);
      win.removeEventListener("mousemove", moveOver, true);
      win.removeEventListener("pointerdown", clickOutside, true);
      win.removeEventListener("keydown", closeOnEscape, true);
      win.removeEventListener("blur", options.close);
      dom.ownerDocument.documentElement.removeEventListener("mouseleave", options.close);
    },
  };
}
