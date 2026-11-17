import { useEffect, type RefObject } from "react";
import { hasPrimaryModifier } from "@/platform/keymap";

/** Keep selections started in a reading pane from extending into neighboring panes. */
export function useSelectionBoundary(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const doc = root.ownerDocument;
    // WebKit's repaint of a shrinking selection misses the gap fills between blocks by a device
    // pixel at fractional positions, leaving a stripe; repaint the pane once per frame instead.
    let frame = 0;
    const repaint = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        root.style.opacity = "0.9999";
        frame = requestAnimationFrame(() => {
          frame = 0;
          root.style.removeProperty("opacity");
        });
      });
    };
    const clamp = () => {
      const selection = doc.getSelection();
      if (!selection?.anchorNode || !selection.focusNode) return;
      const anchorIn = root.contains(selection.anchorNode);
      const focusIn = root.contains(selection.focusNode);
      if (anchorIn || focusIn) repaint();
      if (selection.isCollapsed || anchorIn === focusIn) return;

      const bounds = doc.createRange();
      bounds.selectNodeContents(root);
      const outside = anchorIn
        ? { node: selection.focusNode, offset: selection.focusOffset }
        : { node: selection.anchorNode, offset: selection.anchorOffset };
      const edge = textEdge(root, bounds.comparePoint(outside.node, outside.offset) < 0 ? "start" : "end");
      if (anchorIn) selection.setBaseAndExtent(selection.anchorNode, selection.anchorOffset, edge.node, edge.offset);
      else selection.setBaseAndExtent(edge.node, edge.offset, selection.focusNode, selection.focusOffset);
    };
    // While a drag starts in the pane, make everything outside it unselectable so the
    // browser never extends the selection there (see global.css).
    const html = doc.documentElement;
    // A double or triple click selects a word or line at once and can reach past the pane's
    // last text into the next field (the composer). `selectionchange` comes after a paint, which
    // flashes that selection; a frame callback clamps it before.
    let clampFrame = 0;
    const clampBeforePaint = () => {
      cancelAnimationFrame(clampFrame);
      clampFrame = requestAnimationFrame(clamp);
    };
    const lock = (e: MouseEvent) => {
      if (e.button !== 0) return;
      html.setAttribute("data-selection-lock", "");
      clampBeforePaint();
    };
    const unlock = () => {
      if (!html.hasAttribute("data-selection-lock")) return;
      html.removeAttribute("data-selection-lock");
      clampBeforePaint();
    };
    // Select All in the pane selects its text; the browser's would select across the whole
    // window (Ctrl+A reaches the webview directly; ⌘A goes to the native Select All).
    const selectAll = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "a" || !hasPrimaryModifier(e) || e.shiftKey || e.altKey) return;
      if (!selectReadingPane(e.target as Element)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    root.setAttribute("data-selection-scope", "");
    root.addEventListener("keydown", selectAll);
    root.addEventListener("mousedown", lock);
    doc.addEventListener("mouseup", unlock, true);
    doc.addEventListener("dragend", unlock, true);
    doc.addEventListener("selectionchange", clamp);
    return () => {
      root.removeAttribute("data-selection-scope");
      root.removeEventListener("keydown", selectAll);
      root.removeEventListener("mousedown", lock);
      doc.removeEventListener("mouseup", unlock, true);
      doc.removeEventListener("dragend", unlock, true);
      doc.removeEventListener("selectionchange", clamp);
      cancelAnimationFrame(frame);
      cancelAnimationFrame(clampFrame);
      root.style.removeProperty("opacity");
      unlock();
    };
  }, [ref]);
}

/**
 * The first or last selectable text position in `root`. Its own boundary (`root`, 0 or its
 * child count) won't do: WebKit paints a selection ending there up to the next selectable
 * position after the pane, which can be the composer's text field.
 */
function textEdge(root: HTMLElement, side: "start" | "end"): { node: Node; offset: number } {
  const view = root.ownerDocument.defaultView;
  const unselectable = (el: Element | null): boolean => {
    for (; el && el !== root; el = el.parentElement) {
      const style = view?.getComputedStyle(el);
      if (style?.userSelect === "none" || style?.webkitUserSelect === "none") return true;
    }
    return false;
  };
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.textContent?.trim() && !unselectable(node.parentElement) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
  });
  const text = side === "start" ? walker.firstChild() : walker.lastChild();
  if (!text) return { node: root, offset: side === "start" ? 0 : root.childNodes.length };
  return { node: text, offset: side === "start" ? 0 : text.textContent!.length };
}

/**
 * Selects the text of the reading pane (`useSelectionBoundary`) that `focused` is in, unless it
 * is an editable field, which selects its own text. False when it isn't in one.
 */
export function selectReadingPane(focused: Element | null): boolean {
  if (!(focused instanceof HTMLElement) || focused.isContentEditable) return false;
  if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) return false;
  const pane = focused.closest<HTMLElement>("[data-selection-scope]");
  const selection = pane?.ownerDocument.getSelection();
  if (!pane || !selection) return false;
  // From the first to the last text, not the pane's own boundaries, which WebKit paints into
  // the field after the pane (the composer).
  const start = textEdge(pane, "start");
  const end = textEdge(pane, "end");
  selection.setBaseAndExtent(start.node, start.offset, end.node, end.offset);
  return true;
}
