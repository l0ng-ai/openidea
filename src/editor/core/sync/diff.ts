import { diff } from "@codemirror/merge";
import type { TextChange } from "@/platform/ipc";

/**
 * The changes turning `a` into `b`, one per changed region; empty when equal. Used for resyncs:
 * a single change spanning two distant edits would drag the caret and view to the first one.
 * The timeout keeps a huge file from stalling the UI; past it the regions only get coarser.
 */
export function minimalChanges(a: string, b: string): TextChange[] {
  return diff(a, b, { timeout: 50 }).map((c) => ({ from: c.fromA, to: c.toA, insert: b.slice(c.fromB, c.toB) }));
}
