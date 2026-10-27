/**
 * Read-only text the user can select and copy, like IDEA's Markdown preview,
 * Quick Documentation and message panes. The workbench body is unselectable
 * (chrome); content opts back in with `selectableText`. A right-click on a
 * selection, or anywhere in such content, offers Copy (`copyMenuFor`).
 */
import { formatBinding } from "@/platform/keymap";
import type { MenuItem } from "./Menu";
import styles from "./SelectableText.module.css";

export const selectableText = styles.selectable!;

const EDITABLE = "input, textarea, [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']";

function selectionCovers(sel: Selection | null, target: Node): boolean {
  if (!sel || sel.isCollapsed || !sel.toString()) return false;
  for (let i = 0; i < sel.rangeCount; i++) {
    const range = sel.getRangeAt(i);
    if (range.intersectsNode(target) || target.contains(range.commonAncestorContainer)) return true;
  }
  return false;
}

/** The Copy menu for a right-click on `target`, or null when it is not on readable text. */
export function copyMenuFor(target: EventTarget | null): MenuItem[] | null {
  const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (!el || el.closest(EDITABLE)) return null;
  const sel = window.getSelection();
  const text = selectionCovers(sel, el) ? sel!.toString() : "";
  if (!text && !el.closest(`.${selectableText}`)) return null;
  return [
    {
      id: "copy",
      label: "Copy",
      icon: "copy",
      shortcut: formatBinding("Meta+C"),
      disabled: !text,
      run: () => void copyText(text),
    },
  ];
}

/** Writes `text` to the clipboard; falls back to copying the live selection. */
export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Clipboard API refused (permissions): the selection is still there.
  }
  document.execCommand("copy");
}
