/**
 * Comments and string literals of a document, for the find bar's search
 * context ("In Comments", "Except String Literals" …): from the Lezer syntax
 * tree, or from the backend's tree-sitter highlights for languages without a
 * CodeMirror mode.
 */
import { StateField, type EditorState } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
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

/** Comments and string literals of `state` (cached per syntax tree). */
export function literalRanges(state: EditorState): readonly LiteralRange[] {
  const tree = ensureSyntaxTree(state, state.doc.length, PARSE_BUDGET_MS) ?? syntaxTree(state);
  if (tree.length === 0) return state.field(treeSitterLiterals, false) ?? [];
  const hit = cache.get(tree);
  if (hit) return hit;
  const out: LiteralRange[] = [];
  highlightTree(tree, highlighter, (from, to, cls) => {
    const kind: LiteralKind | null = cls.includes("comment") ? "comment" : cls.includes("string") ? "string" : null;
    if (kind) push(out, from, to, kind);
  });
  cache.set(tree, out);
  return out;
}

/** What `pos` lies in: a comment, a string literal or plain code (`null`). */
export function literalKindAt(state: EditorState, pos: number): LiteralKind | null {
  return literalAt(state, pos)?.kind ?? null;
}

/** The comment or string literal `pos` lies in, if any. */
export function literalAt(state: EditorState, pos: number): LiteralRange | null {
  const ranges = literalRanges(state);
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
