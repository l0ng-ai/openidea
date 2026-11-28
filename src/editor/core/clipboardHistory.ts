/**
 * In-app clipboard history for Edit › Paste from History (⇧⌘V): text copied
 * or cut in an editor (or elsewhere in the window), newest first, like
 * IDEA's CopyPasteManager.
 */
import { EditorSelection, type EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tx } from "@/platform/i18n";
import { writeClipboardText } from "@/platform/clipboard";
import type { LineClipboardOptions } from "@/platform/editorSettings";
import { dispatchPaste, filterCopiedText, linePasteMode } from "./cm/clipboard";

export const MAX_CLIPBOARD_ENTRIES = 30;

interface ClipboardEntry {
  text: string;
  linewise: boolean;
}

let entries: ClipboardEntry[] = [];

export function clipboardHistory(): readonly ClipboardEntry[] {
  return entries;
}

/** Adds `text` on top; an existing equal entry moves up instead of repeating. */
export function recordClipboard(text: string, linewise = false) {
  if (!text && !linewise) return;
  entries = [{ text, linewise }, ...entries.filter((e) => e.text !== text)].slice(0, MAX_CLIPBOARD_ENTRIES);
}

/** Only the latest copy determines the current clipboard's paste mode. */
export function isLinewiseClipboardText(text: string): boolean {
  return entries[0]?.linewise === true && entries[0].text === text;
}

export function clearClipboardHistory() {
  entries = [];
}

export function removeClipboardEntries(texts: readonly string[]) {
  const removed = new Set(texts);
  entries = entries.filter((e) => !removed.has(e.text));
}

/** Distinct caret lines in document order, keeping the first caret column on each line. */
function distinctCaretLines(state: EditorState) {
  const lines: Array<{ line: ReturnType<EditorState["doc"]["lineAt"]>; pos: number }> = [];
  let last = -1;
  for (const range of state.selection.ranges) {
    const line = state.doc.lineAt(range.head);
    if (line.number === last) continue;
    last = line.number;
    lines.push({ line, pos: range.head });
  }
  return lines;
}

/** What CodeMirror copies: the selections, or the caret lines when nothing is selected. */
export function copiedText(state: EditorState): string {
  const ranges = state.selection.ranges;
  if (ranges.some((r) => !r.empty))
    return filterCopiedText(
      state,
      ranges
        .filter((r) => !r.empty)
        .map((r) => state.sliceDoc(r.from, r.to))
        .join(state.lineBreak),
    );
  const text = distinctCaretLines(state)
    .map(({ line }) => line.text)
    .join(state.lineBreak);
  return filterCopiedText(state, text);
}

/** Label of a history row: first non-blank line, shortened, plus the line count. */
export function clipLabel(text: string, max = 80): { label: string; detail: string | undefined } {
  const lines = text.split(/\r\n?|\n/);
  const first = (lines.find((l) => l.trim()) ?? "").trim();
  const label = first.length > max ? `${first.slice(0, max - 1)}…` : first || tx("(whitespace)");
  const count = /[\r\n]$/.test(text) ? lines.length - 1 : lines.length;
  return { label, detail: count > 1 ? tx`${count} lines` : undefined };
}

function selectCopiedLines(view: EditorView, lines: ReturnType<typeof distinctCaretLines>) {
  const state = view.state;
  const ranges = lines.map(({ line }) => EditorSelection.range(line.from, Math.min(state.doc.length, line.to + 1)));
  const mainLine = state.doc.lineAt(state.selection.main.head).number;
  view.dispatch({
    selection: EditorSelection.create(
      ranges,
      lines.findIndex(({ line }) => line.number === mainLine),
    ),
    userEvent: "select",
    scrollIntoView: true,
  });
}

