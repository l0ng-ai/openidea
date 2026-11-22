/**
 * Settings › Debugger › Data Views › "Show value tooltip on mouse hover":
 * while suspended, hovering an expression (or the selection under the mouse)
 * evaluates it in the selected frame.
 */
import type { EditorState, Extension } from "@codemirror/state";
import type { DebugSessionId, Variable } from "@/bindings";
import { closeHoverTooltips, hoverTooltip, ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { hideHint, showHint } from "@/editor/lsp/hint";
import { workflowSettings } from "@/platform/workflowSettings";
import { navigationModifierHeld } from "@/platform/navigationModifier";
import { activeSession, evaluate, useDebug } from "../state";
import { inlineValue, shownValue } from "../values";
import { tx } from "@/platform/i18n";
import { iconMarkup, selectableText } from "@/ui";
import { mountValueTree } from "../ui/ValueHintTree";
import styles from "./editor.module.css";

const BASE_HOVER = 100;
const IDENT = /[\p{L}\p{N}_$]/u;

const OPEN: Record<string, string> = { ")": "(", "]": "[" };
const CLOSE: Record<string, string> = { "(": ")", "[": "]" };

/** Index just past the bracket group opening at `i` (strings skipped), or -1 when it doesn't close on the line. */
function closeOf(t: string, i: number): number {
  const stack: string[] = [];
  for (let j = i; j < t.length; j++) {
    const c = t[j]!;
    if (c === '"' || c === "'" || c === "`") {
      j++;
      while (j < t.length && t[j] !== c) j += t[j] === "\\" ? 2 : 1;
      if (j >= t.length) return -1;
    } else if (CLOSE[c]) stack.push(CLOSE[c]);
    else if (c === ")" || c === "]") {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return j + 1;
    }
  }
  return -1;
}

/** Index of the bracket opening the group that closes at `i - 1`, or -1. */
function openOf(t: string, i: number): number {
  for (let start = i - 1; start >= 0; start--) {
    if (t[start] === OPEN[t[i - 1]!] && closeOf(t, start) === i) return start;
  }
  return -1;
}

/**
 * Identifier (with `a.b.c` member access) around `pos`, or the selection containing it. With
 * `calls`, as for Quick Evaluate: member chains through calls and indexing (`a.getB().c`,
 * `items[i].name`) and the call of the identifier itself (`o.getX()`, `f(a, b)`).
 */
export function expressionAt(
  view: EditorView,
  pos: number,
  { calls = false } = {},
): { from: number; to: number; text: string } | null {
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
  for (;;) {
    while (start > 0 && IDENT.test(t[start - 1]!)) start--;
    if (t[start - 1] === "." && IDENT.test(t[start - 2] ?? "")) start--;
    else if (calls && t[start - 1] === "." && OPEN[t[start - 2] ?? ""]) {
      let open = openOf(t, start - 1);
      // `a.b()[0].c`: walk back over every group, then the name they follow.
      while (open > 0 && OPEN[t[open - 1]!]) open = openOf(t, open);
      if (open <= 0 || !IDENT.test(t[open - 1]!)) break;
      start = open;
    } else break;
  }
  if (calls) {
    let next = end;
    while (t[next] === " ") next++;
    if (t[next] === "(") {
      const close = closeOf(t, next);
      if (close > 0) end = close;
    }
  }
  const text = t.slice(start, end);
  if (!text || /^\d/.test(text)) return null;
  return { from: line.from + start, to: line.from + end, text };
}

/** IDEA's value hint: `expression = value {type}`, objects expandable into a variables tree in place. */
export function valueHint(
  expression: string,
  value: Variable,
  session: DebugSessionId,
  max: number | null = 400,
  opts: { expanded?: boolean; pin?: () => void } = {},
): { dom: HTMLElement; destroy: () => void } {
  const dom = document.createElement("div");
  dom.className = `${styles.valueTooltip} ${selectableText}`;
  let tree: { unmount(): void } | null = null;
  const expandTree = () => {
    dom.classList.replace(selectableText, styles.valueTooltipTree!);
    dom.replaceChildren();
    tree = mountValueTree(dom, expression, value, session);
  };
  if (value.variablesReference > 0 && opts.expanded) {
    expandTree();
    return { dom, destroy: () => tree?.unmount() };
  }
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
      if (opts.pin) return opts.pin();
      expand.remove();
      expandTree();
    });
    dom.append(expand);
  }
  const name = document.createElement("span");
  name.className = styles.valueName!;
  name.textContent = `${expression} = `;
  const shown = shownValue(value.value, value.typeName);
  // A JVM object's `{Type@id}` leads its value; other types follow it.
  const leading = shown.label?.includes("@") ?? false;
  const type = (text: string) => {
    const span = document.createElement("span");
    span.className = styles.valueType!;
    span.textContent = text;
    return span;
  };
  dom.append(name);
  if (leading) dom.append(type(`${shown.label} `));
  dom.append(max === null ? shown.text : inlineValue(shown.text, max));
  if (shown.label && !leading) dom.append(type(`  ${shown.label}`));
  return { dom, destroy: () => tree?.unmount() };
}

export function showQuickValue(
  view: EditorView,
  pos: number,
  expression: string,
  value: Variable,
  session: DebugSessionId,
) {
  if (value.variablesReference > 0) showValueTree(view, pos, expression, value, session);
  else showHint(view, () => valueHint(expression, value, session), { pos, timeout: 60_000 });
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
        create: (view) =>
          valueHint(expr.text, value, session.id, 400, {
            // The tree outgrows the hint and may move to the other side of the line, away from the
            // mouse, which closed the hover tooltip before it could be reached. Like IDEA's value
            // popup it stays until Escape, a click in the editor or the next step.
            pin: () => showValueTree(view, expr.from, expr.text, value, session.id),
          }),
      };
    },
    { hoverTime: BASE_HOVER },
  );
}

function showValueTree(view: EditorView, pos: number, expression: string, value: Variable, session: DebugSessionId) {
  view.dispatch({ effects: closeHoverTooltips });
  showHint(view, () => pinnedTree(view, expression, value, session), { pos, timeout: null });
}

/** An expanded value tree, closed when its session leaves the stop it was evaluated in. */
function pinnedTree(view: EditorView, expression: string, value: Variable, session: DebugSessionId) {
  const stop = useDebug.getState().stopSeq;
  const unsubscribe = useDebug.subscribe((s) => {
    if (s.stopSeq !== stop || s.sessions[session]?.status !== "paused") hideHint(view);
  });
  const hint = valueHint(expression, value, session, 400, { expanded: true });
  let width = 0;
  let resizeFrame = 0;
  const updateWidth = () => {
    const next = view.dom.clientWidth;
    if (!next || next === width) return;
    width = next;
    hint.dom.style.setProperty("--debug-value-editor-width", `${width}px`);
  };
  updateWidth();
  const resize = new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(updateWidth);
  });
  resize.observe(view.dom);
  // The tree has the focus, so the editor's Escape doesn't reach the hint.
  hint.dom.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    hideHint(view);
    view.focus();
  });
  return {
    dom: hint.dom,
    destroy: () => {
      resize.disconnect();
      cancelAnimationFrame(resizeFrame);
      unsubscribe();
      hint.destroy();
    },
  };
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
