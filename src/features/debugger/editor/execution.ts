/**
 * Execution point in the editor: the suspended line (background only, as in
 * IDEA) and inline values of the frame's locals after line ends.
 */
import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { EditorDocContext } from "@/editor/api";
import { useExecutionPoint } from "../state";
import { onWorkflowSettingsChange, workflowSettings } from "@/platform/workflowSettings";
import { identifiersIn, inlineValue } from "../values";
import styles from "./editor.module.css";

/** How far above the execution point inline values are shown. */
const INLINE_SPAN = 60;
const MAX_PER_LINE = 4;

class InlineValues extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(o: InlineValues) {
    return o.text === this.text;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = styles.inlineValue!;
    span.textContent = this.text;
    span.setAttribute("aria-hidden", "true");
    return span;
  }
  ignoreEvent() {
    return true;
  }
}

interface Exec {
  line: number;
  top: boolean;
}

const setExec = StateEffect.define<Exec | null>();

function currentExec(path: string): Exec | null {
  const p = useExecutionPoint.getState();
  return p.path === path ? { line: p.line, top: p.top } : null;
}

/** `name: value` pairs for identifiers on `text` that are known locals. */
export function inlineValuesFor(text: string, values: Record<string, string>): string | null {
  const parts: string[] = [];
  for (const id of identifiersIn(text)) {
    if (!Object.hasOwn(values, id)) continue;
    const v = values[id];
    if (v === undefined) continue;
    parts.push(`${id}: ${inlineValue(v, 40)}`);
    if (parts.length >= MAX_PER_LINE) break;
  }
  return parts.length ? parts.join(", ") : null;
}

function lineDecorations(state: EditorState, exec: Exec | null): DecorationSet {
  if (!exec || exec.line >= state.doc.lines) return Decoration.none;
  const line = state.doc.line(exec.line + 1);
  return Decoration.set([Decoration.line({ class: styles.execLine }).range(line.from)]);
}

export function executionPoint(ctx: EditorDocContext): Extension {
  const path = ctx.path;
  const execField = StateField.define<Exec | null>({
    create: () => currentExec(path),
    update(value, tr) {
      for (const e of tr.effects) if (e.is(setExec)) return e.value;
      if (value && tr.docChanged) {
        const doc = tr.startState.doc;
        if (value.line >= doc.lines) return value;
        const pos = tr.changes.mapPos(doc.line(value.line + 1).from, 1);
        return { ...value, line: tr.state.doc.lineAt(pos).number - 1 };
      }
      return value;
    },
    provide: (f) => EditorView.decorations.compute([f], (state) => lineDecorations(state, state.field(f))),
  });

  // Keep the execution line alive even if an inline-value renderer fails.
  const sync = ViewPlugin.fromClass(
    class {
      private unsub: () => void;
      private pending = false;
      private destroyed = false;
      constructor(readonly view: EditorView) {
        this.unsub = useExecutionPoint.subscribe(() => this.refresh());
        // Hidden tabs retain EditorState while their views are unmounted.
        this.refresh();
      }
      refresh() {
        if (this.pending) return;
        this.pending = true;
        queueMicrotask(() => {
          this.pending = false;
          if (this.destroyed) return;
          const next = currentExec(path);
          const cur = this.view.state.field(execField);
          const moved = cur?.line !== next?.line || cur?.top !== next?.top || !!cur !== !!next;
          // Locals can change without moving the execution point.
          this.view.dispatch(moved ? { effects: setExec.of(next) } : {});
        });
      }
      destroy() {
        this.destroyed = true;
        this.unsub();
      }
    },
  );

  const inline = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      private destroyed = false;
      private unsubSettings: () => void;
      constructor(readonly view: EditorView) {
        this.decorations = this.build();
        this.unsubSettings = onWorkflowSettingsChange(
          (s) => s.debugger.inlineValues,
          () => queueMicrotask(() => !this.destroyed && this.view.dispatch({})),
        );
      }

      update(u: ViewUpdate) {
        const changedExec = u.startState.field(execField) !== u.state.field(execField);
        if (u.docChanged || u.viewportChanged || changedExec || u.transactions.length) this.decorations = this.build();
      }

      build(): DecorationSet {
        const exec = this.view.state.field(execField);
        if (!workflowSettings().debugger.inlineValues) return Decoration.none;
        const values = useExecutionPoint.getState().values;
        if (!exec || !Object.keys(values).length) return Decoration.none;
        const doc = this.view.state.doc;
        const first = Math.max(0, exec.line - INLINE_SPAN);
        const widgets = [];
        for (const { from, to } of this.view.visibleRanges) {
          const startLine = Math.max(doc.lineAt(from).number - 1, first);
          const endLine = Math.min(doc.lineAt(to).number - 1, exec.line);
          for (let l = startLine; l <= endLine; l++) {
            const line = doc.line(l + 1);
            const text = inlineValuesFor(line.text, values);
            if (text) widgets.push(Decoration.widget({ widget: new InlineValues(text), side: 1 }).range(line.to));
          }
        }
        return Decoration.set(widgets, true);
      }

      destroy() {
        this.destroyed = true;
        this.unsubSettings();
      }
    },
    { decorations: (v) => v.decorations },
  );

  return [execField, sync, inline];
}
