import { EditorSelection, Prec, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { dispatchMouseShortcut } from "@/platform/keymap";

export function mouseEvaluateTarget(arg: unknown): { view: EditorView; pos: number } | null {
  if (!arg || typeof arg !== "object" || !("view" in arg) || !("pos" in arg)) return null;
  return arg.view instanceof EditorView && typeof arg.pos === "number" ? { view: arg.view, pos: arg.pos } : null;
}

/** Preserve a clicked selection and anchor the value hint at the mouse position. */
export function quickEvaluateMouse(): Extension {
  return Prec.highest(EditorView.domEventHandlers({ mousedown: quickEvaluateMouseDown }));
}

export function quickEvaluateMouseDown(e: MouseEvent, view: EditorView): boolean {
  if (e.button !== 0) return false;
  const over = e.target instanceof Element ? e.target : null;
  if (over?.closest(".cm-tooltip, .cm-lsp-inlay") || (over && !over.closest(".cm-content"))) return false;
  const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
  if (pos == null) return false;
  const handled = dispatchMouseShortcut(
    e,
    (id) => {
      if (id !== "debug.quickEvaluate") return false;
      const sel = view.state.selection.main;
      if (sel.empty || pos < sel.from || pos > sel.to) view.dispatch({ selection: EditorSelection.cursor(pos) });
      view.focus();
      return true;
    },
    { view, pos },
  );
  if (handled) e.preventDefault();
  return handled;
}
