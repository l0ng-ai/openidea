// A thread dump tab's state: the dump and how the user is looking at it. The tab lives in the
// Run tool window's tab list (`useStackTraces`), so these are plain functions over a tab.
import type { DebugSessionId, RunId } from "@/platform/ipc";
import { parseThreadDump, type DumpThread, type ThreadDump, type ThreadState } from "./parse";

/** Where the dump was taken; `null` for a pasted one, which cannot be taken again. */
export type ThreadDumpSource = { run: RunId; token: string } | { session: DebugSessionId };

export interface ThreadDumpTab {
  kind: "threads";
  id: string;
  title: string;
  text: string;
  dump: ThreadDump;
  source: ThreadDumpSource | null;
  /** Takes a new dump into this tab; set by whoever can take one, and reports its own failures. */
  refresh?: () => Promise<void>;
  /** Index into `dump.threads`: names need not be unique. */
  selected: number | null;
  filter: string;
  hideJvm: boolean;
}

const EMPTY_DUMP: ThreadDump = { header: "", threads: [], deadlocks: [] };

/** Indices of the threads the list shows, in dump order. */
export function visibleThreads(dump: ThreadDump, filter: string, hideJvm: boolean): number[] {
  const needle = filter.trim().toLowerCase();
  const shown: number[] = [];
  dump.threads.forEach((t, i) => {
    if (hideJvm && t.internal) return;
    if (needle && !t.name.toLowerCase().includes(needle)) return;
    shown.push(i);
  });
  return shown;
}

/** First deadlocked thread, else `main`, else the first one listed. */
function defaultSelection(dump: ThreadDump, hideJvm: boolean): number | null {
  const { threads } = dump;
  const deadlocked = threads.findIndex((t) => t.deadlocked);
  if (deadlocked >= 0) return deadlocked;
  const main = threads.findIndex((t) => t.name === "main");
  if (main >= 0) return main;
  return visibleThreads(dump, "", hideJvm)[0] ?? (threads.length ? 0 : null);
}

export function threadDumpTab(
  id: string,
  title: string,
  text: string,
  source: ThreadDumpSource | null,
  dump: ThreadDump,
): ThreadDumpTab {
  const hideJvm = true;
  return {
    kind: "threads",
    id,
    title,
    text,
    dump,
    source,
    selected: defaultSelection(dump, hideJvm),
    filter: "",
    hideJvm,
  };
}

/** A new dump in the same tab: the filter, the toggle and the selected thread (by name) stay. */
export function withDumpText(tab: ThreadDumpTab, text: string): ThreadDumpTab {
  const dump = parseThreadDump(text) ?? EMPTY_DUMP;
  const name = tab.selected === null ? undefined : tab.dump.threads[tab.selected]?.name;
  const kept = name === undefined ? -1 : dump.threads.findIndex((t) => t.name === name);
  return { ...tab, text, dump, selected: kept >= 0 ? kept : defaultSelection(dump, tab.hideJvm) };
}

/** Listed threads per state, in the order states first appear. */
export function stateCounts(threads: readonly DumpThread[], shown: readonly number[]): [ThreadState, number][] {
  const counts = new Map<ThreadState, number>();
  for (const i of shown) {
    const state = threads[i]!.state;
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return [...counts];
}

/** The selected thread's console text, laid out as in the dump so the frames read the same. */
export function threadStackText(t: DumpThread): string {
  const head = [`"${t.name}"`, t.number === null ? null : `#${t.number}`, t.daemon ? "daemon" : null]
    .filter(Boolean)
    .join(" ");
  const state =
    t.state === "UNKNOWN" ? [] : [`   java.lang.Thread.State: ${t.state}${t.stateDetail ? ` (${t.stateDetail})` : ""}`];
  return [head, ...state, ...t.frames.map((f) => `\t${f}`)].join("\n");
}
