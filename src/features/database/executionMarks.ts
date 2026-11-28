import {
  EditorSelection,
  RangeSet,
  StateEffect,
  StateField,
  type EditorState,
  type Range,
  type Text,
  type Transaction,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  GutterMarker,
  RectangleMarker,
  WidgetType,
  gutter,
  layer,
  showPanel,
  type Panel,
} from "@codemirror/view";
import { problemProviders, type ContributedProblem } from "@/editor/api";
import type { ConfirmUnsafe } from "./store";
import { unsafeMessage } from "./sql/unsafe";
import { tx } from "@/platform/i18n";
import { iconNode, spinnerNode } from "@/ui/iconNode";
import { formatElapsed } from "./resultView";

/** Statement outcomes of the last run, kept on the text (IDEA's gutter check / error and timing). */
interface RunMark {
  from: number;
  to: number;
  /** After the statement's `;` when it has one. */
  timingAt: number;
  error: string | null;
  ms: number | null;
}

interface Executing {
  /** Tells this run from a later one on the same console. */
  token: number;
  active: { index: number; startedAt: number } | null;
  spans: readonly { from: number; to: number }[];
}

function activeSpan(ex: Executing | null) {
  const span = ex?.active ? ex.spans[ex.active.index] : undefined;
  return span && span.from < span.to ? span : undefined;
}

interface AskMark {
  from: number;
  to: number;
  message: string;
}

interface RunState {
  ask?: AskMark | null;
  marks: readonly RunMark[];
  /** Message of the bottom error banner (`null`: hidden). */
  banner: string | null;
  executing: Executing | null;
}

const setRun = StateEffect.define<RunState>();
const setAsk = StateEffect.define<AskMark | null>();

/** Saving can append the final newline without changing any submitted SQL or statement offsets. */
function savedFinalNewline(tr: Transaction): boolean {
  if (!tr.docChanged || !tr.isUserEvent("input.save")) return false;
  const end = tr.startState.doc.length;
  let only = true;
  tr.changes.iterChanges((from, to, _f, _t, insert) => {
    only &&= from === end && to === end && insert.toString() === "\n";
  });
  return only;
}

export const runField = StateField.define<RunState>({
  create: () => ({ marks: [], banner: null, executing: null }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setRun)) value = { ...e.value, ask: value.ask };
    for (const e of tr.effects) if (e.is(setAsk)) value = { ...value, ask: e.value };
    if (!tr.docChanged || savedFinalNewline(tr)) return value;
    // The request runs the text it was sent; edits only move where that shows.
    const ex = value.executing;
    const executing = ex && {
      ...ex,
      spans: ex.spans.map((r) => ({ from: tr.changes.mapPos(r.from, 1), to: tr.changes.mapPos(r.to, -1) })),
    };
    // Editing a statement drops its mark.
    const marks: RunMark[] = [];
    for (const m of value.marks) {
      let touched = false;
      tr.changes.iterChangedRanges((a, b) => {
        if (a <= m.to && b >= m.from) touched = true;
      });
      if (!touched)
        marks.push({
          ...m,
          from: tr.changes.mapPos(m.from),
          to: tr.changes.mapPos(m.to),
          timingAt: tr.changes.mapPos(m.timingAt),
        });
    }
    return { ...value, marks, executing, ask: null };
  },
  provide: (f) => [
    EditorView.decorations.compute([f], (state) => {
      const st = state.field(f);
      const ranges = [];
      const active = st.executing?.active;
      const span = activeSpan(st.executing);
      if (active && span) {
        const end = state.sliceDoc(span.to, span.to + 1) === ";" ? span.to + 1 : span.to;
        const at = Math.min(end, state.doc.lineAt(span.from).to);
        ranges.push(Decoration.mark({ class: "cm-openidea-db-executing" }).range(span.from, span.to));
        ranges.push(Decoration.widget({ widget: new ElapsedWidget(active.startedAt), side: 1 }).range(at));
      }
      for (const m of st.marks) {
        if (m.error) ranges.push(Decoration.mark({ class: "cm-openidea-db-error" }).range(m.from, m.to));
        if (m.ms !== null)
          ranges.push(Decoration.widget({ widget: new TimingWidget(m.ms), side: 1 }).range(m.timingAt));
      }
      const u = st.ask;
      if (u && u.from < u.to) ranges.push(Decoration.mark({ class: "cm-openidea-db-warning" }).range(u.from, u.to));
      return Decoration.set(ranges, true);
    }),
    showPanel.from(f, (st) => (st.ask ? askBanner(st.ask) : st.banner ? errorBanner(st.banner) : null)),
    // The editor's hover shows the run errors and the unsafe-query warning like other problems.
    problemProviders.compute([f], (state) => {
      const st = state.field(f);
      const problems: ContributedProblem[] = [];
      for (const m of st.marks)
        if (m.error && m.from < m.to) problems.push({ from: m.from, to: m.to, severity: "error", message: m.error });
      const u = st.ask;
      if (u && u.from < u.to) problems.push({ from: u.from, to: u.to, severity: "warning", message: u.message });
      return () => problems;
    }),
  ],
});

