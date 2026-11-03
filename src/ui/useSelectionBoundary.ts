import { useEffect, type RefObject } from "react";

/** Keep selections started in a reading pane from extending into neighboring panes. */
export function useSelectionBoundary(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const doc = root.ownerDocument;
    const clamp = () => {
      const selection = doc.getSelection();
      if (!selection?.anchorNode || !selection.focusNode || selection.isCollapsed) return;
      const anchorIn = root.contains(selection.anchorNode);
      const focusIn = root.contains(selection.focusNode);
      if (anchorIn === focusIn) return;

      const bounds = doc.createRange();
      bounds.selectNodeContents(root);
      const outside = anchorIn
        ? { node: selection.focusNode, offset: selection.focusOffset }
        : { node: selection.anchorNode, offset: selection.anchorOffset };
      const edge = bounds.comparePoint(outside.node, outside.offset) < 0 ? 0 : root.childNodes.length;
      if (anchorIn) selection.setBaseAndExtent(selection.anchorNode, selection.anchorOffset, root, edge);
      else selection.setBaseAndExtent(root, edge, selection.focusNode, selection.focusOffset);
    };
    // While a drag starts in the pane, make everything outside it unselectable so the
    // browser never extends the selection there (see global.css).
    const html = doc.documentElement;
    const lock = (e: MouseEvent) => {
      if (e.button === 0) html.setAttribute("data-selection-lock", "");
    };
    const unlock = () => html.removeAttribute("data-selection-lock");
    root.setAttribute("data-selection-scope", "");
    root.addEventListener("mousedown", lock);
    doc.addEventListener("mouseup", unlock, true);
    doc.addEventListener("dragend", unlock, true);
    doc.addEventListener("selectionchange", clamp);
    return () => {
      root.removeAttribute("data-selection-scope");
      root.removeEventListener("mousedown", lock);
      doc.removeEventListener("mouseup", unlock, true);
      doc.removeEventListener("dragend", unlock, true);
      doc.removeEventListener("selectionchange", clamp);
      unlock();
    };
  }, [ref]);
}
