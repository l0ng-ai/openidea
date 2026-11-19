/** Hover actions of the open editors, for the editor context menu. */
import type { HoverAction } from "@/platform/ipc";

export type HoverActionEntry = { plugin: string; action: HoverAction };

const byDoc = new Map<number, readonly HoverActionEntry[]>();

export function setHoverActions(doc: number, entries: readonly HoverActionEntry[]) {
  if (entries.length) byDoc.set(doc, entries);
  else byDoc.delete(doc);
}

/** Actions whose line range holds `line` (0-based), in provider order. */
export function hoverActionsAt(doc: number, line: number): readonly HoverActionEntry[] {
  return (byDoc.get(doc) ?? []).filter(({ action }) => action.startLine <= line && line <= action.endLine);
}
