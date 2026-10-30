import { useEffect, type RefObject } from "react";

/** Keep selections started in a reading pane from extending into neighboring panes. */
export function useSelectionBoundary(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const doc = root.ownerDocument;
    const clamp = () => {
      const selection = doc.getSelection();
      if (
        !selection?.anchorNode ||
        !selection.focusNode ||
        selection.isCollapsed ||
        !root.contains(selection.anchorNode) ||
        root.contains(selection.focusNode)
      )
        return;

      const bounds = doc.createRange();
      bounds.selectNodeContents(root);
      const before = bounds.comparePoint(selection.focusNode, selection.focusOffset) < 0;
      selection.setBaseAndExtent(
        selection.anchorNode,
        selection.anchorOffset,
        root,
        before ? 0 : root.childNodes.length,
      );
    };
    doc.addEventListener("selectionchange", clamp);
    return () => doc.removeEventListener("selectionchange", clamp);
  }, [ref]);
}
