import type { Commit } from "@/bindings";
import { type MenuItem } from "@/ui";
import { type ReactNode } from "react";
import { type LogOptions } from "../logOptions";
import { updateLogOptions } from "../logStore";

export const ROW = 26;

export const LANE = 14;

export interface LogColumn {
  id: string;
  title: string;
  width: number;
  render(commit: Commit): ReactNode;
}

// The flexible "Commit" column shares the same order and can be dragged like the rest.
export const SUBJECT_COLUMN: LogColumn = { id: "subject", title: "Commit", width: 0, render: () => "" };

// Repositories only differ in multi-root logs; until then the column stays first,
// leading the row like IDEA's Repository column.
export const REPOSITORY_COLUMN: LogColumn = { id: "repository", title: "Repository", width: 100, render: () => "" };

export const columnSequence = (columnOrder: string[], builtins: LogColumn[]): string[] => {
  // Keep saved ids (even hidden/unknown ones) so a drag never drops them.
  const ids = [...new Set([...columnOrder, ...builtins.map((c) => c.id)])];
  // Repository leads by default like IDEA, and Commit follows it — until the user
  // drags either to an explicit place in columnOrder.
  const leading: string[] = [];
  if (builtins.some((c) => c.id === REPOSITORY_COLUMN.id) && !columnOrder.includes(REPOSITORY_COLUMN.id))
    leading.push(REPOSITORY_COLUMN.id);
  if (!columnOrder.includes(SUBJECT_COLUMN.id)) leading.push(SUBJECT_COLUMN.id);
  return [...leading, ...ids.filter((id) => !leading.includes(id))];
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
