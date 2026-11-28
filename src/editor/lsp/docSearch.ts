/** Literal, case-insensitive search over the rendered documentation DOM. */
export const DOC_SEARCH_MATCH = "data-doc-search-match";
export const DOC_SEARCH_CURRENT = "data-doc-search-current";

/** One logical match can span several inline elements, so it has several marks. */
export type DocSearchMatch = HTMLElement[];

const HIDDEN_TEXT = `script, style, noscript, template, [aria-hidden="true"], .katex-mathml, mjx-assistive-mml`;
const REGEXP_CHAR = /[.*+?^${}()|[\]\\]/g;

/** Removes only the marks created here, preserving the rendered markup and its text. */
export function clearDocSearch(root: HTMLElement, marks?: Iterable<HTMLElement>): void {
  const highlights = marks ?? root.querySelectorAll<HTMLElement>(`[${DOC_SEARCH_MATCH}]`);
  for (const mark of highlights) mark.replaceWith(...mark.childNodes);
}

/**
 * Finds every non-overlapping literal match and wraps its text-node ranges in marks.
 * The query is escaped before becoming a RegExp; matched text is moved with Range,
 * never parsed as HTML. Ranges are wrapped back-to-front so earlier offsets stay valid.
 */
export function highlightDocSearch(root: HTMLElement, query: string): DocSearchMatch[] {
  clearDocSearch(root);
  if (!query) return [];

  const nodes: Text[] = [];
  const parts: string[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest(HIDDEN_TEXT) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (text.data) {
      nodes.push(text);
      parts.push(text.data);
    }
  }

  const pattern = new RegExp(query.replace(REGEXP_CHAR, "\\$&"), "giu");
  const matches: DocSearchMatch[] = [];
  const pending: { range: Range; mark: HTMLElement }[] = [];
  const text = parts.join("");
  for (let found = pattern.exec(text); found; found = pattern.exec(text)) {
    const marks: HTMLElement[] = [];
    let offset = 0;
    for (const node of nodes) {
      const end = offset + node.data.length;
      if (end > found.index && offset < found.index + found[0].length) {
        const range = root.ownerDocument.createRange();
        range.setStart(node, Math.max(0, found.index - offset));
        range.setEnd(node, Math.min(node.data.length, found.index + found[0].length - offset));
        const mark = root.ownerDocument.createElement("mark");
        mark.setAttribute(DOC_SEARCH_MATCH, String(matches.length));
        pending.push({ range, mark });
        marks.push(mark);
      }
      offset = end;
      if (offset >= found.index + found[0].length) break;
    }
    matches.push(marks);
  }
  for (let i = pending.length - 1; i >= 0; i--) pending[i]!.range.surroundContents(pending[i]!.mark);
  return matches;
}

/** Selects one logical match, scrolling its first visible fragment into view unless disabled. */
export function activateDocMatch(
  matches: readonly DocSearchMatch[],
  index: number,
  { scroll = true }: { scroll?: boolean } = {},
): void {
  for (const match of matches) for (const mark of match) mark.removeAttribute(DOC_SEARCH_CURRENT);
  const marks = matches[index];
  if (!marks?.length) return;
  for (const mark of marks) mark.setAttribute(DOC_SEARCH_CURRENT, "");
  if (scroll) marks[0]!.scrollIntoView({ block: "center", inline: "nearest" });
}
