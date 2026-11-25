// A thread dump tab's state: the dump and how the user is looking at it. The tab lives in the
// Run tool window's tab list (`useStackTraces`), so these are plain functions over a tab.
import type { DebugSessionId, JvmThreadDump, RunId, VirtualThreadsNote } from "@/platform/ipc";
import { parseThreadDump, threadLabel, type DumpThread, type ThreadDump, type ThreadState } from "./parse";
import { monitorCycles, virtualThreads } from "./parseJson";

/** Where the dump was taken; `null` for a pasted one, which cannot be taken again. */
export type ThreadDumpSource = { run: RunId; token: string } | { session: DebugSessionId };

/** What a taken dump says about virtual threads; pasted dumps have none. */
export type VirtualSource = Pick<JvmThreadDump, "javaVersion" | "virtualJson" | "virtualNote">;

/** Why virtual threads are missing, or (`noLockOwners`) why their deadlocks cannot be found. */
export type VirtualNote = VirtualThreadsNote | "noLockOwners";

/** A heading row of the thread list. */
export type ThreadSection = { section: "virtual"; count: number } | { section: "container"; name: string };

export type ThreadRow = number | ThreadSection;

export interface ThreadDumpTab {
  kind: "threads";
  id: string;
  title: string;
  text: string;
  /** Virtual threads follow the platform ones and carry `container`. */
  dump: ThreadDump;
  virtualNote: VirtualNote | null;
  source: ThreadDumpSource | null;
  /** Takes a new dump into this tab; set by whoever can take one, and reports its own failures. */
  refresh?: () => Promise<void>;
  /** Index into `dump.threads`: names need not be unique. */
  selected: number | null;
  filter: string;
  hideJvm: boolean;
}

const EMPTY_DUMP: ThreadDump = { header: "", threads: [], deadlocks: [] };

/** First number of `javaVersion` (`21.0.4`, `25`); null when unknown. */
function javaMajor(javaVersion: string): number | null {
  const major = Number.parseInt(javaVersion, 10);
  return Number.isNaN(major) ? null : major;
}

/** Adds the JSON dump's virtual threads and their monitor deadlocks to the text dump. */
function withVirtual(dump: ThreadDump, virtual: VirtualSource | null): { dump: ThreadDump; note: VirtualNote | null } {
  if (!virtual) return { dump, note: null };
  if (virtual.virtualJson === null) return { dump, note: virtual.virtualNote };
  const found = virtualThreads(virtual.virtualJson);
  const cycles = monitorCycles(found);
  const inCycle = new Set(cycles.flatMap((links) => links.map((l) => l.thread)));
  const threads = found.map((t) => ({ ...t, deadlocked: inCycle.has(threadLabel(t)) }));
  // Only JDK 25+ JSON says who holds a lock, so earlier ones can show no virtual deadlock.
  const major = javaMajor(virtual.javaVersion);
  const note = threads.length && major !== null && major < 25 ? "noLockOwners" : null;
  return {
    dump: { ...dump, threads: [...dump.threads, ...threads], deadlocks: [...dump.deadlocks, ...cycles] },
    note,
  };
}

/** Indices of the threads the list shows, in dump order. */
export function visibleThreads(dump: ThreadDump, filter: string, hideJvm: boolean): number[] {
  const needle = filter.trim().toLowerCase();
  const shown: number[] = [];
  dump.threads.forEach((t, i) => {
    if (hideJvm && t.internal) return;
    if (needle && !threadLabel(t).toLowerCase().includes(needle)) return;
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
  parsed: ThreadDump,
  virtual: VirtualSource | null,
): ThreadDumpTab {
  const hideJvm = true;
  const { dump, note } = withVirtual(parsed, virtual);
  return {
    kind: "threads",
    id,
    title,
    text,
    dump,
    virtualNote: note,
    source,
    selected: defaultSelection(dump, hideJvm),
    filter: "",
    hideJvm,
  };
}

/** A new dump in the same tab: the filter, the toggle and the selected thread (by name) stay. */
export function withDumpText(tab: ThreadDumpTab, text: string, virtual: VirtualSource | null): ThreadDumpTab {
  const { dump, note } = withVirtual(parseThreadDump(text) ?? EMPTY_DUMP, virtual);
  const old = tab.selected === null ? undefined : tab.dump.threads[tab.selected];
  const label = old && threadLabel(old);
  const kept = label === undefined ? -1 : dump.threads.findIndex((t) => threadLabel(t) === label);
  return {
    ...tab,
    text,
    dump,
    virtualNote: note,
    selected: kept >= 0 ? kept : defaultSelection(dump, tab.hideJvm),
  };
}

/** The listed threads with a heading over the virtual ones and one over each of their containers. */
export function threadRows(threads: readonly DumpThread[], shown: readonly number[]): ThreadRow[] {
  const platform: ThreadRow[] = [];
  const byContainer = new Map<string, number[]>();
  let count = 0;
  for (const i of shown) {
    const container = threads[i]!.container;
    if (container === undefined) {
      platform.push(i);
      continue;
    }
    count++;
    const group = byContainer.get(container);
    if (group) group.push(i);
    else byContainer.set(container, [i]);
  }
  if (!count) return platform;
  const rows: ThreadRow[] = [...platform, { section: "virtual", count }];
  for (const [name, indices] of byContainer) {
    rows.push({ section: "container", name });
    // No spread: a container can hold more virtual threads than a call takes arguments.
    for (const i of indices) rows.push(i);
  }
  return rows;
}

/** Listed threads per state, in the order states first appear. */
export function stateCounts(threads: readonly DumpThread[], shown: readonly number[]): [ThreadState, number][] {
  const counts = new Map<ThreadState, number>();
  for (const i of shown) {
    const state = threads[i]!.state;
    // The dump gave no state (JVM-native threads, JDK 21 virtual threads): nothing to count.
    if (state === "UNKNOWN") continue;
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return [...counts];
}

/** The selected thread's console text, laid out as in the dump so the frames read the same. */
export function threadStackText(t: DumpThread): string {
  const head = [t.name ? `"${t.name}"` : null, t.number === null ? null : `#${t.number}`, t.daemon ? "daemon" : null]
    .filter(Boolean)
    .join(" ");
  const state =
    t.state === "UNKNOWN" ? [] : [`   java.lang.Thread.State: ${t.state}${t.stateDetail ? ` (${t.stateDetail})` : ""}`];
  return [head, ...state, ...t.frames.map((f) => `\t${f}`)].join("\n");
}
