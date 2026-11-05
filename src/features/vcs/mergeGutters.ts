/**
 * The merge editor's per-change controls, as in IntelliJ: an Accept arrow and an Ignore
 * cross beside each change in the side panes, a magic wand beside a conflict of the
 * result that can be resolved without a decision, and the changes tinted in the result.
 */
import { RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, WidgetType, gutter, type ViewUpdate } from "@codemirror/view";
import { scrollbarMarks, type ScrollbarMark } from "@/editor/api";
import { overviewLane } from "@/editor/core/cm/lanes";
import { hasPrimaryModifier } from "@/platform/keymap";
import { tx } from "@/platform/i18n";
import { iconMarkup } from "@/ui";
import {
  canResolveAutomatically,
  changesSide,
  isConflict,
  isResolved,
  mergeField,
  type MergeChange,
  type MergeSide,
} from "./mergeModel";

/** What the controls do; `resolve` is set when the platform's modifier key is held. */
export interface MergeControls {
  accept(index: number, side: MergeSide, resolve: boolean): void;
  ignore(index: number, side: MergeSide, resolve: boolean): void;
  resolveAutomatically(index: number): void;
}

/** Tells a side pane how the changes stand, whenever the result moves them on. */
export const syncSide = StateEffect.define<readonly MergeChange[]>();

const sideChanges = StateField.define<readonly MergeChange[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(syncSide)) return e.value;
    return value;
  },
});

function button(className: string, title: string, icon: string, press: (e: MouseEvent) => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML = iconMarkup(icon, 14) ?? "";
  b.addEventListener("mousedown", (e) => {
    // Pointer presses keep the editor's focus and selection.
    e.preventDefault();
    e.stopPropagation();
  });
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    press(e);
  });
  return b;
}

class SideMarker extends GutterMarker {
  constructor(
    readonly index: number,
    readonly side: MergeSide,
    readonly oneside: boolean,
    readonly controls: MergeControls,
  ) {
    super();
  }
  eq(other: SideMarker) {
    return other.index === this.index && other.side === this.side && other.oneside === this.oneside;
  }
  toDOM() {
    const box = document.createElement("div");
    box.className = "cm-merge-ops";
    const toward = this.side === "left" ? "right" : "left";
    const arrow = this.oneside ? `diff-arrow-${toward}-down` : `diff-arrow-${toward}`;
    box.append(
      button(
        "cm-merge-op cm-merge-accept",
        tx("Accept (hold the modifier key to resolve using this side)"),
        arrow,
        (e) => this.controls.accept(this.index, this.side, hasPrimaryModifier(e)),
      ),
      button(
        "cm-merge-op cm-merge-ignore",
        tx("Ignore (hold the modifier key to ignore both sides)"),
        "diff-remove",
        (e) => this.controls.ignore(this.index, this.side, hasPrimaryModifier(e)),
      ),
    );
    return box;
  }
}

/** Accept and Ignore beside each change of a side pane that is still to be decided. */
export function sideControls(side: MergeSide, controls: MergeControls): Extension {
  return [
    sideChanges,
    gutter({
      class: "cm-merge-gutter",
      lineMarker(view, line) {
        const doc = view.state.doc;
        const changes = view.state.field(sideChanges);
        const index = changes.findIndex((c) => {
          if (!changesSide(c, side) || c.done[side]) return false;
          const from = (side === "left" ? c.leftRange : c.rightRange)[0];
          return doc.lineAt(Math.min(from, doc.length)).from === line.from;
        });
        return index < 0 ? null : new SideMarker(index, side, changes[index]!.oneside, controls);
      },
      lineMarkerChange: (update) => update.transactions.some((tr) => tr.effects.some((e) => e.is(syncSide))),
    }),
  ];
}

class WandMarker extends GutterMarker {
  constructor(
    readonly index: number,
    readonly controls: MergeControls,
  ) {
    super();
  }
  eq(other: WandMarker) {
    return other.index === this.index;
  }
  toDOM() {
    const box = document.createElement("div");
    box.className = "cm-merge-ops";
    box.append(
      button("cm-merge-op cm-merge-wand", tx("Resolve Automatically"), "diff-magic", () =>
        this.controls.resolveAutomatically(this.index),
      ),
    );
    return box;
  }
}

/** Whether the changes of the result moved, were decided or were edited. */
export const mergeChanged = (u: ViewUpdate) =>
  u.docChanged || u.startState.field(mergeField) !== u.state.field(mergeField);

