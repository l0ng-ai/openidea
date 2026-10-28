/**
 * Content tabs of the Commit and Git tool windows. With the non-modal commit interface
 * the Commit window has Commit | Shelf | Stash; with the modal one (no Commit window)
 * the Git window takes them as Local Changes | Shelf | Stash, before Log | Console |
 * Worktrees. "Combine stashes and shelves" makes Shelf and Stash one tab.
 */
import { tx } from "@/platform/i18n";
import type { CommitTab } from "./commitStore";
import type { LogTab } from "./logStore";
import { baseName } from "./model";

export interface ContentTab {
  id: string;
  label: string;
  closable?: boolean;
  /** Count shown after the label (shelves / stashes). */
  count?: number;
}

export interface StashTabsInput {
  combine: boolean;
  shelfCount: number;
  stashCount: number;
  /** The selected tab: an empty Shelf tab stays while it is shown. */
  tab: string;
}

/** The tab a Shelf / Stash request lands on (the combined one when they are combined). */
export function stashTabOf(tab: CommitTab, combine: boolean): CommitTab {
  return combine && tab === "shelf" ? "stashes" : tab;
}

/** Shelf and Stash tabs (Shelf only when there are shelves), or the combined one. */
export function stashTabs({ combine, shelfCount, stashCount, tab }: StashTabsInput): ContentTab[] {
  if (combine) return [{ id: "stashes", label: "Stashes and Shelves", count: stashCount + shelfCount || undefined }];
  return [
    ...(shelfCount || tab === "shelf" ? [{ id: "shelf", label: "Shelf", count: shelfCount || undefined }] : []),
    { id: "stashes", label: "Stash", count: stashCount || undefined },
  ];
}

/** Title of a log tab of its own. */
export function logTabLabel(t: LogTab): string {
  return t.kind === "history" ? tx`History: ${baseName(t.target)}` : tx`Log: ${t.target}`;
}

export interface GitTabsInput extends StashTabsInput {
  /** Modal commit interface: the Git window also shows the local changes, shelves and stashes. */
  modal: boolean;
  logTabs: readonly LogTab[];
}

export function gitTabs(input: GitTabsInput): ContentTab[] {
  return [
    ...(input.modal ? [{ id: "changes", label: "Local Changes" }, ...stashTabs(input)] : []),
    { id: "log", label: "Log" },
    ...input.logTabs.map((t) => ({ id: t.id, label: logTabLabel(t), closable: true })),
    { id: "console", label: "Console" },
    { id: "worktrees", label: "Worktrees" },
  ];
}

/** The tab shown for `tab`: a tab no longer listed (the commit interface changed) falls back to the Log. */
export function shownTab(tab: string, tabs: readonly ContentTab[], combine: boolean): string {
  const id = combine && tab === "shelf" ? "stashes" : tab;
  return tabs.some((t) => t.id === id) ? id : "log";
}
