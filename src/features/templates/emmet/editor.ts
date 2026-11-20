/** Editor side of Emmet: Tab expansion and Update Tag with Emmet. */
import { snippet } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { enclosingTag, expandAt, JSX_LANGUAGES, syntaxAt, updateTagEdits, type EmmetSyntax } from "./model";

const JSX: EmmetSyntax = { type: "markup", syntax: "jsx" };

/** Element names a bare word after `return` / `=>` expands as, so `return value` + Tab stays code. */
const HTML_TAGS = new Set(
  (
    "a article aside b blockquote br button canvas code dd details dialog div dl dt em fieldset figure footer " +
    "form h1 h2 h3 h4 h5 h6 header hr i iframe img input label legend li main nav ol option p pre section " +
    "select small span strong summary svg table tbody td textarea tfoot th thead tr ul video"
  ).split(" "),
);

/**
 * Where an abbreviation starting at `from` becomes JSX: among an element's
 * children, or as the value of `return` / an arrow function (`return (div`)
 * when it reads as markup — Emmet operators, an HTML element name or a
 * component name.
 */
function jsxAbbreviationContext(state: EditorState, from: number, abbr: string): boolean {
  const node = syntaxTree(state).resolveInner(from, 1);
  if (node.name === "JSXText") return true;
  if (/String|Comment|Template|JSX/.test(node.name)) return false;
  if (!/(?:\breturn|=>)\s*\(?\s*$/.test(state.sliceDoc(Math.max(0, from - 200), from))) return false;
  return /[.#>+*^[{:]/.test(abbr) || HTML_TAGS.has(abbr) || /^[A-Z]/.test(abbr);
}

/** Tab: expands the Emmet abbreviation before the caret in a `language` document. */
export function expandEmmetAtCaret(view: EditorView, language: string): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty || state.selection.ranges.length > 1) return false;
  const jsx = JSX_LANGUAGES.has(language);
  const syntax = jsx ? JSX : syntaxAt(language, state.sliceDoc(0, sel.head));
  if (!syntax) return false;
  const line = state.doc.lineAt(sel.head);
  const found = expandAt(line.text, sel.head - line.from, syntax);
  if (!found) return false;
  const from = line.from + found.from;
  if (jsx && !jsxAbbreviationContext(state, from, line.text.slice(found.from, found.to))) return false;
  snippet(found.snippet)(view, null, from, line.from + found.to);
  return true;
}

/** The enclosing tag's name at the caret (for the prompt). */
export function tagAtCaret(view: EditorView): string | null {
  return enclosingTag(view.state.doc.toString(), view.state.selection.main.head)?.name ?? null;
}

/** Applies `abbreviation` to the tag enclosing the caret; false when nothing changed. */
export function updateTag(view: EditorView, abbreviation: string): boolean {
  const tag = enclosingTag(view.state.doc.toString(), view.state.selection.main.head);
  const edits = tag && updateTagEdits(tag, abbreviation);
  if (!edits) return false;
  view.dispatch({ changes: edits, userEvent: "input.emmet", scrollIntoView: true });
  return true;
}