/** The wand beside a conflict of the result that needs no decision. */
export function resultControls(controls: MergeControls): Extension {
  return gutter({
    class: "cm-merge-gutter",
    lineMarker(view, line) {
      const doc = view.state.doc;
      const found = view.state
        .field(mergeField)
        .findIndex(
          (c) =>
            isConflict(c) &&
            canResolveAutomatically(doc, c, "base") &&
            doc.lineAt(Math.min(c.from, doc.length)).from === line.from,
        );
      return found < 0 ? null : new WandMarker(found, controls);
    },
    lineMarkerChange: mergeChanged,
  });
}

/** A change that adds lines has no text in the result yet; a thin line shows where it goes. */
class PointWidget extends WidgetType {
  constructor(readonly className: string) {
    super();
  }
  eq(other: PointWidget) {
    return other.className === this.className;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = `cm-merge-point ${this.className}`;
    return el;
  }
}

/** The changes tinted in the result: conflicts, the other changes and the settled ones. */
export const resultMarks = EditorView.decorations.compute([mergeField], (state) => {
  const out = new RangeSetBuilder<Decoration>();
  const doc = state.doc;
  for (const c of state.field(mergeField)) {
    const className = isResolved(c) ? "cm-merge-resolved" : isConflict(c) ? "cm-merge-conflict" : "cm-merge-change";
    if (c.to > c.from) {
      const last = doc.lineAt(c.to - 1).number;
      for (let n = doc.lineAt(c.from).number; n <= last; n++)
        out.add(doc.line(n).from, doc.line(n).from, Decoration.line({ class: className }));
    } else if (!isResolved(c)) {
      out.add(c.from, c.from, Decoration.widget({ widget: new PointWidget(className), block: true, side: -1 }));
    }
  }
  return out.finish();
});

/** A change's type (MergeConflictType): a conflict, else how the changed side(s) differ from the base. */
function changeType(c: MergeChange): "conflict" | "inserted" | "deleted" | "modified" {
  if (isConflict(c)) return "conflict";
  const changed = c.kind === "right" ? c.right : c.left;
  return c.base === "" ? "inserted" : changed === "" ? "deleted" : "modified";
}

const stripeMark = (c: MergeChange, from: number, to: number): ScrollbarMark => {
  const type = changeType(c);
  return {
    from,
    to: to > from ? to - 1 : from,
    color: `var(--diff-${type}-stripe)`,
    kind: "thin",
    priority: type === "conflict" ? 1 : 0,
  };
};

/**
 * The open changes on a pane's overview lane, as IDEA's merge viewer: the result marks each
 * change until it is resolved, a side pane the changes of that side until that side is accepted
 * or ignored (TextMergeChange: a resolved side paints no background, so no stripe either).
 */
export function mergeStripe(pane: MergeSide | "result"): Extension {
  const marks =
    pane === "result"
      ? scrollbarMarks.compute([mergeField], (state): readonly ScrollbarMark[] =>
          state.field(mergeField).flatMap((c) => (isResolved(c) ? [] : [stripeMark(c, c.from, c.to)])),
        )
      : scrollbarMarks.compute([sideChanges], (state): readonly ScrollbarMark[] =>
          state.field(sideChanges).flatMap((c) => {
            if (!changesSide(c, pane) || c.done[pane]) return [];
            const [from, to] = pane === "left" ? c.leftRange : c.rightRange;
            return [stripeMark(c, from, to)];
          }),
        );
  return [marks, overviewLane];
}

export const mergeTheme = EditorView.baseTheme({
  // A fixed width, so the text does not shift as controls come and go while scrolling.
  ".cm-merge-gutter": { minWidth: "34px" },
  ".cm-merge-ops": { display: "flex", alignItems: "center", justifyContent: "center", height: "100%" },
  ".cm-merge-op": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "14px",
    height: "14px",
    padding: 0,
    border: "none",
    borderRadius: "var(--radius-small)",
    color: "var(--fg-secondary)",
    background: "transparent",
    cursor: "pointer",
  },
  ".cm-merge-op:hover": { color: "var(--fg-strong)", background: "var(--bg-control-hover)" },
  ".cm-merge-conflict": { backgroundColor: "color-mix(in srgb, var(--vcs-conflict) 14%, transparent)" },
  ".cm-merge-change": { backgroundColor: "color-mix(in srgb, var(--vcs-modified) 14%, transparent)" },
  ".cm-merge-resolved": { color: "var(--fg-subtle)" },
  ".cm-merge-point": { height: "2px", margin: "0", pointerEvents: "none" },
  ".cm-merge-point.cm-merge-conflict": { backgroundColor: "var(--vcs-conflict)" },
  ".cm-merge-point.cm-merge-change": { backgroundColor: "var(--vcs-modified)" },
});
