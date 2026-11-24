/**
 * View › Recent Changes (⌥⇧C): the project's latest Local History events —
 * labels, system events and saved file revisions — in a popup; choosing one
 * opens its Local History.
 */
import type { HistoryEntry } from "@/bindings";
import { openPopup, type ListPopupItem } from "@/editor/lsp/popupStore";
import { dateFormatOptions, formatDateTime } from "@/platform/dateFormat";
import { call, commands } from "@/platform/ipc";
import { relativePath, useProject } from "@/platform/project";
import { notifications } from "@/workbench/contributions";
import { openLocalHistory } from "./localHistoryKind";
import { errorMessage } from "./ops";

const MAX_ROWS = 40;

/**
 * Newest first; consecutive revisions of one file with the same label collapse
 * into the newest (typing saves often).
 */
export function recentChanges(entries: readonly HistoryEntry[], limit = MAX_ROWS): HistoryEntry[] {
  const sorted = [...entries].sort((a, b) => (b.timestampMs ?? 0) - (a.timestampMs ?? 0));
  const out: HistoryEntry[] = [];
  for (const e of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.kind !== "label" && e.kind !== "label" && prev.path === e.path && prev.label === e.label) continue;
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

export function recentChangeLabel(e: HistoryEntry, root: string): string {
  if (e.kind === "label") return e.label;
  return `${relativePath(root, e.path)}${e.label ? ` — ${e.label}` : ""}`;
}

export async function showRecentChanges() {
  const root = useProject.getState().project?.root;
  if (!root) return;
  let entries: HistoryEntry[];
  try {
    entries = recentChanges((await call(commands.historyListDir(root))).entries);
  } catch (e) {
    notifications().notify({ level: "error", title: "Cannot read Local History", body: errorMessage(e) });
    return;
  }
  const dateFormat = dateFormatOptions();
  const items: ListPopupItem[] = entries.map((e, i) => ({
    id: `${i}`,
    label: recentChangeLabel(e, root),
    leadingDetail: e.timestampMs == null ? "" : formatDateTime(new Date(e.timestampMs), dateFormat),
    icon: e.kind === "label" ? "bookmark" : "history",
    run: () => openLocalHistory(e.kind === "label" ? root : e.path),
  }));
  if (!items.length)
    items.push({ id: "none", label: "No recent changes", disabled: "Local History has no entries yet", run: () => {} });
  openPopup({ kind: "list", anchor: "center", title: "Recent Changes", items });
}
