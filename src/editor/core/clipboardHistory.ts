/**
 * In-app clipboard history for Edit › Paste from History (⇧⌘V): text copied
 * or cut in an editor (or elsewhere in the window), newest first, like
 * IDEA's CopyPasteManager.
 */
import { EditorView } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { tx } from "@/platform/i18n";
import { filterCopiedText } from "./cm/clipboard";

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
  const lines: string[] = [];
  let last = -1;
  for (const r of ranges) {
    const line = state.doc.lineAt(r.head);
    if (line.number === last) continue;
    last = line.number;
    lines.push(line.text);
  }
  return lines.join(state.lineBreak);
}

/** Label of a history row: first non-blank line, shortened, plus the line count. */
export function clipLabel(text: string, max = 80): { label: string; detail: string | undefined } {
  const lines = text.split(/\r\n?|\n/);
  const first = (lines.find((l) => l.trim()) ?? "").trim();
  const label = first.length > max ? `${first.slice(0, max - 1)}…` : first || tx("(whitespace)");
  const count = /[\r\n]$/.test(text) ? lines.length - 1 : lines.length;
  return { label, detail: count > 1 ? tx`${count} lines` : undefined };
}

function recordEditorClipboard(_e: Event, view: EditorView) {
  recordClipboard(
    copiedText(view.state),
    view.state.selection.ranges.every((r) => r.empty),
  );
}

export const clipboardHistoryExtension = EditorView.domEventHandlers({
  copy: recordEditorClipboard,
  cut: recordEditorClipboard,
});

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
