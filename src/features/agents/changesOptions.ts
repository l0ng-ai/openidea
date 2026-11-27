/** Changes tab view options, persisted across sessions. */
import { create } from "zustand";

/** What the tab lists: the whole task's changes, or the last turn's. */
export type ChangesScope = "task" | "turn";

export interface ChangesOptions {
  /** Files grouped by the commit that changed them; otherwise the flat list since the task started. */
  groupByCommit: boolean;
  scope: ChangesScope;
}

/** IDEA-like default: the review view. */
export const DEFAULT_CHANGES_OPTIONS: ChangesOptions = { groupByCommit: true, scope: "task" };

const KEY = "openidea.agents.changesView.v1";

function load(): ChangesOptions {
  try {
    const raw = localStorage.getItem(KEY);
    const o = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    return {
      groupByCommit: typeof o.groupByCommit === "boolean" ? o.groupByCommit : DEFAULT_CHANGES_OPTIONS.groupByCommit,
      scope: o.scope === "turn" ? "turn" : DEFAULT_CHANGES_OPTIONS.scope,
    };
  } catch {
    return { ...DEFAULT_CHANGES_OPTIONS };
  }
}

export const useChangesOptions = create<ChangesOptions>(() => load());

/** Updates the options and persists them. */
export function setChangesOptions(patch: Partial<ChangesOptions>) {
  useChangesOptions.setState(patch);
  try {
    localStorage.setItem(KEY, JSON.stringify(useChangesOptions.getState()));
  } catch {
    // Storage unavailable: the options last for this session.
  }
}
