// Reader for `Thread.dump_to_file -format=json`, used for virtual threads, which the text dump omits.

import type { DeadlockLink, DumpThread, ThreadState } from "./parse";

interface JsonThread {
  tid?: unknown;
  name?: unknown;
  virtual?: unknown;
  state?: unknown;
  blockedOn?: unknown;
  waitingOn?: unknown;
  parkBlocker?: { object?: unknown } | null;
  stack?: unknown;
  monitorsOwned?: unknown;
}

interface JsonContainer {
  container?: unknown;
  threads?: unknown;
}

const STATES = new Set<string>(["RUNNABLE", "BLOCKED", "WAITING", "TIMED_WAITING", "NEW", "TERMINATED"]);

// JDK 21 marks no thread as virtual and omits the state, but every virtual thread's stack ends in
// this frame. Carrier threads (ForkJoinPool workers) sit in non-root containers too, so the
// container cannot tell them apart.
const VIRTUAL_BOTTOM_FRAME = /^java\.base\/java\.lang\.VirtualThread\.run\(/;

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function isVirtual(thread: JsonThread, stack: string[]): boolean {
  if (typeof thread.virtual === "boolean") return thread.virtual;
  const bottom = stack[stack.length - 1];
  return bottom !== undefined && VIRTUAL_BOTTOM_FRAME.test(bottom);
}

function toDumpThread(thread: JsonThread, container: string, stack: string[]): DumpThread {
  const tid = typeof thread.tid === "string" || typeof thread.tid === "number" ? Number(thread.tid) : NaN;
  const owned = Array.isArray(thread.monitorsOwned) ? (thread.monitorsOwned as { locks?: unknown }[]) : [];
  const waitsOn = [thread.blockedOn, thread.parkBlocker?.object, thread.waitingOn].find(
    (v): v is string => typeof v === "string",
  );
  return {
    name: typeof thread.name === "string" ? thread.name : "",
    number: Number.isFinite(tid) ? tid : null,
    daemon: true,
    state: typeof thread.state === "string" && STATES.has(thread.state) ? (thread.state as ThreadState) : "UNKNOWN",
    stateDetail: "",
    frames: stack.map((line) => `at ${line}`),
    holds: owned.flatMap((m) => strings(m?.locks)),
    waitsOn: waitsOn ?? null,
    internal: false,
    deadlocked: false,
    container,
  };
}

export function virtualThreads(json: string): DumpThread[] {
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    return [];
  }
  const containers = (root as { threadDump?: { threadContainers?: unknown } } | null)?.threadDump?.threadContainers;
  if (!Array.isArray(containers)) return [];

  const result: DumpThread[] = [];
  for (const entry of containers as JsonContainer[]) {
    if (!Array.isArray(entry?.threads)) continue;
    const container = typeof entry.container === "string" ? entry.container : "";
    for (const thread of entry.threads as JsonThread[]) {
      const stack = strings(thread?.stack);
      if (isVirtual(thread ?? {}, stack)) result.push(toDumpThread(thread, container, stack));
    }
  }
  return result;
}

/** Cycles in the wait-for graph built from monitor ownership; each thread waits on at most one lock. */
export function monitorCycles(threads: DumpThread[]): DeadlockLink[][] {
  const ownerOf = new Map<string, number>();
  threads.forEach((t, i) => {
    for (const lock of t.holds) if (!ownerOf.has(lock)) ownerOf.set(lock, i);
  });

  const next = threads.map((t, i) => {
    const owner = t.waitsOn === null ? undefined : ownerOf.get(t.waitsOn);
    return owner === undefined || owner === i ? -1 : owner;
  });

  const label = (i: number) => {
    const t = threads[i];
    return t?.name || `#${t?.number ?? i}`;
  };

  const done = new Set<number>();
  const cycles: DeadlockLink[][] = [];
  for (let start = 0; start < threads.length; start++) {
    const path: number[] = [];
    let at = start;
    while (at !== -1 && !done.has(at) && !path.includes(at)) {
      path.push(at);
      at = next[at] ?? -1;
    }
    if (at !== -1 && path.includes(at)) {
      const members = path.slice(path.indexOf(at));
      const first = members.indexOf(Math.min(...members));
      const ordered = [...members.slice(first), ...members.slice(0, first)];
      cycles.push(
        ordered.map((i) => ({
          thread: label(i),
          waitsFor: threads[i]?.waitsOn ?? "",
          heldBy: label(next[i] ?? i),
        })),
      );
    }
    for (const i of path) done.add(i);
  }
  return cycles;
}