class TimingWidget extends WidgetType {
  constructor(readonly ms: number) {
    super();
  }
  eq(other: TimingWidget) {
    return other.ms === this.ms;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-openidea-db-timing";
    span.textContent = formatElapsed(this.ms);
    return span;
  }
}

/** The running time of the request, ticking until it ends. */
class ElapsedWidget extends WidgetType {
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(readonly startedAt: number) {
    super();
  }
  eq(other: ElapsedWidget) {
    return other.startedAt === this.startedAt;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-openidea-db-timing cm-openidea-db-elapsed";
    const tick = () => {
      const elapsed = formatElapsed(Date.now() - this.startedAt);
      span.textContent = tx`Executing… ${elapsed}`;
    };
    tick();
    this.timer = setInterval(tick, 100);
    return span;
  }
  destroy() {
    clearInterval(this.timer);
  }
}

class ExecutingMarker extends GutterMarker {
  eq(other: GutterMarker) {
    return other instanceof ExecutingMarker;
  }
  toDOM() {
    const el = spinnerNode(12, "cm-openidea-db-run-executing");
    el.title = tx("Executing");
    return el;
  }
}

class RunMarker extends GutterMarker {
  constructor(
    readonly error: string | null,
    readonly warning: string | null = null,
  ) {
    super();
  }
  eq(other: RunMarker) {
    return other.error === this.error && other.warning === this.warning;
  }
  toDOM() {
    if (this.warning) {
      const el = iconNode("warning", 14, "cm-openidea-db-run-warning");
      el.dataset.tooltip = this.warning;
      return el;
    }
    const el = iconNode(
      this.error ? "error" : "check",
      14,
      this.error ? "cm-openidea-db-run-error" : "cm-openidea-db-run-ok",
    );
    el.dataset.tooltip = this.error ?? tx("Executed");
    return el;
  }
}

const runGutter = gutter({
  class: "cm-openidea-db-gutter",
  markers: (view) => {
    const st = view.state.field(runField);
    const doc = view.state.doc;
    const active = activeSpan(st.executing);
    const line = active ? doc.lineAt(active.from).from : undefined;
    const unsafe = st.ask;
    const unsafeLine = unsafe && unsafe.from <= doc.length ? doc.lineAt(unsafe.from).from : -1;
    const ranges: Range<GutterMarker>[] = st.marks
      .filter((m) => m.from <= doc.length && doc.lineAt(m.from).from !== unsafeLine)
      .map((m) => new RunMarker(m.error).range(doc.lineAt(m.from).from));
    if (line !== undefined && line !== unsafeLine) ranges.push(new ExecutingMarker().range(line));
    if (unsafe && unsafeLine >= 0) ranges.push(new RunMarker(null, unsafe.message).range(unsafeLine));
    return RangeSet.of(ranges, true);
  },
});

function errorBanner(message: string) {
  return (view: EditorView): Panel => {
    const dom = document.createElement("div");
    dom.className = "cm-openidea-db-banner";
    dom.setAttribute("role", "alert");
    const text = document.createElement("span");
    text.className = "cm-openidea-db-banner-text";
    text.textContent = message;
    text.title = message;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "cm-openidea-db-banner-close";
    close.setAttribute("aria-label", "Close");
    close.appendChild(iconNode("close", 14));
    close.onclick = () => view.dispatch({ effects: setRun.of({ ...view.state.field(runField), banner: null }) });
    dom.append(text, close);
    return { dom, top: false };
  };
}

type AskChoice = "execute" | "suppress" | "cancel";

/** The answer to the banner a view asks with. */
const askAnswers = new WeakMap<EditorView, (choice: AskChoice) => void>();
/** Consoles whose unsafe queries run without asking (Execute and Suppress), until the app restarts. */
const unsafeSuppressed = new Set<string>();

