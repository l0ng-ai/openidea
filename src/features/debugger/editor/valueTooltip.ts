/**
 * Settings › Debugger › Data Views › "Show value tooltip on mouse hover":
 * while suspended, hovering an expression (or the selection under the mouse)
 * evaluates it in the selected frame.
 */
import type { EditorState, Extension } from "@codemirror/state";
import type { DebugSessionId, Variable } from "@/bindings";
import { hoverTooltip, ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { showHint } from "@/editor/lsp/hint";
import { workflowSettings } from "@/platform/workflowSettings";
import { navigationModifierHeld } from "@/platform/navigationModifier";
import { activeSession, evaluate } from "../state";
import { inlineValue } from "../values";
import { tx } from "@/platform/i18n";
import { iconMarkup, selectableText } from "@/ui";
import { mountValueTree } from "../ui/ValueHintTree";
import styles from "./editor.module.css";

const BASE_HOVER = 100;
const IDENT = /[\p{L}\p{N}_$]/u;

/** Identifier (with `a.b.c` member access) around `pos`, or the selection containing it. */
export function expressionAt(view: EditorView, pos: number): { from: number; to: number; text: string } | null {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty && pos >= sel.from && pos <= sel.to) {
    const text = state.sliceDoc(sel.from, sel.to).trim();
    return text && !text.includes("\n") ? { from: sel.from, to: sel.to, text } : null;
  }
  const line = state.doc.lineAt(pos);
  const t = line.text;
  let start = pos - line.from;
  let end = start;
  if (!IDENT.test(t[end] ?? "") && !IDENT.test(t[start - 1] ?? "")) return null;
  while (end < t.length && IDENT.test(t[end]!)) end++;
  while (start > 0 && (IDENT.test(t[start - 1]!) || (t[start - 1] === "." && IDENT.test(t[start - 2] ?? "")))) start--;
  const text = t.slice(start, end);
  if (!text || /^\d/.test(text)) return null;
  return { from: line.from + start, to: line.from + end, text };
}

/** IDEA's value hint: `expression = value {type}`, objects expandable into a variables tree in place. */
export function valueHint(
  expression: string,
  value: Variable,
  session: DebugSessionId,
): { dom: HTMLElement; destroy: () => void } {
  const dom = document.createElement("div");
  dom.className = `${styles.valueTooltip} ${selectableText}`;
  let tree: { unmount(): void } | null = null;
  if (value.variablesReference > 0) {
    // IDEA's value hint: the "+" expands the object into a variables tree in place.
    const expand = document.createElement("button");
    expand.type = "button";
    expand.className = styles.valueExpand!;
    expand.setAttribute("aria-label", tx("Expand value"));
    expand.setAttribute("aria-expanded", "false");
    expand.innerHTML = iconMarkup("chevron-right", 12) ?? "";
    expand.addEventListener("mousedown", (e) => e.preventDefault());
    expand.addEventListener("click", () => {
      if (tree) return;
      expand.remove();
      dom.classList.replace(selectableText, styles.valueTooltipTree!);
      dom.replaceChildren();
      tree = mountValueTree(dom, expression, value, session);
    });
    dom.append(expand);
  }
  const name = document.createElement("span");
  name.className = styles.valueName!;
  name.textContent = `${expression} = `;
  dom.append(name, inlineValue(value.value, 400));
  if (value.typeName) {
    const type = document.createElement("span");
    type.className = styles.valueType!;
    type.textContent = `  {${value.typeName}}`;
    dom.append(type);
  }
  return { dom, destroy: () => tree?.unmount() };
}

export function valueTooltip(): Extension {
  return hoverTooltip(
    async (view, pos) => {
      const dbg = workflowSettings().debugger;
      // ⌘/Ctrl-hover shows the navigation info instead (closed on press by the LSP hover).
      if (!dbg.valueTooltip || navigationModifierHeld()) return null;
      const session = activeSession();
      if (!session || session.status !== "paused") return null;
      const expr = expressionAt(view, pos);
      if (!expr) return null;
      if (dbg.valueTooltipDelay > BASE_HOVER)
        await new Promise((r) => setTimeout(r, dbg.valueTooltipDelay - BASE_HOVER));
      let value;
      try {
        value = await evaluate(expr.text, "hover", session);
      } catch {
        return null;
      }
      if (navigationModifierHeld()) return null;
      return {
        pos: expr.from,
        end: expr.to,
        above: true,
        create: () => {
          return valueHint(expr.text, value, session.id);
        },
      };
    },
    { hoverTime: BASE_HOVER },
  );
}

const SELECTION_DELAY = 400;
const MAX_SELECTION = 200;

/** The selected text when it can be evaluated: one non-blank line, not too long. */
export function selectionExpression(state: EditorState): { from: number; text: string } | null {
  const sel = state.selection;
  if (sel.ranges.length !== 1 || sel.main.empty) return null;
  const text = state.sliceDoc(sel.main.from, sel.main.to).trim();
  if (!text || text.length > MAX_SELECTION || text.includes("\n")) return null;
  return { from: sel.main.from, text };
}

/**
 * Settings › Debugger › Data Views › "Show value tooltip on code selection": while
 * suspended, selecting an expression shows its value once the selection settles.
 */
export function selectionValueTooltip(): Extension {
  return ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | undefined;
      private seq = 0;
      constructor(readonly view: EditorView) {}

      update(u: ViewUpdate) {
        if (!u.selectionSet) return;
        clearTimeout(this.timer);
        this.seq++;
        if (!u.transactions.some((tr) => tr.isUserEvent("select"))) return;
        const seq = this.seq;
        this.timer = setTimeout(() => void this.show(seq), SELECTION_DELAY);
      }

      private async show(seq: number) {
        if (!workflowSettings().debugger.valueTooltipOnSelection) return;
        const session = activeSession();
        if (!session || session.status !== "paused") return;
        const expr = selectionExpression(this.view.state);
        if (!expr) return;
        let value;
        try {
          value = await evaluate(expr.text, "hover", session);
        } catch {
          return;
        }
        // The selection moved on while evaluating.
        if (seq !== this.seq) return;
        showHint(this.view, () => valueHint(expr.text, value, session.id), { pos: expr.from, timeout: 60_000 });
      }

      destroy() {
        clearTimeout(this.timer);
      }
    },
  );
}
