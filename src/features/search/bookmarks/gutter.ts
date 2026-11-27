/**
 * Bookmark gutter: a narrow CodeMirror gutter with a marker per bookmarked
 * line (the mnemonic's letter / digit for mnemonic bookmarks). Markers map
 * through edits, and moved lines are written back to the store so bookmarks
 * follow the code. ⌘-click (Ctrl-click) in the gutter toggles a bookmark, as
 * in IDEA.
 */
import { RangeSet, StateEffect, StateField, type Extension, type Text, type Transaction } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, type ViewUpdate } from "@codemirror/view";
import { emptyGutterSpacer } from "@/editor/api";
import { hasPrimaryModifier } from "@/platform/keymap";
import { sortBookmarks, updateBookmarks, useBookmarks, type Bookmark } from "./store";

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

const setMarks = StateEffect.define<readonly Bookmark[]>();

function build(doc: Text, bookmarks: readonly Bookmark[]) {
  const seen = new Set<number>();
  const ranges = bookmarks
    .filter((m) => m.line >= 0 && m.line < doc.lines && !seen.has(m.line) && seen.add(m.line))
    .sort((a, b) => a.line - b.line)
    .map((m) => (m.mnemonic ? new BookmarkMarker(m.mnemonic) : plain).range(doc.line(m.line + 1).from));
  return { bookmarks, markers: RangeSet.of(ranges) };
}

function moveBookmarks(bookmarks: readonly Bookmark[], tr: Transaction): readonly Bookmark[] {
  if (bookmarks.length === 0) return bookmarks;
  const { doc } = tr.startState;
  const { changes, newDoc } = tr;
  const removals: { from: number; to: number }[] = [];
  changes.iterChanges((from, to, _fromB, _toB, insert) => {
    if (from < to && insert.lines === 1) removals.push({ from, to });
  });
  const seen = new Set<number>();
  const moved: Bookmark[] = [];
  for (const bookmark of bookmarks) {
    if (bookmark.line < 0 || bookmark.line >= doc.lines) {
      moved.push(bookmark);
      continue;
    }
    const line = doc.line(bookmark.line + 1);
    // A line disappears when deletion covers its text and a line break.
    // An empty line uses its following break, so deleting its predecessor leaves it intact.
    if (
      removals.some(
        ({ from, to }) => from <= line.from && to >= line.to && (to > line.to || (line.length > 0 && from < line.from)),
      )
    )
      continue;
    const next = newDoc.lineAt(changes.mapPos(line.from, 1));
    if (seen.has(next.number)) continue;
    seen.add(next.number);
    const number = next.number - 1;
    moved.push(
      number === bookmark.line ? bookmark : { ...bookmark, line: number, text: next.text.trim().slice(0, 200) },
    );
  }
  return moved;
}

const sameBookmarks = (a: readonly Bookmark[], b: readonly Bookmark[]) =>
  a.length === b.length &&
  a.every((mark, i) => {
    const other = b[i]!;
    return (
      mark === other ||
      (mark.path === other.path &&
        mark.line === other.line &&
        mark.text === other.text &&
        mark.mnemonic === other.mnemonic &&
        mark.description === other.description &&
        mark.list === other.list &&
        mark.created === other.created)
    );
  });

const fileBookmarks = (list: readonly Bookmark[], path: string) => list.filter((b) => b.path === path);

/** The 0-based line of a click in the gutter, or null outside it. */
function gutterLine(view: EditorView, e: MouseEvent): number | null {
  const t = e.target as HTMLElement | null;
  if (!t?.closest?.(".cm-gutters") || t.closest(".cm-foldGutter")) return null;
  const block = view.lineBlockAtHeight(e.clientY - view.documentTop);
  return block ? view.state.doc.lineAt(block.from).number - 1 : null;
}

export function bookmarkGutter(path: string, toggle: (line: number) => void): Extension {
  const field = StateField.define<ReturnType<typeof build>>({
    create: (state) => build(state.doc, fileBookmarks(useBookmarks.getState().items, path)),
    update(value, tr) {
      const effect = tr.effects.find((e) => e.is(setMarks));
      if (effect) return build(tr.newDoc, effect.value);
      return tr.docChanged ? build(tr.newDoc, moveBookmarks(value.bookmarks, tr)) : value;
    },
  });

  const sync = ViewPlugin.fromClass(
    class {
      private unsub: () => void;
      private pending = false;
      constructor(private readonly view: EditorView) {
        this.unsub = useBookmarks.subscribe((s, prev) => {
          if (s.items === prev.items) return;
          const want = fileBookmarks(s.items, path);
          if (sameBookmarks(want, fileBookmarks(prev.items, path))) return;
          if (!sameBookmarks(want, this.view.state.field(field).bookmarks)) {
            this.view.dispatch({ effects: setMarks.of(want) });
          }
        });
        // Bookmarks may have changed while this editor was being created.
        if (!sameBookmarks(fileBookmarks(useBookmarks.getState().items, path), view.state.field(field).bookmarks)) {
          queueMicrotask(() =>
            view.dispatch({ effects: setMarks.of(fileBookmarks(useBookmarks.getState().items, path)) }),
          );
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
        if (sameBookmarks(u.startState.field(field).bookmarks, u.state.field(field).bookmarks)) return;
        this.pending = true;
        // Write back after the update cycle (dispatching inside update is not allowed).
        queueMicrotask(() => {
          this.pending = false;
          const view = this.view;
          if (!view.dom.isConnected) return;
          const marks = view.state.field(field).bookmarks;
          if (sameBookmarks(marks, fileBookmarks(useBookmarks.getState().items, path))) return;
          updateBookmarks((list) => sortBookmarks([...list.filter((b) => b.path !== path), ...marks]));
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
      markers: (v) => v.state.field(field).markers,
      // Reserve the bookmark's width only while this file has bookmarks.
      initialSpacer: () => emptyGutterSpacer,
      updateSpacer: (_spacer, u) => (u.state.field(field).markers.size ? spacer : emptyGutterSpacer),
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
