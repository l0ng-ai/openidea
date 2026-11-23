/**
 * Comments and string literals of a document, for the find bar's search
 * context ("In Comments", "Except String Literals" …): from the Lezer syntax
 * tree, or from the backend's tree-sitter highlights for languages without a
 * CodeMirror mode.
 */
import { StateField, type EditorState } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { Tree } from "@lezer/common";
import { highlightTree, tagHighlighter, tags as t } from "@lezer/highlight";
import type { SyntaxHighlightKind } from "@/platform/ipc";
import type { LiteralKind } from "@/platform/search";
import { setSyntaxHighlights } from "./syntaxHighlight";

/** Sorted, non-overlapping `[from, to)` ranges. */
export interface LiteralRange {
  from: number;
  to: number;
  kind: LiteralKind;
}

const KINDS: Partial<Record<SyntaxHighlightKind, LiteralKind>> = {
  comment: "comment",
  docComment: "comment",
  string: "string",
  stringSpecial: "string",
  escape: "string",
};

/** Literal ranges of the tree-sitter highlights, mapped through edits until the next refresh. */
const treeSitterLiterals = StateField.define<readonly LiteralRange[]>({
  create: () => [],
  update(v, tr) {
    for (const e of tr.effects) {
      if (!e.is(setSyntaxHighlights)) continue;
      const { kinds, data } = e.value;
      const out: LiteralRange[] = [];
      for (let i = 0; i + 2 < data.length; i += 3) {
        const kind = KINDS[kinds[data[i + 2]!]!];
        if (kind) push(out, data[i]!, data[i + 1]!, kind);
      }
      return out;
    }
    if (!tr.docChanged || !v.length) return v;
    return v
      .map((r) => ({ from: tr.changes.mapPos(r.from, 1), to: tr.changes.mapPos(r.to, -1), kind: r.kind }))
      .filter((r) => r.to > r.from);
  },
});

export const literalsExtension = treeSitterLiterals;

const highlighter = tagHighlighter([
  { tag: t.comment, class: "comment" },
  { tag: t.string, class: "string" },
]);

function push(out: LiteralRange[], from: number, to: number, kind: LiteralKind) {
  const last = out[out.length - 1];
  if (last && last.kind === kind && last.to >= from) last.to = Math.max(last.to, to);
  else if (to > from) out.push({ from, to, kind });
}

const cache = new WeakMap<object, readonly LiteralRange[]>();
/** How long counting may wait for the parser to reach the end of the document. */
const PARSE_BUDGET_MS = 50;

/** Comments and string literals of `tree` between `from` and `to`; a literal reaching past either end is cut there. */
function highlightedLiterals(tree: Tree, from: number, to: number): LiteralRange[] {
  const out: LiteralRange[] = [];
  highlightTree(
    tree,
    highlighter,
    (start, end, cls) => {
      const kind: LiteralKind | null = cls.includes("comment") ? "comment" : cls.includes("string") ? "string" : null;
      if (kind) push(out, start, end, kind);
    },
    from,
    to,
  );
  return out;
}

/** Comments and string literals of `state` (cached per syntax tree). */
export function literalRanges(state: EditorState): readonly LiteralRange[] {
  const tree = ensureSyntaxTree(state, state.doc.length, PARSE_BUDGET_MS) ?? syntaxTree(state);
  if (tree.length === 0) return state.field(treeSitterLiterals, false) ?? [];
  const hit = cache.get(tree);
  if (hit) return hit;
  const out = highlightedLiterals(tree, 0, tree.length);
  cache.set(tree, out);
  return out;
}

/** What `pos` lies in: a comment, a string literal or plain code (`null`). */
export function literalKindAt(state: EditorState, pos: number): LiteralKind | null {
  return literalAt(state, pos)?.kind ?? null;
}

/** The comment or string literal `pos` lies in, if any. */
export function literalAt(state: EditorState, pos: number): LiteralRange | null {
  return rangeAt(literalRanges(state), pos);
}

/**
 * Like `literalAt`, for a caller that only wants literals within one line: it parses and highlights
 * the line of `pos` and the line breaks around it, not the document. A literal that goes on past
 * the line comes back cut at the line break, so it still reaches into another line.
 */
export function lineLiteralAt(state: EditorState, pos: number): LiteralRange | null {
  const line = state.doc.lineAt(pos);
  const tree = ensureSyntaxTree(state, line.to, PARSE_BUDGET_MS) ?? syntaxTree(state);
  if (tree.length === 0) return literalAt(state, pos);
  return rangeAt(highlightedLiterals(tree, Math.max(0, line.from - 1), Math.min(tree.length, line.to + 1)), pos);
}

function rangeAt(ranges: readonly LiteralRange[], pos: number): LiteralRange | null {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid]!;
    if (pos < r.from) hi = mid - 1;
    else if (pos >= r.to) lo = mid + 1;
    else return r;
  }
  return null;
}
