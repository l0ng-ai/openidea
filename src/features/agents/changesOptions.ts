/** Changes pane view options, persisted across sessions. */
import { create } from "zustand";

/** What the pane lists: the whole task's changes, or the last turn's. */
export type ChangesScope = "task" | "turn";

export interface ChangesOptions {
  /** Files grouped by the commit that changed them; otherwise the flat list since the task started. */
  groupByCommit: boolean;
  scope: ChangesScope;
  /** Width of the pane beside the conversation, in px; `null`: the stylesheet's default. */
  width: number | null;
}

/** IDEA-like default: the review view. */
export const DEFAULT_CHANGES_OPTIONS: ChangesOptions = { groupByCommit: true, scope: "task", width: null };

const MIN_CHANGES_WIDTH = 200;
const MAX_CHANGES_WIDTH = 1600;

export function clampChangesWidth(px: number) {
  return Math.round(Math.min(MAX_CHANGES_WIDTH, Math.max(MIN_CHANGES_WIDTH, px)));
}

const KEY = "openidea.agents.changesView.v1";

function load(): ChangesOptions {
  try {
    const raw = localStorage.getItem(KEY);
    const o = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    return {
      groupByCommit: typeof o.groupByCommit === "boolean" ? o.groupByCommit : DEFAULT_CHANGES_OPTIONS.groupByCommit,
      scope: o.scope === "turn" ? "turn" : DEFAULT_CHANGES_OPTIONS.scope,
      width: typeof o.width === "number" && Number.isFinite(o.width) ? clampChangesWidth(o.width) : null,
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
