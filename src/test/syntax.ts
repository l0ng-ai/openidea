import { ensureSyntaxTree, language, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

export function completedSyntaxTree(state: EditorState, timeout = 1000) {
  const tree = ensureSyntaxTree(state, state.doc.length, timeout);
  if (!tree) throw new Error("Test syntax parsing did not finish");
  return tree;
}

export function completedSyntaxState(state: EditorState, timeout = 5000) {
  if (!state.facet(language)) return state;
  const tree = completedSyntaxTree(state, timeout);
  // A transaction snapshots the completed parse context into the immutable state.
  const parsed = state.update({}).state;
  if (syntaxTree(parsed) !== tree) throw new Error("Test state did not publish the completed syntax tree");
  return parsed;
}
