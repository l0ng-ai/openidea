/**
 * Smart Step Into in the editor, as in IDEA: the calls on the current line are
 * highlighted in place; ←/→ (or Tab / ⇧Tab) move between them, Enter or a
 * click steps into the chosen one, Esc cancels. Hovering a call selects it.
 * Falls back to the chooser dialog when the calls cannot be placed on the line.
 */
import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet } from "@codemirror/view";
import { editorsFor, activeEditor, type EditorDocContext, type TextEditorHandle } from "@/editor/api";
import { call, commands, type DebugSessionId, type StepInTarget } from "@/platform/ipc";
import { suspendKeyboardDispatch } from "@/platform/keymap";
import { notifications } from "@/workbench/contributions";
import { useExecutionPoint } from "../state";
import { useOverlays, type InlineStepTarget } from "../ui/popoverStore";
import styles from "./editor.module.css";

const IDENT = /[\p{L}\p{N}_$]/u;

/** The callee name of a target label: `a.b.parse(str(i))` → `parse`. */
export function calleeName(label: string): string | null {
  const head = label.split("(")[0]!.trim();
  const name = head.split(/[.:#\s]+/).pop() ?? "";
  return name && [...name].every((c) => IDENT.test(c)) ? name : null;
}

/** A call of `name`: `name(` not preceded by an identifier character. */
function callPattern(name: string, flags: string): RegExp {
  return new RegExp(`${name.replace(/\$/g, "\\$")}\\s*\\(`, flags);
}

function isCallBoundary(text: string, from: number): boolean {
  return !/[\p{L}\p{N}_$]$/u.test(text.slice(Math.max(0, from - 2), from));
}

function identifierEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length && IDENT.test(text[i]!)) i++;
  return i;
}

/**
 * Places each target on `lineText` (UTF-16 offsets within the line): the
 * adapter's columns when it reports them for this line, else the next unused
 * call of the target's name. Null when any target cannot be placed. Sorted by position.
 */
export function locateStepTargets(lineText: string, line: number, targets: StepInTarget[]): InlineStepTarget[] | null {
  const used = new Set<number>();
  const out: InlineStepTarget[] = [];
  for (const t of targets) {
    let from = -1;
    let to = -1;
    if (t.column != null && (t.line == null || t.line === line) && t.column < lineText.length) {
      from = t.column;
      to =
        t.endColumn != null && t.endColumn > from
          ? Math.min(t.endColumn, lineText.length)
          : identifierEnd(lineText, from);
    } else {
      const name = calleeName(t.label);
      if (!name) return null;
      for (const m of lineText.matchAll(callPattern(name, "gu"))) {
        if (used.has(m.index!) || !isCallBoundary(lineText, m.index!)) continue;
        from = m.index!;
        to = from + name.length;
        break;
      }
    }
    if (from < 0 || to <= from || used.has(from)) return null;
    used.add(from);
    out.push({ id: t.id, from, to });
  }
  return out.sort((a, b) => a.from - b.from);
}

/**
 * Targets that belong to the paused line. Some adapters (debugpy) list every
 * call left in the function without positions; those are kept only when their
 * callee appears on the line. Unchanged when nothing would remain.
 */
export function targetsOnLine(lineText: string, line: number, targets: StepInTarget[]): StepInTarget[] {
  const kept = targets.filter((t) => {
    if (t.line != null) return t.line === line;
    if (t.column != null) return true;
    const name = calleeName(t.label);
    return !name || [...lineText.matchAll(callPattern(name, "gu"))].some((m) => isCallBoundary(lineText, m.index));
  });
  return kept.length ? kept : targets;
}

/** Targets of the paused line, when that line is open in an editor. */
export function pausedLineTargets(targets: StepInTarget[]): StepInTarget[] {
  const { path, line } = useExecutionPoint.getState();
  const doc = path ? editorShowing(path)?.view.state.doc : null;
  return doc && line < doc.lines ? targetsOnLine(doc.line(line + 1).text, line, targets) : targets;
}

/** Editor to pick in: the active one when it shows `path`, else any showing it. */
function editorShowing(path: string): TextEditorHandle | null {
  const active = activeEditor();
  if (active?.ctx.path === path) return active;
  return editorsFor(path)[0] ?? null;
}

/**
 * Starts inline picking when the paused line is open in an editor and every
 * target can be placed on it; returns false otherwise (caller shows the dialog).
 */
export function startInlineSmartStep(session: DebugSessionId, thread: number, targets: StepInTarget[]): boolean {
  const { path, line, top } = useExecutionPoint.getState();
  if (!path || !top) return false;
  const editor = editorShowing(path);
  const doc = editor?.view.state.doc;
  if (!editor || !doc || line >= doc.lines) return false;
  const ranges = locateStepTargets(doc.line(line + 1).text, line, targets);
  if (!ranges || ranges.length < 2) return false;
  const first = ranges.findIndex((r) => r.id === targets[0]!.id);
  useOverlays.setState({
    smartStep: { session, thread, targets, inline: { path, line, ranges, index: Math.max(0, first) } },
  });
  editor.view.focus();
  return true;
}

