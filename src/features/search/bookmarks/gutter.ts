/**
 * Bookmark gutter: a narrow CodeMirror gutter with a marker per bookmarked
 * line (the mnemonic's letter / digit for mnemonic bookmarks). Markers map
 * through edits, and moved lines are written back to the store so bookmarks
 * follow the code. ⌘-click (Ctrl-click) in the gutter toggles a bookmark, as
 * in IDEA.
 */
import { RangeSet, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, type ViewUpdate } from "@codemirror/view";
import { emptyGutterSpacer } from "@/editor/api";
import { hasPrimaryModifier } from "@/platform/keymap";
import { marksOf, setFileLines, updateBookmarks, useBookmarks } from "./store";

const SVG_NS = "http://www.w3.org/2000/svg";

class BookmarkMarker extends GutterMarker {
  constructor(readonly mnemonic: string | null) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return other instanceof BookmarkMarker && other.mnemonic === this.mnemonic;
  }
  override toDOM() {
    if (this.mnemonic) {
      const el = document.createElement("span");
      el.className = "cm-openidea-bookmarkMnemonic";
      el.textContent = this.mnemonic;
      el.setAttribute("aria-label", `Bookmark ${this.mnemonic}`);
      return el;
    }
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "11");
    svg.setAttribute("height", "11");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("cm-openidea-bookmark");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M7 4h10v16l-5-4-5 4z");
    svg.appendChild(path);
    return svg;
  }
}

class SpacerMarker extends GutterMarker {
  override toDOM() {
    const el = document.createElement("span");
    el.style.display = "inline-block";
    el.style.width = "11px";
    return el;
  }
}

const plain = new BookmarkMarker(null);
const spacer = new SpacerMarker();

type Mark = { line: number; mnemonic: string | null };

const setMarks = StateEffect.define<Mark[]>();

function build(doc: EditorView["state"]["doc"], marks: readonly Mark[]): RangeSet<BookmarkMarker> {
  const seen = new Set<number>();
  const ranges = [...marks]
    .filter((m) => m.line >= 0 && m.line < doc.lines && !seen.has(m.line) && seen.add(m.line))
    .sort((a, b) => a.line - b.line)
    .map((m) => (m.mnemonic ? new BookmarkMarker(m.mnemonic) : plain).range(doc.line(m.line + 1).from));
  return RangeSet.of(ranges);
}

function marksIn(view: EditorView, set: RangeSet<BookmarkMarker>): Mark[] {
  const out: Mark[] = [];
  const iter = set.iter();
  while (iter.value) {
    out.push({ line: view.state.doc.lineAt(iter.from).number - 1, mnemonic: iter.value.mnemonic });
    iter.next();
  }
  return out;
}

const sameMarks = (a: readonly Mark[], b: readonly Mark[]) =>
  a.length === b.length && a.every((v, i) => v.line === b[i]!.line && v.mnemonic === b[i]!.mnemonic);

/** The 0-based line of a click in the gutter, or null outside it. */
function gutterLine(view: EditorView, e: MouseEvent): number | null {
  const t = e.target as HTMLElement | null;
  if (!t?.closest?.(".cm-gutters") || t.closest(".cm-foldGutter")) return null;
  const block = view.lineBlockAtHeight(e.clientY - view.documentTop);
  return block ? view.state.doc.lineAt(block.from).number - 1 : null;
}

export function bookmarkGutter(path: string, toggle: (line: number) => void): Extension {
  const field = StateField.define<RangeSet<BookmarkMarker>>({
    create: (state) => build(state.doc, marksOf(useBookmarks.getState().items, path)),
    update(value, tr) {
      let next = tr.docChanged ? value.map(tr.changes) : value;
      for (const e of tr.effects) if (e.is(setMarks)) next = build(tr.state.doc, e.value);
      return next;
    },
  });

  const sync = ViewPlugin.fromClass(
    class {
      private unsub: () => void;
      private pending = false;
      constructor(private readonly view: EditorView) {
        this.unsub = useBookmarks.subscribe((s, prev) => {
          if (s.items === prev.items) return;
          const want = marksOf(s.items, path);
          if (!sameMarks(want, marksIn(this.view, this.view.state.field(field)))) {
            this.view.dispatch({ effects: setMarks.of(want) });
          }
        });
        // Bookmarks may have changed while this editor was being created.
        const want = marksOf(useBookmarks.getState().items, path);
        if (!sameMarks(want, marksIn(view, view.state.field(field)))) {
          queueMicrotask(() => view.dispatch({ effects: setMarks.of(want) }));
        }
        // Capture phase: runs before the breakpoint gutter's click handler, which ⌘-click must not reach.
        view.dom.addEventListener("mousedown", this.onMouseDown, true);
      }
      onMouseDown = (e: MouseEvent) => {
        if (e.button !== 0 || !hasPrimaryModifier(e) || e.shiftKey || e.altKey) return;
        const line = gutterLine(this.view, e);
        if (line == null) return;
        e.preventDefault();
        e.stopPropagation();
        toggle(line);
      };
      update(u: ViewUpdate) {
        if (!u.docChanged || this.pending) return;
        this.pending = true;
        // Write back after the update cycle (dispatching inside update is not allowed).
        queueMicrotask(() => {
          this.pending = false;
          const view = this.view;
          if (!view.dom.isConnected) return;
          const marks = marksIn(view, view.state.field(field));
          const stored = marksOf(useBookmarks.getState().items, path);
          if (sameMarks(marks, stored)) return;
          updateBookmarks((list) =>
            setFileLines(
              list,
              path,
              marks.map((m) => ({ line: m.line, text: view.state.doc.line(m.line + 1).text })),
            ),
          );
        });
      }
      destroy() {
        this.unsub();
        this.view.dom.removeEventListener("mousedown", this.onMouseDown, true);
      }
    },
  );

  return [
    field,
    sync,
    gutter({
      class: "cm-openidea-bookmarks",
      markers: (v) => v.state.field(field),
      // Reserve the bookmark's width only while this file has bookmarks.
      initialSpacer: () => emptyGutterSpacer,
      updateSpacer: (_spacer, u) => (u.state.field(field).size ? spacer : emptyGutterSpacer),
    }),
    theme,
  ];
}

const theme = EditorView.baseTheme({
  ".cm-openidea-bookmarks .cm-gutterElement": {
    display: "flex",
    alignItems: "center",
    // Spare width stays left of the bookmark, which sits next to the code.
    justifyContent: "flex-end",
  },
  // Not on the empty spacer, so the column collapses fully in files without bookmarks.
  ".cm-openidea-bookmarks .cm-gutterElement:not(:empty)": { padding: "0 2px" },
  ".cm-openidea-bookmark": {
    fill: "none",
    stroke: "var(--accent)",
    strokeWidth: "2",
    strokeLinejoin: "round",
  },
  ".cm-openidea-bookmarkMnemonic": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: "11px",
    height: "12px",
    padding: "0 1px",
    borderRadius: "2px",
    border: "1px solid var(--accent)",
    color: "var(--fg-strong)",
    background: "var(--accent-soft)",
    fontFamily: "var(--font-ui)",
    fontSize: "9px",
    fontWeight: "600",
    lineHeight: "1",
  },
});
