import { matchBrackets } from "@codemirror/language";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { tx } from "@/platform/i18n";
import { allmanHeader } from "./folding";
import { LINE_INSET } from "./lineInset";
import { editorLineNumber } from "./relativeLineNumbers";
import { readEditorTopLayout, renderContextLine } from "./stickyScroll";

function matchingScope(view: EditorView) {
  const { state } = view;
  const { empty, head } = state.selection.main;
  if (!view.hasFocus || view.composing || !empty || state.selection.ranges.length !== 1) return null;
  const match =
    matchBrackets(state, head, -1) ??
    (head > 0 ? matchBrackets(state, head - 1, 1) : null) ??
    matchBrackets(state, head, 1) ??
    (head < state.doc.length ? matchBrackets(state, head + 1, -1) : null);
  if (!match?.matched || !match.end || match.end.from >= match.start.from) return null;
  const closing = view.coordsAtPos(match.start.from, 1);
  if (!closing) return null;

  const layout = readEditorTopLayout(view);
  const { viewport } = layout;
  const sticky = view.dom.querySelector<HTMLElement>(".cm-openidea-sticky");
  const stickyHeight = sticky?.offsetHeight ?? 0;
  if (
    closing.top < viewport.top + stickyHeight * view.scaleY ||
    closing.bottom > viewport.bottom ||
    closing.left < viewport.left ||
    closing.right > viewport.right ||
    view.documentTop + view.lineBlockAt(match.end.from).bottom * view.scaleY > viewport.top
  )
    return null;
  const opening = state.doc.lineAt(match.end.from);
  const first = allmanHeader(state, opening).number;
  if (stickyHeight && sticky?.querySelector(`[data-line="${first}"], [data-line="${opening.number}"]`)) return null;
  return { first, last: opening.number, layout, stickyHeight };
}

/** A short source preview when the caret reaches the closing side of an offscreen scope. */
export const scopeContext = ViewPlugin.fromClass(
  class {
    private dom: HTMLDivElement | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private generation = 0;
    private readonly ownerWindow: Window | null;

    constructor(private readonly view: EditorView) {
      this.ownerWindow = view.dom.ownerDocument.defaultView;
      view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
    }

    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.focusChanged) {
        this.dismiss();
        if (u.view.hasFocus && u.state.selection.main.empty) {
          const generation = this.generation;
          this.timer = setTimeout(() => this.show(generation), 300);
        }
      } else if (u.geometryChanged && this.dom) this.dismiss();
    }

    private show(generation: number) {
      this.view.requestMeasure({
        key: this,
        read: matchingScope,
        write: (scope) => {
          if (!scope || generation !== this.generation) return;
          const { first, last, layout, stickyHeight } = scope;
          const { state } = this.view;
          const dom = this.view.dom.ownerDocument.createElement("div");
          dom.className = "cm-openidea-scopeContext";
          dom.setAttribute("role", "tooltip");
          dom.setAttribute("aria-label", tx("Matching scope"));
          dom.style.top = `${layout.top + stickyHeight}px`;
          dom.style.left = `${layout.left}px`;
          dom.style.maxWidth = `${Math.max(0, layout.width - layout.rightInset)}px`;
          dom.style.tabSize = String(state.tabSize);
          for (let line = first; line <= last; line++) {
            const row = dom.ownerDocument.createElement("div");
            row.className = "cm-openidea-scopeLine";
            if (layout.gutterWidth > 0) {
              const gutter = dom.ownerDocument.createElement("span");
              gutter.className = "cm-openidea-stickyGutter";
              gutter.style.width = `${layout.gutterWidth}px`;
              gutter.setAttribute("aria-hidden", "true");
              if (layout.numberWidth > 0) {
                const number = dom.ownerDocument.createElement("span");
                number.className = "cm-openidea-stickyNumber";
                number.style.width = `${layout.numberWidth}px`;
                number.style.marginLeft = `${layout.numberLeft}px`;
                number.textContent = editorLineNumber(state, line);
                gutter.append(number);
              }
              row.append(gutter);
            }
            const code = dom.ownerDocument.createElement("span");
            code.className = "cm-openidea-scopeCode";
            code.style.paddingInlineStart = `${LINE_INSET}px`;
            renderContextLine(state, line, code);
            row.append(code);
            dom.append(row);
          }
          this.dom = dom;
          this.view.dom.append(dom);
          this.ownerWindow?.addEventListener("keydown", this.dismiss, true);
        },
      });
    }

    private onScroll = () => {
      if (this.dom) this.dismiss();
    };

    private dismiss = () => {
      this.generation++;
      clearTimeout(this.timer);
      if (!this.dom) return;
      this.ownerWindow?.removeEventListener("keydown", this.dismiss, true);
      this.dom.remove();
      this.dom = undefined;
    };

    destroy() {
      this.dismiss();
      this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    }
  },
);
