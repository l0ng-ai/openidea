/**
 * Execution point in the editor: the suspended line (background only, as in
 * IDEA) and inline values of the frame's locals after line ends.
 */
import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { EditorDocContext } from "@/editor/api";
import type { Variable } from "@/platform/ipc";
import { showHint } from "@/editor/lsp/hint";
import { activeSession, useExecutionPoint } from "../state";
import { onWorkflowSettingsChange, workflowSettings } from "@/platform/workflowSettings";
import { tx } from "@/platform/i18n";
import { identifiersIn, inlineValue } from "../values";
import { valueHint } from "./valueTooltip";
import styles from "./editor.module.css";

/** How far above the execution point inline values are shown. */
const INLINE_SPAN = 60;
const MAX_PER_LINE = 4;

interface InlinePart {
  name: string;
  text: string;
  variable: Variable;
  truncated: boolean;
}

class InlineValues extends WidgetType {
  constructor(readonly parts: InlinePart[]) {
    super();
  }
  eq(o: InlineValues) {
    return (
      o.parts.length === this.parts.length &&
      o.parts.every((part, i) => part.name === this.parts[i]?.name && part.text === this.parts[i]?.text)
    );
  }
  toDOM(view: EditorView) {
    const span = document.createElement("span");
    span.className = styles.inlineValue!;
    for (const [index, part] of this.parts.entries()) {
      if (index > 0) span.append(document.createTextNode(", "));
      const piece = document.createElement("span");
      piece.className = styles.inlineValuePart!;
      piece.textContent = part.text;
      piece.title = `${part.name} = ${part.variable.value}`;
      piece.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const session = activeSession();
        if (!session || session.status !== "paused") return;
        showHint(view, () => valueHint(part.name, part.variable, session.id, null), {
          pos: view.posAtDOM(piece),
          timeout: 60_000,
        });
      });
      span.append(piece);
      if (part.truncated) {
        const show = document.createElement("button");
        show.type = "button";
        show.className = styles.inlineShow!;
        show.textContent = `…${tx("Show")}`;
        show.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const session = activeSession();
          if (!session || session.status !== "paused") return;
          showHint(view, () => valueHint(part.name, part.variable, session.id, null), {
            pos: view.posAtDOM(show),
            timeout: 60_000,
          });
        });
        span.append(show);
      }
    }
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
export function inlineValuesFor(
  text: string,
  values: Record<string, string | Variable>,
  variables?: Record<string, Variable>,
): InlinePart[] | null {
  const parts: InlinePart[] = [];
  for (const id of identifiersIn(text)) {
    if (!Object.hasOwn(values, id)) continue;
    const raw = values[id];
    if (raw === undefined) continue;
    const variable =
      typeof raw === "string"
        ? (variables?.[id] ?? {
            name: id,
            value: raw,
            typeName: null,
            variablesReference: 0,
            evaluateName: id,
          })
        : raw;
    parts.push({
      name: id,
      text: `${id}: ${inlineValue(variable.value, 40)}`,
      variable,
      truncated: variable.value.length > 40,
    });
    if (parts.length >= MAX_PER_LINE) break;
  }
  return parts.length ? parts : null;
}

function lineDecorations(state: EditorState, exec: Exec | null): DecorationSet {
  if (!exec || exec.line >= state.doc.lines) return Decoration.none;
  const line = state.doc.line(exec.line + 1);
  return Decoration.set([Decoration.line({ class: `${styles.execLine} cm-openidea-lineBg` }).range(line.from)]);
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
        const { values, variables } = useExecutionPoint.getState();
        if (!exec || !Object.keys(values).length) return Decoration.none;
        const doc = this.view.state.doc;
        const first = Math.max(0, exec.line - INLINE_SPAN);
        const widgets = [];
        for (const { from, to } of this.view.visibleRanges) {
          const startLine = Math.max(doc.lineAt(from).number - 1, first);
          const endLine = Math.min(doc.lineAt(to).number - 1, exec.line);
          for (let l = startLine; l <= endLine; l++) {
            const line = doc.line(l + 1);
            const parts = inlineValuesFor(line.text, values, variables);
            if (parts) widgets.push(Decoration.widget({ widget: new InlineValues(parts), side: 1 }).range(line.to));
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
