import type { OutlineItem, Pos } from "@/platform/ipc";

const before = (a: Pos, b: Pos) => a.line < b.line || (a.line === b.line && a.col <= b.col);

/** Outline items enclosing (line, col), outermost first. */
export function symbolChain(items: readonly OutlineItem[], line: number, col: number): OutlineItem[] {
  const pos = { line, col };
  const out: OutlineItem[] = [];
  let level: readonly OutlineItem[] = items;
  for (;;) {
    const hit = level.find((i) => before(i.range.start, pos) && before(pos, i.range.end));
    if (!hit) return out;
    out.push(hit);
    level = hit.children;
  }
}

/** The chain up to the innermost item whose name (selection range) holds (line, col); empty off every name. */
export function declarationChain(items: readonly OutlineItem[], line: number, col: number): OutlineItem[] {
  const pos = { line, col };
  const chain = symbolChain(items, line, col);
  const named = chain.findLastIndex((i) => before(i.selection_range.start, pos) && before(pos, i.selection_range.end));
  return chain.slice(0, named + 1);
}