function askBanner(mark: AskMark) {
  return (view: EditorView): Panel => {
    const dom = document.createElement("div");
    dom.className = "cm-openidea-db-banner cm-openidea-db-banner-warning";
    dom.setAttribute("role", "alert");
    const text = document.createElement("span");
    text.className = "cm-openidea-db-banner-text";
    text.textContent = mark.message;
    text.dataset.tooltip = mark.message;
    const answer = (choice: AskChoice) => askAnswers.get(view)?.(choice);
    const action = (label: string, choice: AskChoice) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "cm-openidea-db-banner-action";
      b.textContent = label;
      b.onclick = () => answer(choice);
      return b;
    };
    const close = document.createElement("button");
    close.type = "button";
    close.className = "cm-openidea-db-banner-close";
    close.setAttribute("aria-label", tx("Close"));
    close.appendChild(iconNode("close", 14));
    close.onclick = () => answer("cancel");
    const actions = [action(tx("Execute"), "execute"), action(tx("Execute and Suppress"), "suppress")];
    dom.append(text, ...actions, close);
    return { dom, top: false };
  };
}

/**
 * Editing or closing the console while the unsafe-query banner waits cancels the run.
 */
const cancelAskOnEdit = [
  EditorView.updateListener.of((u) => {
    if (!u.docChanged) return;
    if (u.transactions.every((tr) => !tr.docChanged || savedFinalNewline(tr))) {
      const preparing = preparingViews.get(u.view);
      if (preparing?.doc === u.startState.doc) preparing.doc = u.state.doc;
      return;
    }
    if (u.startState.field(runField).ask) askAnswers.get(u.view)?.("cancel");
  }),
  ViewPlugin.define((view) => ({
    destroy: () => {
      closedViews.add(view);
      askAnswers.get(view)?.("cancel");
    },
  })),
];
/** Views destroyed with a question open: nothing more to dispatch to them. */
const closedViews = new WeakSet<EditorView>();

/** Shows `mark` in the banner and waits for the answer. */
function ask(view: EditorView, mark: AskMark): Promise<AskChoice> {
  askAnswers.get(view)?.("cancel");
  return new Promise<AskChoice>((resolve) => {
    askAnswers.set(view, (choice) => {
      askAnswers.delete(view);
      if (!closedViews.has(view) && view.state.field(runField, false)?.ask) view.dispatch({ effects: setAsk.of(null) });
      resolve(choice);
    });
    view.dispatch({ effects: setAsk.of(mark) });
  });
}

/** Shows the unsafe-query banner for `statement` and waits for the answer (true: run it). */
export function confirmUnsafe(view: EditorView, path: string, current: () => boolean): ConfirmUnsafe {
  return async (statement, unsafe) => {
    if (!current()) return false;
    if (unsafeSuppressed.has(path)) return true;
    const len = view.state.doc.length;
    const choice = await ask(view, {
      from: Math.min(len, statement.from + unsafe.from),
      to: Math.min(len, statement.from + unsafe.to),
      message: unsafeMessage(unsafe),
    });
    if (choice === "suppress") unsafeSuppressed.add(path);
    return choice !== "cancel";
  };
}

export const setPreview = StateEffect.define<readonly { from: number; to: number }[]>();

/**
 * The range the console's next Execute would submit, bordered on the text (DataGrip's current
 * statement border): the caret's statement, or the selection's — the statements `db_statements`
 * splits that range into, the very call the run itself makes.
 */
const previewField = StateField.define<readonly { from: number; to: number }[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setPreview)) return e.value;
    if (!tr.docChanged) return value;
    // The preview is of the text it was computed for; edits only move where that is.
    const next: { from: number; to: number }[] = [];
    for (const r of value) {
      const from = tr.changes.mapPos(r.from, 1);
      const to = tr.changes.mapPos(r.to, -1);
      if (from < to) next.push({ from, to });
    }
    return next;
  },
});

/** The bordered ranges: a run in progress keeps its submitted range, whatever the caret does. */
export function previewRanges(state: EditorState): readonly { from: number; to: number }[] {
  const ex = state.field(runField, false)?.executing;
  const ranges = ex?.spans.length
    ? [{ from: ex.spans[0]!.from, to: ex.spans[ex.spans.length - 1]!.to }]
    : (state.field(previewField, false) ?? []);
  return ranges.filter((r) => r.from < r.to);
}

const PREVIEW_CLASS = "cm-openidea-db-preview";

