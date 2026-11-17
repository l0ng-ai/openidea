/** Text selected in `stream`, or "" when the selection is elsewhere. */
export function selectionIn(stream: HTMLElement): string {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return "";
  return stream.contains(sel.getRangeAt(0).commonAncestorContainer) ? sel.toString() : "";
}
