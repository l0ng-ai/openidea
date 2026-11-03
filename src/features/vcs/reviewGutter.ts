/**
 * Code review gutter controls (collaboration-tools' `CodeReviewEditorGutterControlsRenderer`
 * and the comment range outline): a 16px column showing
 *
 * - a comment icon on lines with threads (click: show / hide them),
 * - on the hovered commentable line, the "+" (`InlineAdd`, its hover variant over the column;
 *   "Leave a comment") — or the remove icon ("Discard a comment") where a new comment is open;
 *   dragging the "+" over further commentable lines selects a range for a multi-line comment,
 * - with a text selection, the "+" on its last line (a comment on the selected lines),
 * - outlines of new comments' ranges, with drag handles to adjust them
 *   ("Drag to select several lines for commenting", or why it can't be adjusted).
 *
 * The owner pushes the state with `setReviewGutterState` and handles the requests.
 * Lines are 0-based; ranges are inclusive.
 */
import { StateEffect, StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, ViewPlugin, gutter, type DecorationSet } from "@codemirror/view";
import { tx } from "@/platform/i18n";
import { iconMarkup } from "@/ui";

export interface LineRange {
  start: number;
  end: number;
}

/** The range of a comment being written. */
export interface ReviewOutline {
  key: string;
  range: LineRange;
  /** Its ends can be dragged. */
  adjustable: boolean;
  /** Tooltip of the handles: how to adjust, or why it can't be. */
  tooltip: string;
}

export interface ReviewGutterState {
  linesWithComments: ReadonlySet<number>;
  linesWithNewComments: ReadonlySet<number>;
  /** Lines whose inlays are shown (there is room for a second icon under the line). */
  linesWithInlays: ReadonlySet<number>;
  /** Commentable lines, as half-open ranges `[start, end)`. */
  commentable: readonly { start: number; end: number }[];
  outlines: readonly ReviewOutline[];
}

export interface ReviewGutterHandlers {
  requestNewComment(range: LineRange): void;
  cancelNewComment(line: number): void;
  toggleComments(line: number): void;
  adjustRange?(key: string, range: LineRange): void;
}

export const EMPTY_REVIEW_GUTTER: ReviewGutterState = {
  linesWithComments: new Set(),
  linesWithNewComments: new Set(),
  linesWithInlays: new Set(),
  commentable: [],
  outlines: [],
};

export const setReviewGutterState = StateEffect.define<ReviewGutterState>();

export function isLineCommentable(state: ReviewGutterState, line: number): boolean {
  return state.commentable.some((r) => line >= r.start && line < r.end);
}

/** Both ends of `range` are commentable (`canCreateComment`); a pane shows one side, so they share it. */
export function canCreateComment(state: ReviewGutterState, range: LineRange): boolean {
  return isLineCommentable(state, range.start) && isLineCommentable(state, range.end);
}

/** `head` limited to the commentable lines next to `anchor` (a drag stays in one commentable range). */
export function clampToCommentable(state: ReviewGutterState, anchor: number, head: number): number {
  const dir = head >= anchor ? 1 : -1;
  let line = anchor;
  while (line !== head && isLineCommentable(state, line + dir)) line += dir;
  return line;
}

const sorted = (a: number, b: number): LineRange => ({ start: Math.min(a, b), end: Math.max(a, b) });

type Drag =
  | { kind: "new"; anchor: number; head: number }
  | { kind: "adjust"; key: string; fixed: number; head: number };

interface GutterData {
  state: ReviewGutterState;
  hover: { line: number; column: boolean } | null;
  drag: Drag | null;
  deco: DecorationSet;
}

const setHover = StateEffect.define<GutterData["hover"]>();
const setDrag = StateEffect.define<Drag | null>();

function dragRange(d: Drag): LineRange {
  return d.kind === "new" ? sorted(d.anchor, d.head) : sorted(d.fixed, d.head);
}

function decorations(doc: EditorState["doc"], data: Omit<GutterData, "deco">): DecorationSet {
  const ranges: LineRange[] = data.state.outlines
    .filter((o) => !(data.drag?.kind === "adjust" && data.drag.key === o.key))
    .map((o) => o.range);
  if (data.drag) ranges.push(dragRange(data.drag));
  const out: Range<Decoration>[] = [];
  for (const r of ranges) {
    for (let l = Math.max(0, r.start); l <= Math.min(r.end, doc.lines - 1); l++) {
      const cls = ["cm-reviewRange", l === r.start && "cm-reviewRange-first", l === r.end && "cm-reviewRange-last"];
      out.push(Decoration.line({ class: cls.filter(Boolean).join(" ") }).range(doc.line(l + 1).from));
    }
  }
  return Decoration.set(out, true);
}