/**
 * One box around each statement's text: the union of its lines' text (indentation and trailing
 * blanks left out), as tall as the statement even where it runs out of view.
 */
function previewBoxes(view: EditorView): RectangleMarker[] {
  const { doc } = view.state;
  const boxes: RectangleMarker[] = [];
  for (const r of previewRanges(view.state)) {
    let left = Infinity;
    let right = -Infinity;
    let offset: number | null = null;
    for (const visible of view.visibleRanges) {
      const from = Math.max(r.from, visible.from);
      const to = Math.min(r.to, visible.to);
      if (from >= to) continue;
      for (let pos = from; pos <= to;) {
        const line = doc.lineAt(pos);
        const text = line.text;
        let start = Math.max(from, line.from) - line.from;
        let end = Math.min(to, line.to) - line.from;
        while (start < end && /\s/.test(text[start]!)) start++;
        while (end > start && /\s/.test(text[end - 1]!)) end--;
        if (start < end)
          for (const m of RectangleMarker.forRange(
            view,
            PREVIEW_CLASS,
            EditorSelection.range(line.from + start, line.from + end),
          )) {
            left = Math.min(left, m.left);
            right = Math.max(right, m.left + (m.width ?? 0));
            offset ??= m.top - view.lineBlockAt(line.from).top;
          }
        pos = line.to + 1;
      }
    }
    if (offset == null || right <= left) continue;
    const top = view.lineBlockAt(r.from).top + offset;
    const bottom = view.lineBlockAt(r.to).bottom + offset;
    boxes.push(new RectangleMarker(PREVIEW_CLASS, left - 2, top, right - left + 4, bottom - top));
  }
  return boxes;
}

const previewLayer = layer({
  above: false,
  markers: previewBoxes,
  update: (u) =>
    u.docChanged ||
    u.viewportChanged ||
    u.geometryChanged ||
    u.startState.field(previewField, false) !== u.state.field(previewField, false) ||
    u.startState.field(runField, false)?.executing !== u.state.field(runField, false)?.executing,
});

export const executionMarks = [runField, runGutter, cancelAskOnEdit, previewField, previewLayer];

type StatementSpan = { from: number; to: number };
type RunOutcome = { index: number; error: string | null; ms: number | null };

let nextExecution = 0;
const preparingViews = new WeakMap<EditorView, { doc: Text }>();

/** Track the submitted ranges through edits, without changing the editor selection. */
export function trackExecution(view: EditorView, bannerFor?: (error: string) => string) {
  const token = ++nextExecution;
  const sent = view.state.doc;
  askAnswers.get(view)?.("cancel");
  const preparing = { doc: sent };
  preparingViews.set(view, preparing);
  const current = () =>
    !closedViews.has(view) && view.state.doc === preparing.doc && preparingViews.get(view) === preparing;
  return {
    current,
    start(spans: readonly StatementSpan[]) {
      const st = view.state.field(runField, false);
      const first = spans[0],
        last = spans.at(-1);
      // The offsets are into the text sent; an edit while preparing leaves them unplaced.
      if (!st || !current() || !first || !last) return;
      const marks = st.marks.filter((mark) => mark.to <= first.from || mark.from >= last.to);
      view.dispatch({ effects: setRun.of({ marks, banner: null, executing: { token, spans, active: null } }) });
    },
    update(active: Executing["active"], outcomes: readonly RunOutcome[] = []) {
      const st = view.state.field(runField, false);
      const ex = st?.executing;
      const placed = new Map<number, StatementSpan>();
      if (!st || ex?.token !== token) return placed;
      const marks = [...st.marks];
      let banner = st.banner;
      for (const { index, error, ms } of outcomes) {
        const span = ex.spans[index];
        if (!span || span.from >= span.to) continue;
        const { from, to } = span;
        marks.push({
          from,
          to,
          timingAt: view.state.sliceDoc(to, to + 1) === ";" ? to + 1 : to,
          error,
          ms,
        });
        if (error && bannerFor) banner = bannerFor(error);
        placed.set(index, span);
      }
      view.dispatch({ effects: setRun.of({ marks, banner, executing: { ...ex, active } }) });
      return placed;
    },
    end() {
      if (preparingViews.get(view) === preparing) preparingViews.delete(view);
      const st = view.state.field(runField, false);
      if (st?.executing?.token === token) view.dispatch({ effects: setRun.of({ ...st, executing: null }) });
    },
  };
}
