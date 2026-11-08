/**
 * Tree-sitter highlighting (`doc_highlights`) for languages without a
 * CodeMirror mode (Elixir, ...) or a limited stream mode (Kotlin): backend kinds → Lezer tags, so the colours
 * come from the same highlight style and Color Scheme settings as Lezer
 * highlighting. Refreshed with folding; in between, marks are mapped through
 * the changes.
 */
import { Prec, StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { highlightingFor } from "@codemirror/language";
import { tags as t, type Tag } from "@lezer/highlight";
import { parameter } from "./highlight";
import type { SyntaxHighlightKind, SyntaxHighlights } from "@/platform/ipc";

const TAGS: Record<SyntaxHighlightKind, Tag> = {
  keyword: t.keyword,
  string: t.string,
  stringSpecial: t.special(t.string),
  escape: t.escape,
  regexp: t.regexp,
  atom: t.atom,
  number: t.number,
  constant: t.constant(t.variableName),
  comment: t.comment,
  docComment: t.docComment,
  function: t.function(t.definition(t.variableName)),
  functionCall: t.function(t.variableName),
  builtin: t.standard(t.variableName),
  type: t.typeName,
  namespace: t.namespace,
  parameter,
  variable: t.variableName,
  selfVariable: t.self,
  property: t.propertyName,
  attribute: t.annotation,
  macro: t.macroName,
  label: t.labelName,
  tag: t.tagName,
  operator: t.operator,
  punctuation: t.punctuation,
};

export const setSyntaxHighlights = StateEffect.define<SyntaxHighlights>();

function decorations(state: EditorState, h: SyntaxHighlights): DecorationSet {
  const marks = h.kinds.map((k) => {
    const cls = highlightingFor(state, [TAGS[k]]);
    return cls ? Decoration.mark({ class: cls }) : null;
  });
  const len = state.doc.length;
  const ranges = [];
  for (let i = 0; i + 2 < h.data.length; i += 3) {
    const from = h.data[i]!;
    const to = Math.min(h.data[i + 1]!, len);
    const mark = marks[h.data[i + 2]!];
    if (mark && from < to) ranges.push(mark.range(from, to));
  }
  return Decoration.set(ranges, true);
}

export const syntaxHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) if (e.is(setSyntaxHighlights)) return decorations(tr.state, e.value);
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: (f) => Prec.high(EditorView.decorations.from(f)),
});
