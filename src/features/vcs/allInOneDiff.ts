/**
 * All-in-one diff: every file of a change (a commit, the local changes, a comparison) in
 * one scrollable editor tab instead of one tab per file. The diff viewer's settings menu
 * switches it on (Show All Files in One Diff View); diffs of a chain then open this way.
 */
import type { DiffData } from "./diffInput";

export const COMBINED_DIFF_KIND = "combined-diff";

export interface CombinedDiffData {
  /** The files, each with its own sides (no chain of their own). */
  items: DiffData[];
  /** Path of the file to scroll to when the tab opens. */
  reveal?: string;
  title?: string;
}

const KEY = "openidea.diff.allInOne";

/** Whether diffs of several files open as one all-in-one diff (off by default). */
export function allInOneDiff(): boolean {
  try {
    return localStorage.getItem(KEY) === "true";
  } catch {
    return false;
  }
}

export function setAllInOneDiff(on: boolean) {
  try {
    localStorage.setItem(KEY, String(on));
  } catch {
    // Without storage the choice lasts for this tab only.
  }
}

/** The chain of `data` as an all-in-one diff, when that view is on and the chain has several files. */
export function combinedOf(data: DiffData): CombinedDiffData | null {
  if (data.embedded || !data.chain || data.chain.length < 2 || !allInOneDiff()) return null;
  return { items: data.chain, reveal: data.path };
}
