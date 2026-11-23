import { getChunks, getOriginalDoc } from "@codemirror/merge";
import type { EditorState, Extension, Text } from "@codemirror/state";
import { gutter, ViewPlugin, type EditorView } from "@codemirror/view";
import { LineNumber, maxLineNumber } from "./cm";
import { getDiffLineChanges } from "./diffOptions";

const originalGutter = "cm-diffNumbers-original";
const modifiedGutter = "cm-diffNumbers-modified";

interface WidgetNumbers {
  gutter: HTMLElement;
  rows: { number: string; top: number }[];
}

function lastStartingBefore<T>(items: readonly T[], at: number, start: (item: T) => number): T | undefined {
  let from = 0;
  let to = items.length;
  while (from < to) {
    const mid = (from + to) >>> 1;
    if (start(items[mid]!) <= at) from = mid + 1;
    else to = mid;
  }
  return items[from - 1];
}

// Merge chunk endpoints may sit after the last line, including at EOF without a final newline.
function boundaryLine(doc: Text, offset: number) {
  if (offset > doc.length) return doc.lines + 1;
  const line = doc.lineAt(offset);
  return offset === line.from ? line.number : line.number + 1;
}

function matchingLine(state: EditorState, pos: number, number: number): number | null {
  const chunks = getChunks(state)?.chunks ?? [];
  const changes = getDiffLineChanges(chunks);
  if (changes) {
    // Fragment ranges are zero-based and half-open.
    const change = lastStartingBefore(changes, number - 1, (item) => item.startLine2);
    return !change ? number : number <= change.endLine2 ? null : number + change.endLine1 - change.endLine2;
  }
  const chunk = lastStartingBefore(chunks, pos, (item) => item.fromB);
  if (!chunk) return number;
  if (pos < chunk.toB) return null;
  return number + boundaryLine(getOriginalDoc(state), chunk.toA) - boundaryLine(state.doc, chunk.toB);
}

const sourceChanged = (a: EditorState, b: EditorState) =>
  getChunks(a)?.chunks !== getChunks(b)?.chunks || getOriginalDoc(a) !== getOriginalDoc(b);

function numbers(className: string, main: boolean): Extension {
  const spacer = (view: EditorView) =>
    String(maxLineNumber((main ? view.state.doc : getOriginalDoc(view.state)).lines));
  return gutter({
    class: `cm-diffNumbers ${className}`,
    renderEmptyElements: false,
    lineMarker: ({ state }, line) => {
      const number = state.doc.lineAt(line.from).number;
      const value = main ? number : matchingLine(state, line.from, number);
      return value === null ? null : new LineNumber(String(value));
    },
    lineMarkerChange: (update) => sourceChanged(update.startState, update.state),
    initialSpacer: (view) => new LineNumber(spacer(view)),
    updateSpacer: (previous, { view }) => {
      const value = spacer(view);
      return (previous as LineNumber).number === value ? previous : new LineNumber(value);
    },
  });
}

/** Mirror the rendered widget rows into the sticky gutter, including their wrapped line heights. */
function widgetNumbers(onLeft: boolean): Extension {
  return ViewPlugin.define(
    (view) => {
      const layer = view.dom.ownerDocument.createElement("div");
      layer.className = "cm-diffWidgetNumbers";
      const selector = `.${onLeft ? modifiedGutter : originalGutter}`;
      const measure = {
        key: layer,
        read(): WidgetNumbers | null {
          const gutter = view.dom.querySelector<HTMLElement>(selector);
          if (!gutter) return null;
          const top = gutter.getBoundingClientRect().top;
          const scale = view.scaleY;
          const rows: { number: string; top: number }[] = [];
          const scroll = view.scrollDOM.getBoundingClientRect();
          const fromY = Math.max(0, scroll.top) - view.defaultLineHeight * 2;
          const toY =
            Math.min(view.dom.ownerDocument.defaultView!.innerHeight, scroll.bottom) + view.defaultLineHeight * 2;
          const original = getOriginalDoc(view.state);
          const chunks = getChunks(view.state)?.chunks ?? [];
          const widgetSelector = onLeft ? ".cm-unifiedWorkingChunk" : ".cm-deletedChunk";
          for (const widget of view.contentDOM.querySelectorAll<HTMLElement>(widgetSelector)) {
            const block = widget.getBoundingClientRect();
            if (block.bottom < fromY || block.top > toY) continue;
            const children = widget.children;
            const offset = widget.firstElementChild?.classList.contains("cm-chunkButtons") ? 1 : 0;
            let first: number;
            if (onLeft) {
              first = Number(widget.dataset.diffFirstLine);
            } else {
              const pos = view.posAtDOM(widget);
              const chunk = lastStartingBefore(chunks, pos, (item) => item.fromB);
              if (!chunk || chunk.fromB !== pos) continue;
              first = original.lineAt(chunk.fromA).number;
            }
            // A single block widget can contain thousands of lines. Measure only the part near the viewport.
            let from = offset;
            let to = children.length;
            while (from < to) {
              const mid = (from + to) >>> 1;
              if (children[mid]!.getBoundingClientRect().bottom < fromY) from = mid + 1;
              else to = mid;
            }
            for (let i = from; i < children.length; i++) {
              const rect = children[i]!.getBoundingClientRect();
              if (rect.top > toY) break;
              rows.push({ number: String(first + i - offset), top: (rect.top - top) / scale });
            }
          }
          return { gutter, rows };
        },
        write(result: WidgetNumbers | null) {
          if (!result) return;
          const owner = layer.ownerDocument;
          layer.replaceChildren(
            ...result.rows.map(({ number, top }) => {
              const row = owner.createElement("div");
              row.className = "cm-diffWidgetNumber";
              row.textContent = number;
              row.style.top = `${top}px`;
              return row;
            }),
          );
          if (layer.parentElement !== result.gutter) result.gutter.appendChild(layer);
        },
      };
      const schedule = () => view.requestMeasure(measure);
      schedule();
      return {
        schedule,
        docViewUpdate: schedule,
        update(update) {
          if (update.geometryChanged || sourceChanged(update.startState, update.state)) schedule();
        },
        destroy() {
          layer.remove();
        },
      };
    },
    {
      eventObservers: {
        scroll() {
          this.schedule();
        },
      },
    },
  );
}

export function unifiedLineNumbers(onLeft: boolean): Extension {
  return [numbers(originalGutter, onLeft), numbers(modifiedGutter, !onLeft), widgetNumbers(onLeft)];
}