/** Delete whole caret lines, merging adjacent lines and keeping one caret per surviving position. */
function cutCaretLines(view: EditorView, lines: ReturnType<typeof distinctCaretLines>) {
  const state = view.state;
  const spans: Array<[first: number, last: number]> = [];
  for (const { line } of lines) {
    const last = spans[spans.length - 1];
    if (last && line.number === last[1] + 1) last[1] = line.number;
    else spans.push([line.number, line.number]);
  }
  const changes = state.changes(
    spans.map(([first, last]) => {
      const from = state.doc.line(first).from;
      const to = state.doc.line(last).to;
      return from > 0 ? { from: from - 1, to } : { from, to: Math.min(state.doc.length, to + 1) };
    }),
  );
  const doc = changes.apply(state.doc);
  const mapped = lines.map(({ line, pos }) => {
    const target = doc.lineAt(changes.mapPos(line.from, -1));
    return {
      line: line.number,
      range: EditorSelection.cursor(target.from + Math.min(pos - line.from, target.length)),
    };
  });
  const unique = mapped.filter(({ range }, i) => mapped.findIndex((other) => other.range.head === range.head) === i);
  const mainLine = state.doc.lineAt(state.selection.main.head).number;
  const mainHead = mapped.find((entry) => entry.line === mainLine)!.range.head;
  view.dispatch({
    changes,
    selection: EditorSelection.create(
      unique.map(({ range }) => range),
      unique.findIndex(({ range }) => range.head === mainHead),
    ),
    userEvent: "delete.cut",
    scrollIntoView: true,
  });
}

/** Match CodeMirror's guard: a bubbled copy for a host editor's DOM selection is not ours. */
function selectionInEditor(view: EditorView): boolean {
  const selection = view.contentDOM.ownerDocument.getSelection();
  if (!selection?.anchorNode) return false;
  try {
    const node = selection.anchorNode;
    return view.contentDOM.contains(node.nodeType === 1 ? node : node.parentNode);
  } catch {
    return false;
  }
}

/**
 * Owns no-selection Copy/Cut so CodeMirror's unconditional line-wise handler
 * cannot bypass the settings. Selection copies still fall through to the rich
 * text and native handlers. Native linewise paste is routed through the same
 * history metadata as context-menu and Paste from History operations.
 */
export function clipboardHistoryExtension(options: LineClipboardOptions): Extension {
  const copyOrCut = (event: ClipboardEvent, view: EditorView) => {
    if (!selectionInEditor(view)) return false;
    const state = view.state;
    const linewise = state.selection.ranges.every((range) => range.empty);
    if (linewise && !options.copyLineWhenNoSelection) return true;
    const text = copiedText(state);
    recordClipboard(text, linewise);
    if (!linewise) return false;
    const lines = distinctCaretLines(state);
    if (event.type === "copy" && options.selectCopiedLine) selectCopiedLines(view, lines);
    if (event.type === "cut" && !state.readOnly) cutCaretLines(view, lines);
    if (event.clipboardData) {
      event.clipboardData.clearData();
      event.clipboardData.setData("text/plain", text);
    } else {
      void writeClipboardText(text).catch(() => {});
    }
    return true;
  };
  return [
    linePasteMode.of(options.linePasteMode),
    EditorView.domEventHandlers({
      copy: copyOrCut,
      cut: copyOrCut,
      paste(event, view) {
        const text = event.clipboardData?.getData("text/plain") ?? "";
        if (
          view.state.readOnly ||
          !isLinewiseClipboardText(text) ||
          !view.state.selection.ranges.every((range) => range.empty)
        )
          return false;
        dispatchPaste(view, text);
        return true;
      },
    }),
  ];
}

/** Copies outside editors (inputs, tool windows) go into the history too. */
export function installClipboardTracking(): () => void {
  if (typeof document === "undefined") return () => {};
  const onCopy = (e: Event) => {
    if (e.target instanceof Element && e.target.closest(".cm-editor")) return;
    const t = e.target;
    const text =
      t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement
        ? t.value.slice(t.selectionStart ?? 0, t.selectionEnd ?? 0)
        : (window.getSelection()?.toString() ?? "");
    recordClipboard(text);
  };
  document.addEventListener("copy", onCopy);
  document.addEventListener("cut", onCopy);
  return () => {
    document.removeEventListener("copy", onCopy);
    document.removeEventListener("cut", onCopy);
  };
}
