/**
 * Keeps a double- or triple-click selection inside the conversation row it was made in. WebKit
 * extends a word or paragraph at the end of a message past its unselectable footer, into the next
 * message.
 */
export function clampSelectionToRow(selection: Selection | null, row: Element) {
  if (!selection?.rangeCount) return;
  const range = selection.getRangeAt(0);
  const startInside = row.contains(range.startContainer);
  const endInside = row.contains(range.endContainer);
  if (startInside && endInside) return;
  const texts = selectableTexts(row);
  const first = texts[0];
  const last = texts.at(-1);
  if (!first || !last) return;
  if (!startInside && !endInside) {
    // The whole selection went past the row: none of the row's text is in it.
    selection.collapse(last, last.length);
    return;
  }
  const [startNode, startOffset] = startInside ? [range.startContainer, range.startOffset] : [first, 0];
  const [endNode, endOffset] = endInside ? [range.endContainer, range.endOffset] : [last, last.length];
  const backward = selection.anchorNode === range.endContainer && selection.anchorOffset === range.endOffset;
  if (backward) selection.setBaseAndExtent(endNode, endOffset, startNode, startOffset);
  else selection.setBaseAndExtent(startNode, startOffset, endNode, endOffset);
}

function selectableTexts(row: Element): Text[] {
  const texts: Text[] = [];
  const walker = row.ownerDocument.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!node.nodeValue?.trim() || !parent) continue;
    const style = getComputedStyle(parent);
    if (style.userSelect === "none" || style.webkitUserSelect === "none") continue;
    texts.push(node as Text);
  }
  return texts;
}
