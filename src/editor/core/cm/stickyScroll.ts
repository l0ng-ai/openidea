/**
 * Sticky scroll: the header lines of the scopes enclosing the first visible
 * line stay pinned at the top (IDEA 2023+ / VS Code). Scopes come from the
 * backend folding ranges, or from the syntax tree when there are none.
 * Clicking a sticky line scrolls to it, the caret where it was clicked.
 */
import { EditorSelection, Facet, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { foldNodeProp, syntaxTree } from "@codemirror/language";
import { highlightTree } from "@lezer/highlight";
import { backendFolds } from "./folding";
import { openideaHighlightStyle } from "./highlight";
import { LINE_INSET } from "./lineInset";

/** Maximum number of sticky lines (Settings › Editor › Code Editing). */
export const stickyMaxLines = Facet.define<number, number>({
  combine: (v) => (v.length ? Math.max(1, Math.min(20, v[0]!)) : 5),
});

/** 1-based header line numbers of scopes that contain `lineNo` and start above it. */
export function enclosingHeaders(state: EditorState, lineNo: number): number[] {
  const doc = state.doc;
  if (lineNo < 1 || lineNo > doc.lines) return [];
  const linePos = doc.line(lineNo).from;
  const headers = new Set<number>();
  const folds = state.field(backendFolds, false);
  if (folds?.length) {
    for (const f of folds) {
      if (f.from >= linePos) break;
      if (f.kind !== "region") continue;
      if (f.to >= linePos) headers.add(doc.lineAt(f.from).number);
    }
  } else {
    const tree = syntaxTree(state);
    for (
      let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(linePos, 1);
      node;
      node = node.parent
    ) {
      if (!node.type.prop(foldNodeProp) && !/Body|Block|ClassBody|Object|Array/.test(node.type.name)) continue;
      const start = doc.lineAt(node.from).number;
      const end = doc.lineAt(node.to).number;
      if (start < lineNo && end > lineNo) headers.add(start);
    }
  }
  return [...headers]
    .filter((n) => n < lineNo)
    .sort((a, b) => a - b)
    .slice(-state.facet(stickyMaxLines));
}

function renderLineContent(state: EditorState, lineNo: number, target: HTMLElement) {
  const line = state.doc.line(lineNo);
  const text = line.text.length > 400 ? line.text.slice(0, 400) : line.text;
  const end = line.from + text.length;
  const tree = syntaxTree(state);
  let pos = line.from;
  const push = (to: number, cls: string) => {
    if (to <= pos) return;
    const s = state.doc.sliceString(pos, to);
    if (cls) {
      const span = document.createElement("span");
      span.className = cls;
      span.textContent = s;
      target.appendChild(span);
    } else target.appendChild(document.createTextNode(s));
    pos = to;
  };
  if (tree.length >= end) {
    highlightTree(
      tree,
      openideaHighlightStyle,
      (from, to, cls) => {
        push(Math.max(from, pos), "");
        push(Math.min(to, end), cls);
      },
      line.from,
      end,
    );
  }
  push(end, "");
}

/** Character offset in a rendered sticky line closest to `clientX`. */
export function offsetAtX(inner: HTMLElement, clientX: number): number {
  const range = document.createRange();
  let offset = 0;
  const walker = document.createTreeWalker(inner, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    for (let i = 0; i < node.length; i++) {
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const r = range.getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return offset + i;
    }
    offset += node.length;
  }
  return offset;
}

/** Selected portions of a sticky line, preserving gaps between selection ranges. */
export function selectedSpans(
  ranges: readonly { from: number; to: number }[],
  from: number,
  to: number,
): { start: number; end: number; pastEnd: boolean }[] {
  const spans: { start: number; end: number; pastEnd: boolean }[] = [];
  for (const r of ranges) {
    if (r.from === r.to || r.to < from || r.from > to || (r.to === from && r.from < from)) continue;
    const start = Math.max(r.from, from) - from;
    const end = Math.min(r.to, to) - from;
    const pastEnd = r.to > to;
    if (end !== start || pastEnd) spans.push({ start, end, pastEnd });
  }
  return spans;
}

/** Client x of the start of character `offset` in a rendered sticky line (its end past the last character). */
function xAtOffset(inner: HTMLElement, offset: number): number {
  const range = document.createRange();
  const walker = document.createTreeWalker(inner, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (offset < node.length) {
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      return range.getBoundingClientRect().left;
    }
    offset -= node.length;
    last = node;
  }
  if (!last) return inner.getBoundingClientRect().left + parseFloat(inner.style.paddingLeft || "0");
  range.selectNodeContents(last);
  return range.getBoundingClientRect().right;
}

class StickyScroll {
  dom: HTMLElement;
  private lines: number[] = [];
  /** Text and syntax tree the rows were rendered from (re-render when either changes). */
  private renderedFrom: { texts: string[]; tree: unknown } | null = null;
  private gutterWidth = 0;
  private numberLeft = 0;
  private scheduled = false;
  private selectionDirty = true;
  private scrollLeft = 0;

  constructor(private view: EditorView) {
    this.dom = document.createElement("div");
    this.dom.className = "cm-openidea-sticky";
    this.dom.style.display = "none";
    this.dom.setAttribute("aria-hidden", "true");
    this.dom.addEventListener("mousedown", this.onMouseDown);
    view.dom.appendChild(this.dom);
    view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
    this.schedule();
  }

  update(u: ViewUpdate) {
    if (u.docChanged || u.selectionSet || u.geometryChanged) this.selectionDirty = true;
    if (
      u.docChanged ||
      u.selectionSet ||
      u.focusChanged ||
      u.viewportChanged ||
      u.geometryChanged ||
      syntaxTree(u.startState) !== syntaxTree(u.state) ||
      u.startState.field(backendFolds, false) !== u.state.field(backendFolds, false)
    )
      this.schedule();
  }

  private onScroll = () => this.schedule();

  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    this.view.requestMeasure({
      key: this,
      read: (view) => {
        this.scheduled = false;
        const scroller = view.scrollDOM;
        const scrollTop = scroller.scrollTop;
        const docOffset = view.documentTop - scroller.getBoundingClientRect().top + scrollTop;
        const lh = view.defaultLineHeight;
        const gutters = view.dom.querySelector<HTMLElement>(".cm-gutters");
        const numbers = view.dom.querySelector<HTMLElement>(".cm-lineNumbers");
        const gutterWidth = gutters?.offsetWidth ?? 0;
        const numberWidth = numbers?.offsetWidth ?? 0;
        // Gutters left of the line numbers (e.g. VCS annotations) shift the number column.
        const numberLeft =
          gutters && numbers
            ? Math.max(0, numbers.getBoundingClientRect().left - gutters.getBoundingClientRect().left)
            : 0;
        if (scrollTop - docOffset <= 0)
          return { lines: [] as number[], gutterWidth, numberWidth, numberLeft, scrollLeft: 0 };
        // n sticky rows cover the first n visible lines; they show the n outermost
        // headers of the first line below them, as long as it has that many.
        const lineBelow = (n: number) => {
          const block = view.lineBlockAtHeight(Math.min(scrollTop - docOffset + n * lh + 1, view.contentHeight - 1));
          return view.state.doc.lineAt(block.from).number;
        };
        let headers: number[] = [];
        for (let n = 1; n <= view.state.facet(stickyMaxLines); n++) {
          const enclosing = enclosingHeaders(view.state, lineBelow(n));
          if (enclosing.length < n) break;
          headers = enclosing.slice(0, n);
        }
        return { lines: headers, gutterWidth, numberWidth, numberLeft, scrollLeft: scroller.scrollLeft };
      },
      write: ({ lines, gutterWidth, numberWidth, numberLeft, scrollLeft }) => {
        const state = this.view.state;
        const texts = lines.map((n) => (n <= state.doc.lines ? state.doc.line(n).text : ""));
        const tree = syntaxTree(state);
        const prev = this.renderedFrom;
        const same =
          lines.length === this.lines.length &&
          lines.every((n, i) => n === this.lines[i]) &&
          !!prev &&
          prev.tree === tree &&
          texts.every((t, i) => t === prev.texts[i]);
        if (!lines.length) {
          this.dom.style.display = "none";
          this.lines = [];
          this.renderedFrom = null;
          return;
        }
        this.dom.style.display = "";
        const rebuild = !same || gutterWidth !== this.gutterWidth || numberLeft !== this.numberLeft;
        if (rebuild) {
          this.lines = lines;
          this.renderedFrom = { texts, tree };
          this.gutterWidth = gutterWidth;
          this.numberLeft = numberLeft;
          const frag = document.createDocumentFragment();
          for (const n of lines) {
            const row = document.createElement("div");
            row.className = "cm-openidea-stickyLine";
            row.dataset.line = String(n);
            const num = document.createElement("span");
            num.className = "cm-openidea-stickyNumber";
            num.style.width = `${numberWidth}px`;
            num.style.marginLeft = `${numberLeft}px`;
            num.style.marginRight = `${Math.max(0, gutterWidth - numberLeft - numberWidth)}px`;
            num.textContent = String(n);
            const text = document.createElement("span");
            text.className = "cm-openidea-stickyText";
            const inner = document.createElement("span");
            inner.className = "cm-openidea-stickyInner";
            inner.style.display = "inline-block";
            inner.style.paddingLeft = `${LINE_INSET}px`;
            renderLineContent(this.view.state, n, inner);
            text.appendChild(inner);
            row.append(num, text);
            frag.appendChild(row);
          }
          this.dom.replaceChildren(frag);
        }
        if (rebuild || scrollLeft !== this.scrollLeft) {
          for (const inner of this.dom.querySelectorAll<HTMLElement>(".cm-openidea-stickyInner"))
            inner.style.transform = scrollLeft ? `translateX(${-scrollLeft}px)` : "";
          this.selectionDirty = true;
        }
        this.scrollLeft = scrollLeft;
        if (this.selectionDirty) {
          this.selectionDirty = false;
          this.paintSelection();
        }
      },
    });
  }

  private paintSelection() {
    this.view.requestMeasure({
      key: this.paintSelection,
      read: () => {
        const state = this.view.state;
        return Array.from(this.dom.querySelectorAll<HTMLElement>(".cm-openidea-stickyLine"), (row) => {
          const text = row.querySelector<HTMLElement>(".cm-openidea-stickyText")!;
          const inner = text.querySelector<HTMLElement>(".cm-openidea-stickyInner")!;
          const line = state.doc.line(Math.min(Number(row.dataset.line), state.doc.lines));
          const spans = selectedSpans(state.selection.ranges, line.from, line.to);
          if (!spans.length) return { text, marks: [] };
          const box = text.getBoundingClientRect();
          const marks = spans.map((span) => {
            const left = Math.max(0, xAtOffset(inner, span.start) - box.left);
            const right = span.pastEnd ? box.width : Math.max(left, xAtOffset(inner, span.end) - box.left);
            return { left, width: right - left };
          });
          return { text, marks };
        });
      },
      write: (rows) => {
        for (const { text, marks } of rows) {
          for (const mark of text.querySelectorAll(".cm-openidea-stickySelection")) mark.remove();
          for (const { left, width } of marks) {
            const mark = document.createElement("span");
            mark.className = "cm-openidea-stickySelection";
            mark.style.left = `${left}px`;
            mark.style.width = `${width}px`;
            text.prepend(mark);
          }
        }
      },
    });
  }

  private onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const row = (e.target as HTMLElement).closest<HTMLElement>(".cm-openidea-stickyLine");
    if (!row?.dataset.line) return;
    e.preventDefault();
    // The line number of a sticky line is not a link (IDEA).
    const inner = (e.target as HTMLElement)
      .closest(".cm-openidea-stickyText")
      ?.querySelector<HTMLElement>(".cm-openidea-stickyInner");
    if (!inner) return;
    const state = this.view.state;
    const line = state.doc.line(Math.min(Number(row.dataset.line), state.doc.lines));
    const offset = offsetAtX(inner, e.clientX);
    const rowIndex = [...this.dom.children].indexOf(row);
    // The line takes the place of its sticky row, so the text stays under the pointer.
    this.view.dispatch({
      selection: EditorSelection.cursor(line.from + Math.min(offset, line.length)),
      effects: EditorView.scrollIntoView(line.from, {
        y: "start",
        yMargin: Math.max(0, rowIndex) * this.view.defaultLineHeight,
      }),
      userEvent: "select.sticky",
    });
    this.view.focus();
  };

  destroy() {
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    this.dom.remove();
  }
}
export const stickyScroll: Extension = ViewPlugin.fromClass(StickyScroll);
