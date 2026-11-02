/** The merge editor's menus: the context menus of its three panes and the toolbar's drop-downs. */
import type { EditorState, TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { showContextMenu } from "@/ui";
import { copyText } from "@/ui/selectableText";
import { toggleAnnotations } from "./blame";
import { openDiff } from "./diffInput";
import {
  applyTo,
  canApply,
  changesIn,
  changesInSide,
  mergeField,
  type MergeAction,
  type MergeSide,
} from "./mergeModel";

/** Runs a command on the result; `reveal` then moves to what is left to decide. */
export type RunCommand = (make: (state: EditorState) => TransactionSpec | null, reveal?: boolean) => void;

/** Under the toolbar button that was pressed. */
export function below(e: React.MouseEvent) {
  const rect = e.currentTarget.getBoundingClientRect();
  return { clientX: rect.left, clientY: rect.bottom };
}

/**
 * A right click acts on what is under the pointer: the caret moves there unless it is inside
 * the selection (CodeMirror moves it for the left button only). Returns the selection.
 */
function selectUnderPointer(view: EditorView, e: React.MouseEvent) {
  const at = view.posAtCoords({ x: e.clientX, y: e.clientY });
  const picked = view.state.selection.main;
  if (at !== null && (at < picked.from || at > picked.to)) view.dispatch({ selection: { anchor: at } });
  return view.state.selection.main;
}

/** Whether `action` applies to any of the result's changes at `indexes`. */
const anyCan = (result: EditorState, indexes: readonly number[], action: MergeAction) =>
  indexes.some((i) => canApply(result.doc, result.field(mergeField)[i]!, action));

/** The result's context menu: the decisions for the changes in the selection, then the clipboard. */
export function showResultMenu(e: React.MouseEvent, view: EditorView, run: RunCommand) {
  e.preventDefault();
  const { from, to } = selectUnderPointer(view, e);
  const indexes = changesIn(view.state, from, to);
  const decide = (action: MergeAction) => ({
    disabled: !anyCan(view.state, indexes, action),
    run: () => run((s) => applyTo(s, indexes, action)),
  });
  const selected = view.state.sliceDoc(from, to);
  showContextMenu(e.nativeEvent, [
    { label: "Resolve Automatically", icon: "diff-magic", ...decide({ type: "auto", side: "base" }) },
    { label: "Ignore", icon: "diff-remove", ...decide({ type: "ignore", side: null }) },
    { kind: "separator" },
    {
      label: "Cut",
      disabled: !selected,
      run: () => {
        void copyText(selected);
        view.dispatch({ changes: { from, to }, userEvent: "delete.cut" });
      },
    },
    { label: "Copy", icon: "copy", disabled: !selected, run: () => void copyText(selected) },
    {
      label: "Paste",
      run: () =>
        void navigator.clipboard
          ?.readText()
          .then((text) => view.dispatch({ ...view.state.replaceSelection(text), userEvent: "input.paste" }))
          .catch(() => undefined),
    },
    { label: "Select All", run: () => view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }) },
  ]);
}

/** A side pane: its version of the file, and the revision Git Blame annotates it with. */
export interface SidePane {
  which: MergeSide;
  view: EditorView;
  path: string;
  text: string;
  /** The branch the version belongs to, so lines that only exist on the other branch show their real history. */
  revision?: string;
}

/** A side pane's context menu: accept, resolve using or ignore the changes in its selection, and Git Blame. */
export function showSideMenu(e: React.MouseEvent, pane: SidePane, result: EditorView, run: RunCommand) {
  e.preventDefault();
  const { which, view } = pane;
  const { from, to } = selectUnderPointer(view, e);
  const indexes = changesInSide(result.state, which, view.state.doc, from, to);
  const decide = (action: MergeAction) => ({
    disabled: !anyCan(result.state, indexes, action),
    run: () => run((s) => applyTo(s, indexes, action)),
  });
  showContextMenu(e.nativeEvent, [
    { label: "Accept", ...decide({ type: "accept", side: which, resolve: false }) },
    {
      label: which === "left" ? "Resolve Using Yours" : "Resolve Using Theirs",
      ...decide({ type: "accept", side: which, resolve: true }),
    },
    { label: "Ignore", ...decide({ type: "ignore", side: which }) },
    { kind: "separator" },
    {
      label: "Annotate with Git Blame",
      icon: "changelist",
      run: () => void toggleAnnotations(view, pane.path, pane.text, pane.revision),
    },
  ]);
}

export type Version = "yours" | "base" | "result" | "theirs";

/** Compare Contents: the versions in pairs, in the diff viewer. */
export function showCompareMenu(
  e: React.MouseEvent,
  path: string,
  versions: Record<Version, { text: string; label: string }>,
) {
  const compare = (a: Version, b: Version) => () =>
    void openDiff({ path, left: { type: "text", ...versions[a] }, right: { type: "text", ...versions[b] } });
  showContextMenu(below(e), [
    { label: "Yours and Result", run: compare("yours", "result") },
    { label: "Result and Theirs", run: compare("result", "theirs") },
    { label: "Yours and Theirs", run: compare("yours", "theirs") },
    { kind: "separator" },
    { label: "Base and Yours", run: compare("base", "yours") },
    { label: "Base and Result", run: compare("base", "result") },
    { label: "Base and Theirs", run: compare("base", "theirs") },
  ]);
}

export function showSettingsMenu(e: React.MouseEvent, autoApply: boolean, setAutoApply: (on: boolean) => void) {
  showContextMenu(below(e), [
    {
      label: "Automatically Apply Non-Conflicting Changes",
      checked: autoApply,
      run: () => setAutoApply(!autoApply),
    },
  ]);
}
