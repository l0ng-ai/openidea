/** Moved-code highlights and keyboard-accessible links between split diff panes. */
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { getChunks, mergeViewSiblings, uncollapseUnchanged } from "@codemirror/merge";
import { tx } from "@/platform/i18n";
import { chunkDecorations } from "./cm";
import { getDiffInsights } from "./diffOptions";

class MovedCodeLink extends WidgetType {
  constructor(
    readonly target: number,
    readonly line: number,
    readonly edited: boolean,
  ) {
    super();
  }
  eq(other: MovedCodeLink) {
    return other.target === this.target && other.line === this.line && other.edited === this.edited;
  }
  toDOM(view: EditorView) {
    const button = document.createElement("button");
    const isA = getChunks(view.state)?.side === "a";
    button.type = "button";
    button.className = "cm-diffMoveLink";
    if (this.edited)
      button.title = isA
        ? tx`Moved to line ${this.line} with internal edits`
        : tx`Moved from line ${this.line} with internal edits`;
    button.textContent = this.edited
      ? isA
        ? tx`To L${this.line} (edited)`
        : tx`From L${this.line} (edited)`
      : isA
        ? tx`Moved to line ${this.line}`
        : tx`Moved from line ${this.line}`;
    button.setAttribute(
      "aria-label",
      isA ? tx`Go to moved code at line ${this.line}` : tx`Go to original code at line ${this.line}`,
    );
    button.onclick = () => {
      const panes = mergeViewSiblings(view);
      if (!panes) return;
      const other = isA ? panes.b : panes.a;
      if (!other) return;
      other.dispatch({
        selection: { anchor: this.target },
        effects: [uncollapseUnchanged.of(this.target), EditorView.scrollIntoView(this.target, { y: "center" })],
      });
      other.focus();
    };
    return button;
  }
  ignoreEvent() {
    return true;
  }
}

function decorations(view: EditorView, words: boolean): DecorationSet {
  const info = getChunks(view.state);
  if (!info?.side) return Decoration.none;
  const isA = info.side === "a";
  const ranges = getDiffInsights(info.chunks).moves.flatMap((m) => {
    const [from, to, target] = isA ? [m.fromA, m.toA, m.fromB] : [m.fromB, m.toB, m.fromA];
    const line = isA ? m.lineB : m.lineA;
    const edits = words
      ? m.changes.flatMap((c) => {
          const start = isA ? c.start1 : c.start2;
          const end = isA ? c.end1 : c.end2;
          return start === end
            ? []
            : [
                Decoration.mark({
                  class: `cm-diffMoveEdit cm-diffMoveEdit-${isA ? "deleted" : "inserted"}`,
                  attributes: { title: tx("Edited within moved code") },
                }).range(from + start, from + end),
              ];
        })
      : [];
    return [
      Decoration.mark({ class: "cm-diffMoved" }).range(from, to),
      ...edits,
      Decoration.widget({ widget: new MovedCodeLink(target, line, m.changes.length > 0), side: 1 }).range(
        view.state.doc.lineAt(from).to,
      ),
    ];
  });
  return Decoration.set(ranges, true);
}

export const movedCodeHighlights = (words: boolean) => [
  chunkDecorations((view) => decorations(view, words)),
  EditorView.baseTheme({
    ".cm-diffMoved": {
      backgroundColor: "color-mix(in srgb, var(--diff-modified) 70%, transparent)",
      textDecoration: "underline dotted",
      textUnderlineOffset: "3px",
    },
    ".cm-diffMoveEdit-deleted": { backgroundColor: "color-mix(in srgb, var(--diff-deleted) 85%, transparent)" },
    ".cm-diffMoveEdit-inserted": { backgroundColor: "color-mix(in srgb, var(--diff-inserted) 85%, transparent)" },
    ".cm-diffMoveLink": {
      marginLeft: "12px",
      padding: "0 4px",
      fontFamily: "var(--font-ui)",
      fontSize: "var(--fs-small)",
      color: "var(--link)",
      background: "var(--bg-app)",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-small)",
      cursor: "pointer",
    },
    ".cm-diffMoveLink:hover": { background: "var(--bg-hover)" },
    ".cm-diffMoveLink:focus-visible": { outline: "2px solid var(--accent)", outlineOffset: "2px" },
  }),
];
