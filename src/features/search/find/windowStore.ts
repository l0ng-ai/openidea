/**
 * Find tool window results ("Open in Find Window"), one tab per search. As in
 * IDEA a new search replaces the selected tab unless that tab is pinned.
 */
import { create } from "zustand";
import { call, commands, nextRequestId, type SearchQuery } from "@/platform/ipc";
import type { FindResultsSource } from "@/workbench/contributions";
import type { MenuItem } from "@/ui";
import { loadJson, saveJson } from "../common/open";
import { maybeToolWindowService } from "../common/services";
import { cancelRequest, streamSearch } from "../common/textSearch";
import { FindSession, IDLE, countFileMatches, type FindDeps, type FindState } from "./session";

export interface FindTab {
  id: number;
  title: string;
  query: SearchQuery;
  replacement: string | null;
  /** Replace keeps the case of each occurrence. */
  preserveCase?: boolean;
  /** Kept when a new search runs (Pin Tab). */
  pinned?: boolean;
  state: FindState;
  /** In-file results reveal their line on selection while keeping focus in the tree. */
  editorResults?: boolean;
}

interface FindWindowState {
  tabs: FindTab[];
  active: number | null;
}

export const useFindWindow = create<FindWindowState>(() => ({ tabs: [], active: null }));

export function ipcFindDeps(): FindDeps {
  return {
    validate: (q) => call(commands.searchValidate(q)).then(() => undefined),
    start: streamSearch,
    cancel: cancelRequest,
    nextRequestId,
  };
}

const sessions = new Map<number, FindSession>();
let nextTab = 1;
const MAX_TABS = 8;

function patchTab(id: number, patch: Partial<FindTab>) {
  useFindWindow.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
}

export function openInFindWindow(
  query: SearchQuery,
  title: string,
  replacement: string | null = null,
  deps = ipcFindDeps(),
  preserveCase = false,
) {
  const id = nextTab++;
  const session = new FindSession(deps, (state) => patchTab(id, { state }));
  sessions.set(id, session);
  useFindWindow.setState((s) => {
    const tab: FindTab = { id, title, query, replacement, preserveCase, state: IDLE };
    const reused = s.tabs.find((t) => t.id === s.active && !t.pinned);
    if (reused) {
      sessions.get(reused.id)?.dispose();
      sessions.delete(reused.id);
    }
    let tabs = reused ? s.tabs.map((t) => (t === reused ? tab : t)) : [...s.tabs, tab];
    while (tabs.length > MAX_TABS) {
      const old = tabs[0]!;
      sessions.get(old.id)?.dispose();
      sessions.delete(old.id);
      tabs = tabs.slice(1);
    }
    return { tabs, active: id };
  });
  void session.search(query);
  maybeToolWindowService()?.show("find", true);
  return id;
}

/** Use the normal Find session/tab lifecycle for live editor results. */
export function openEditorResults(source: FindResultsSource) {
  const id = openInFindWindow(source.query, source.title, null, {
    validate: async () => {},
    nextRequestId,
    cancel: () => {},
    start: async (_request, _query, onFile) => {
      const file = source.read();
      const matches = countFileMatches(file);
      if (matches) onFile(file);
      return { files: matches ? 1 : 0, matches, limitHit: false, cancelled: false, elapsedMs: 0 };
    },
  });
  patchTab(id, { editorResults: true });
  return id;
}

export function pinFindTab(id: number, pinned: boolean) {
  patchTab(id, { pinned });
}

/** Rerun of the selected tab (⌘R in the Find tool window). */
export function rerunActiveFindTab() {
  const s = useFindWindow.getState();
  const id = s.active ?? s.tabs.at(-1)?.id;
  if (id != null) rerunFindTab(id);
}

export function rerunFindTab(id: number) {
  const tab = useFindWindow.getState().tabs.find((t) => t.id === id);
  if (tab) void sessions.get(id)?.search(tab.query);
}

export function stopFindTab(id: number) {
  sessions.get(id)?.cancel();
}

export function closeFindTab(id: number) {
  sessions.get(id)?.dispose();
  sessions.delete(id);
  useFindWindow.setState((s) => {
    const i = s.tabs.findIndex((t) => t.id === id);
    const tabs = s.tabs.filter((t) => t.id !== id);
    const active = s.active === id ? (tabs[Math.min(i, tabs.length - 1)]?.id ?? null) : s.active;
    return { tabs, active };
  });
}

export function disposeFindWindow() {
  sessions.forEach((s) => s.dispose());
  sessions.clear();
  useFindWindow.setState({ tabs: [], active: null });
}

// ---------------------------------------------------------------------------
// View options (persisted), in the tool window's ⋮ menu.

const OPTIONS_KEY = "openidea.find.view.v1";

export interface FindViewOptions {
  /** Code preview beside the results (IDEA: on). */
  preview: boolean;
  /** Group files by directory; off lists files flat (IDEA's default). */
  groupByDirectory: boolean;
}

export const useFindViewOptions = create<FindViewOptions>(() => ({
  preview: true,
  groupByDirectory: false,
  ...loadJson<Partial<FindViewOptions>>(OPTIONS_KEY, {}),
}));

useFindViewOptions.subscribe((s) =>
  saveJson(OPTIONS_KEY, { preview: s.preview, groupByDirectory: s.groupByDirectory }),
);

/** The Find tool window's ⋮ menu entries. */
export function useFindHeaderMenu(): MenuItem[] {
  const options = useFindViewOptions();
  return [
    { kind: "header", label: "Group By" },
    {
      id: "groupByDirectory",
      label: "Directory",
      checked: options.groupByDirectory,
      run: () => useFindViewOptions.setState({ groupByDirectory: !options.groupByDirectory }),
    },
    { kind: "separator" },
    {
      id: "preview",
      label: "Preview Source",
      checked: options.preview,
      run: () => useFindViewOptions.setState({ preview: !options.preview }),
    },
  ];
}