const field = StateField.define<GutterData>({
  create: (s) => {
    const base = { state: EMPTY_REVIEW_GUTTER, hover: null, drag: null };
    return { ...base, deco: decorations(s.doc, base) };
  },
  update(value, tr) {
    let next = value;
    for (const e of tr.effects) {
      if (e.is(setReviewGutterState)) next = { ...next, state: e.value };
      else if (e.is(setHover)) next = { ...next, hover: e.value };
      else if (e.is(setDrag)) next = { ...next, drag: e.value };
    }
    if (next === value && !tr.docChanged) return value;
    const changedRanges = next.state !== value.state || next.drag !== value.drag || tr.docChanged;
    return { ...next, deco: changedRanges ? decorations(tr.state.doc, next) : value.deco };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

type Action = "toggle" | "add" | "cancel";

/** The last line of a non-empty selection, and the selected range. */
function selectionRange(state: EditorState): LineRange | null {
  const sel = state.selection.main;
  if (sel.empty) return null;
  return { start: state.doc.lineAt(sel.from).number - 1, end: state.doc.lineAt(sel.to).number - 1 };
}

/** The icons of `line`, top to bottom (`LogicalLineData.getActions`). */
function actionsOf(state: EditorState, line: number): Action[] {
  const data = state.field(field);
  const s = data.state;
  const out: Action[] = [];
  const hovered = data.hover?.line === line && !data.drag;
  const selected = selectionRange(state);
  const last = state.doc.lines - 1;
  const lastBlank = line === last && state.doc.line(line + 1).length === 0;
  if (s.linesWithComments.has(line)) out.push("toggle");
  if (!lastBlank && isLineCommentable(s, line)) {
    if (s.linesWithNewComments.has(line)) {
      if (hovered) out.push("cancel");
    } else if (selected && line === selected.end) out.push("add");
    else if (hovered && (!selected || line < selected.start || line > selected.end)) out.push("add");
  }
  return out;
}

class ControlsMarker extends GutterMarker {
  constructor(
    readonly line: number,
    readonly actions: readonly Action[],
    readonly columnHovered: boolean,
    readonly room: boolean,
    readonly handles: readonly { key: string; end: "start" | "end"; adjustable: boolean; tooltip: string }[],
  ) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return (
      other instanceof ControlsMarker &&
      other.line === this.line &&
      other.columnHovered === this.columnHovered &&
      other.room === this.room &&
      other.actions.join() === this.actions.join() &&
      JSON.stringify(other.handles) === JSON.stringify(this.handles)
    );
  }
  override toDOM(view: EditorView): Node {
    const box = document.createElement("div");
    box.className = "cm-reviewControls";
    box.dataset.line = String(this.line);
    box.style.setProperty("--cm-review-line", `${view.defaultLineHeight}px`);
    // A second icon goes under the line, over its inlays, only when they leave room (`layoutActions`).
    const shown = this.room ? this.actions : this.actions.slice(0, 1);
    shown.forEach((a, i) => {
      const btn = document.createElement("span");
      btn.className = `cm-reviewControl cm-reviewControl-${a}`;
      btn.dataset.action = a;
      btn.style.top = `calc(${i} * var(--cm-review-line, 1.4em))`;
      const icon =
        a === "toggle"
          ? "review-comment"
          : a === "cancel"
            ? "minus"
            : this.columnHovered
              ? "inline-add-hover"
              : "inline-add";
      btn.innerHTML = iconMarkup(icon, 16) ?? "";
      if (a === "add") btn.title = tx("Leave a comment");
      else if (a === "cancel") btn.title = tx("Discard a comment");
      box.append(btn);
    });
    for (const h of this.handles) {
      const handle = document.createElement("span");
      handle.className = `cm-reviewHandle cm-reviewHandle-${h.end}`;
      if (h.adjustable) {
        handle.dataset.action = `adjust-${h.end}`;
        handle.dataset.key = h.key;
      }
      handle.dataset.disabled = h.adjustable ? undefined : "true";
      handle.title = h.tooltip;
      box.append(handle);
    }
    return box;
  }
}

const spacer = new (class extends GutterMarker {
  override toDOM() {
    const el = document.createElement("div");
    el.className = "cm-reviewControls";
    return el;
  }
})();

function markerFor(state: EditorState, line: number): GutterMarker | null {
  const data = state.field(field);
  const actions = actionsOf(state, line);
  const handles = data.state.outlines.flatMap((o) =>
    (["start", "end"] as const)
      .filter((end) => (end === "start" ? o.range.start : o.range.end) === line)
      .map((end) => ({ key: o.key, end, adjustable: o.adjustable, tooltip: o.tooltip })),
  );
  if (!actions.length && !handles.length) return null;
  const room = data.state.linesWithInlays.has(line);
  return new ControlsMarker(line, actions, data.hover?.line === line && data.hover.column, room, handles);
}

function lineAtY(view: EditorView, clientY: number): number | null {
  const y = clientY - view.documentTop;
  if (y < 0 || y > view.contentHeight) return null;
  const block = view.lineBlockAtHeight(y);
  return view.state.doc.lineAt(block.from).number - 1;
}

/** The review gutter of a pane; `handlers` receive the user's requests. */
export function reviewGutter(handlers: ReviewGutterHandlers): Extension {
  const startDrag = (view: EditorView, drag: Drag) => {
    view.dispatch({ effects: setDrag.of(drag) });
    const move = (e: MouseEvent) => {
      const line = lineAtY(view, e.clientY);
      const cur = view.state.field(field).drag;
      if (line === null || !cur) return;
      const s = view.state.field(field).state;
      const head = clampToCommentable(s, cur.kind === "new" ? cur.anchor : cur.fixed, line);
      if (head !== cur.head) view.dispatch({ effects: setDrag.of({ ...cur, head }) });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up, true);
      const cur = view.state.field(field).drag;
      view.dispatch({ effects: setDrag.of(null) });
      if (!cur) return;
      const range = dragRange(cur);
      if (cur.kind === "new") handlers.requestNewComment(range);
      else handlers.adjustRange?.(cur.key, range);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up, true);
  };

  const column = gutter({
    class: "cm-reviewGutter",
    lineMarker: (view, block) => markerFor(view.state, view.state.doc.lineAt(block.from).number - 1),
    lineMarkerChange: (u) => u.startState.field(field) !== u.state.field(field) || u.selectionSet,
    initialSpacer: () => spacer,
    domEventHandlers: {
      mousedown(view, block, event) {
        const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-action]");
        const action = target?.dataset.action;
        if (!action || (event as MouseEvent).button !== 0) return false;
        event.preventDefault();
        const marked = Number(target.closest<HTMLElement>("[data-line]")?.dataset.line);
        const line = Number.isInteger(marked) ? marked : view.state.doc.lineAt(block.from).number - 1;
        const s = view.state.field(field).state;
        if (action === "toggle") handlers.toggleComments(line);
        else if (action === "cancel") handlers.cancelNewComment(line);
        else if (action === "add") {
          const selected = selectionRange(view.state);
          if (selected && selected.end === line && canCreateComment(s, selected)) handlers.requestNewComment(selected);
          else startDrag(view, { kind: "new", anchor: line, head: line });
        } else if (action.startsWith("adjust-") && target.dataset.key) {
          const outline = s.outlines.find((o) => o.key === target.dataset.key);
          if (!outline) return true;
          const fixed = action === "adjust-start" ? outline.range.end : outline.range.start;
          startDrag(view, { kind: "adjust", key: outline.key, fixed, head: line });
        }
        return true;
      },
    },
  });

  const hover = ViewPlugin.fromClass(
    class {
      constructor(readonly view: EditorView) {
        view.dom.addEventListener("mousemove", this.move);
        view.dom.addEventListener("mouseleave", this.leave);
      }
      move = (e: MouseEvent) => {
        const line = lineAtY(this.view, e.clientY);
        const col = !!(e.target as HTMLElement | null)?.closest?.(".cm-reviewGutter");
        const next = line === null ? null : { line, column: col };
        const cur = this.view.state.field(field).hover;
        if (cur?.line !== next?.line || cur?.column !== next?.column)
          this.view.dispatch({ effects: setHover.of(next) });
      };
      leave = () => {
        if (this.view.state.field(field).hover) this.view.dispatch({ effects: setHover.of(null) });
      };
      destroy() {
        this.view.dom.removeEventListener("mousemove", this.move);
        this.view.dom.removeEventListener("mouseleave", this.leave);
      }
    },
  );

  return [field, column, hover, theme];
}

const theme = EditorView.baseTheme({
  ".cm-reviewGutter": { width: "16px" },
  ".cm-reviewGutter .cm-gutterElement": { position: "relative", overflow: "visible" },
  ".cm-reviewControls": { position: "relative", width: "16px", height: "100%" },
  ".cm-reviewControl": {
    position: "absolute",
    left: "0",
    width: "16px",
    height: "var(--cm-review-line, 1.4em)",
    display: "flex",
    alignItems: "center",
    cursor: "pointer",
  },
  ".cm-reviewHandle": {
    position: "absolute",
    left: "2px",
    width: "12px",
    height: "4px",
    borderRadius: "2px",
    background: "var(--focus-ring, #3574f0)",
    cursor: "ns-resize",
  },
  ".cm-reviewHandle[data-disabled]": { opacity: "0.4", cursor: "default" },
  ".cm-reviewHandle-start": { top: "-2px" },
  ".cm-reviewHandle-end": { top: "calc(var(--cm-review-line, 1.4em) - 2px)" },
  ".cm-reviewRange": {
    boxShadow: "inset 2px 0 0 var(--focus-ring, #3574f0)",
    background: "color-mix(in srgb, var(--focus-ring, #3574f0) 8%, transparent)",
  },
});
