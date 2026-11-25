/**
 * Plugin Escape bindings (`[[contributes.keymaps]] key = "Escape"` with `when`, API 1.10): run in
 * a focused editor only after everything the IDE does with Escape there (popups, completion,
 * rename, selection, extra carets, Vim) found nothing to do — the lowest-precedence Escape key,
 * like a handler at the end of IDEA's EditorEscape chain. The first binding whose `when` holds
 * runs; a later plugin's binding is tried first.
 */
import { Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { executeAction, getAction } from "@/platform/actions";
import { evaluateWhen } from "@/platform/context";

interface EscapeBinding {
  action: string;
  when: string;
}

const bindings: EscapeBinding[] = [];

export function addEscapeBinding(action: string, when: string): () => void {
  const binding = { action, when };
  bindings.push(binding);
  return () => {
    const i = bindings.indexOf(binding);
    if (i >= 0) bindings.splice(i, 1);
  };
}

/** The action a plain Escape in an editor runs now, if any. */
export function escapeAction(): string | null {
  for (let i = bindings.length - 1; i >= 0; i--) {
    const { action, when } = bindings[i]!;
    if (getAction(action) && evaluateWhen(when)) return action;
  }
  return null;
}

export const escapeBindings = Prec.lowest(
  keymap.of([
    {
      key: "Escape",
      run: () => {
        const action = escapeAction();
        if (!action) return false;
        void executeAction(action);
        return true;
      },
    },
  ]),
);