export function cancelSmartStep() {
  useOverlays.setState({ smartStep: null });
}

function selectStepTarget(index: number) {
  const s = useOverlays.getState().smartStep;
  if (!s?.inline) return;
  const n = s.inline.ranges.length;
  useOverlays.setState({ smartStep: { ...s, inline: { ...s.inline, index: ((index % n) + n) % n } } });
}

/** Steps into the target `id` (the selected one by default) and leaves picking mode. */
export function chooseStepTarget(id?: number) {
  const s = useOverlays.getState().smartStep;
  if (!s) return;
  const target = id ?? s.inline?.ranges[s.inline.index]?.id;
  cancelSmartStep();
  if (target == null) return;
  void call(commands.debugStepInTarget(s.session, s.thread, target)).catch((e) =>
    notifications().notify({
      group: "run",
      level: "error",
      title: "Smart Step Into failed",
      body: e instanceof Error ? e.message : String(e),
    }),
  );
}

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

function targetIdOf(e: Event): number | null {
  const el = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-step-target]") : null;
  return el ? Number(el.dataset.stepTarget) : null;
}

/**
 * While picking: shortcuts are suspended and keys / clicks go to the picker
 * (window capture, ahead of the editor). Any other key, a click elsewhere or
 * the debugger moving on cancels.
 */
export function installSmartStepPicking(target: Window = window): () => void {
  let teardown: (() => void) | null = null;
  const onKeyDown = (e: KeyboardEvent) => {
    const s = useOverlays.getState().smartStep?.inline;
    if (!s || MODIFIERS.has(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "ArrowLeft" || e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) selectStepTarget(s.index - 1);
    else if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "Tab") selectStepTarget(s.index + 1);
    else if (e.key === "Enter") chooseStepTarget();
    else cancelSmartStep();
  };
  const onMouseDown = (e: MouseEvent) => {
    if (!useOverlays.getState().smartStep?.inline) return;
    const id = targetIdOf(e);
    if (id == null) return cancelSmartStep();
    e.preventDefault();
    e.stopPropagation();
    chooseStepTarget(id);
  };
  const onMouseOver = (e: MouseEvent) => {
    const s = useOverlays.getState().smartStep?.inline;
    const id = targetIdOf(e);
    if (!s || id == null) return;
    const index = s.ranges.findIndex((r) => r.id === id);
    if (index >= 0 && index !== s.index) selectStepTarget(index);
  };
  const start = () => {
    const resume = suspendKeyboardDispatch();
    target.addEventListener("keydown", onKeyDown, true);
    target.addEventListener("mousedown", onMouseDown, true);
    target.addEventListener("mouseover", onMouseOver, true);
    const unsubExec = useExecutionPoint.subscribe((p, prev) => {
      if (p.path !== prev.path || p.line !== prev.line || p.top !== prev.top) cancelSmartStep();
    });
    teardown = () => {
      resume();
      target.removeEventListener("keydown", onKeyDown, true);
      target.removeEventListener("mousedown", onMouseDown, true);
      target.removeEventListener("mouseover", onMouseOver, true);
      unsubExec();
    };
  };
  const sync = () => {
    const active = !!useOverlays.getState().smartStep?.inline;
    if (active && !teardown) start();
    else if (!active && teardown) {
      teardown();
      teardown = null;
    }
  };
  const unsub = useOverlays.subscribe(sync);
  sync();
  return () => {
    unsub();
    teardown?.();
    teardown = null;
  };
}

function decorations(view: EditorView, path: string): DecorationSet {
  const inline = useOverlays.getState().smartStep?.inline;
  if (!inline || inline.path !== path) return Decoration.none;
  const doc = view.state.doc;
  if (inline.line >= doc.lines) return Decoration.none;
  const line = doc.line(inline.line + 1);
  const builder = new RangeSetBuilder<Decoration>();
  inline.ranges.forEach((r, i) => {
    if (r.to > line.length) return;
    const selected = i === inline.index;
    builder.add(
      line.from + r.from,
      line.from + r.to,
      Decoration.mark({
        class: selected ? `${styles.stepTarget} ${styles.stepTargetSelected}` : styles.stepTarget,
        attributes: { "data-step-target": String(r.id), ...(selected ? { "aria-current": "true" } : {}) },
      }),
    );
  });
  return builder.finish();
}

/** Highlights the Smart Step Into targets while picking in this editor. */
export function smartStepTargets(ctx: EditorDocContext): Extension {
  const path = ctx.path;
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private unsub: () => void;
      private destroyed = false;
      constructor(readonly view: EditorView) {
        this.decorations = decorations(view, path);
        this.unsub = useOverlays.subscribe((s, prev) => {
          if (s.smartStep === prev.smartStep) return;
          queueMicrotask(() => !this.destroyed && this.view.dispatch({}));
        });
      }
      update() {
        this.decorations = decorations(this.view, path);
      }
      destroy() {
        this.destroyed = true;
        this.unsub();
      }
    },
    { decorations: (v) => v.decorations },
  );
}
