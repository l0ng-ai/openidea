/**
 * Linked editing for matching HTML tags, as in IDEA's Simultaneous
 * `<tag></tag>` editing (on by default) and VS Code's Linked Editing: editing
 * the name in an opening (or closing) tag renames the matching tag of the same
 * element as you type. Done from the syntax tree — `@lezer/html`'s
 * `OpenTag`/`CloseTag` elements, shared by every HTML-based mode — so it works
 * without a language server.
 *
 * A transaction whose change lies inside one tag's `TagName` is extended with
 * the same edit at the same offset in the counterpart's name — one
 * transaction, so undo takes both back together. Without a matching tag (void
 * and self-closing tags, unclosed elements, a stray close tag) or with the two
 * names already different (malformed markup) nothing follows: the tags stay as
 * they are.
 */
import { EditorState, type Extension, type Transaction } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode, Tree } from "@lezer/common";
import { isExternalChange } from "@/editor/api";

/** The `TagName` a changed range edits — an insertion at either edge extends the name. */
function tagNameAround(tree: Tree, from: number, to: number): SyntaxNode | null {
  let n = tree.resolveInner(from, -1);
  if (n.name !== "TagName") n = tree.resolveInner(from, 1);
  return n.name === "TagName" && n.from <= from && to <= n.to ? n : null;
}

/** The matching tag's name of the same element, or null without one. */
function counterpartName(name: SyntaxNode): SyntaxNode | null {
  const tag = name.parent;
  const element = tag?.parent;
  if (!tag || element?.name !== "Element") return null;
  const other = element.getChild(
    /^Open/.test(tag.name) ? tag.name.replace("Open", "Close") : tag.name.replace("Close", "Open"),
  );
  return other?.getChild("TagName") ?? null;
}

/** Insertions at a name's edge must extend the name; structural characters end it. */
const NOT_NAME_CHARS = /[\s/>"'<=]/;

/**
 * Editing the name of an opening (or closing) HTML tag renames its matching
 * tag, from the syntax tree — no language server, no option (IDEA's
 * simultaneous `<tag></tag>` editing is on by default).
 */
export const linkedTags: Extension = EditorState.transactionFilter.of((tr: Transaction) => {
  const state = tr.startState;
  if (!tr.docChanged || state.readOnly || isExternalChange(tr)) return tr;
  const tree = syntaxTree(state);
  const edits: { from: number; to: number; insert: string }[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) =>
    edits.push({ from: fromA, to: toA, insert: inserted.toString() }),
  );
  const mirrored: { from: number; to: number; insert: string }[] = [];
  const targets = new Set<number>();
  for (const edit of edits) {
    const name = tagNameAround(tree, edit.from, edit.to);
    if (!name || NOT_NAME_CHARS.test(edit.insert)) continue;
    const other = counterpartName(name);
    // Names that already differ mean malformed markup: leave the tags alone.
    if (!other || state.sliceDoc(name.from, name.to) !== state.sliceDoc(other.from, other.to)) continue;
    // Both ends edited at once (a second caret, undo of a linked edit): already in step.
    if (edits.some((e) => e.from <= other.to && other.from <= e.to)) continue;
    // Two carets in one name: their offsets would not line up; skip rather than guess.
    if (targets.has(other.from)) return tr;
    targets.add(other.from);
    mirrored.push({
      from: other.from + (edit.from - name.from),
      to: other.from + (edit.to - name.from),
      insert: edit.insert,
    });
  }
  if (!mirrored.length) return tr;
  return [
    tr,
    {
      changes: mirrored
        .map((m) => ({ from: tr.changes.mapPos(m.from, -1), to: tr.changes.mapPos(m.to, 1), insert: m.insert }))
        .sort((a, b) => a.from - b.from),
      sequential: true,
    },
  ];
});
