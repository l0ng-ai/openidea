import type { Commit } from "@/bindings";
import { type MenuItem } from "@/ui";
import { type CSSProperties, type ReactNode } from "react";
import { type LogOptions } from "../logOptions";
import { updateLogOptions } from "../logStore";

export const ROW = 26;

export const LANE = 14;

/**
 * Style for the log's split panels. Their panes scroll themselves; the panel's own
 * `overflow: auto` showed a scrollbar for sub-pixel overflow while a split was dragged.
 */
export const PANE_STYLE: CSSProperties = { overflow: "hidden" };

export interface LogColumn {
  id: string;
  title: string;
  width: number;
  render(commit: Commit): ReactNode;
}

// The flexible "Commit" column shares the same order and can be dragged like the rest.
export const SUBJECT_COLUMN: LogColumn = { id: "subject", title: "Commit", width: 0, render: () => "" };

// Until the user drags the commit column somewhere, it leads the row.
export const columnSequence = (columnOrder: string[], builtins: LogColumn[]): string[] => {
  const ids = [...new Set([...columnOrder, ...builtins.map((c) => c.id)])];
  return columnOrder.includes(SUBJECT_COLUMN.id) ? ids : [SUBJECT_COLUMN.id, ...ids];
};

export type RowEvents = {
  onHover: (edge: string | null) => void;
  onFragment: (from: string, target: string, expand: boolean) => void;
  onNavigate: (index: number, key?: string) => void;
};

export const toggle = (label: string, o: LogOptions, key: keyof LogOptions): MenuItem => ({
  label,
  checked: !!o[key],
  run: () => updateLogOptions({ [key]: !o[key] }),
});
