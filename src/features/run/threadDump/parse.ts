// Parser for HotSpot `Thread.print` / jstack text. Tolerates a leading "<pid>:" line, prompt
// noise and CRLF, because users paste dumps from arbitrary terminals.

export type ThreadState = "RUNNABLE" | "BLOCKED" | "WAITING" | "TIMED_WAITING" | "NEW" | "TERMINATED" | "UNKNOWN";

export interface DumpThread {
  name: string;
  number: number | null;
  daemon: boolean;
  state: ThreadState;
  stateDetail: string;
  /** Raw `at …` / `- …` lines, left-trimmed, so the console's link parser can read them. */
  frames: string[];
  /** Monitors and ownable synchronizers, formatted as `<type> <<address>>`. */
  holds: string[];
  /** The lock the thread is blocked on or parked for, in the same format as `holds`. */
  waitsOn: string | null;
  internal: boolean;
  deadlocked: boolean;
  /** Thread container of a JSON dump (virtual threads only); absent in text dumps. */
  container?: string;
}

/** A thread's name in the UI: virtual threads are unnamed by default, so they go by `#<tid>`. */
export function threadLabel(t: Pick<DumpThread, "name" | "number">): string {
  return t.name || (t.number === null ? "" : `#${t.number}`);
}

export interface DeadlockLink {
  thread: string;
  waitsFor: string;
  heldBy: string;
}

export interface ThreadDump {
  header: string;
  threads: DumpThread[];
  deadlocks: DeadlockLink[][];
}

// Only real thread headers carry tid/nid; the deadlock report's `"name":` lines do not.
const THREAD_HEADER_SOURCE = String.raw`^"(.*)"\s+(.*\b(?:tid|nid)=.*)$`;
const THREAD_HEADER = new RegExp(THREAD_HEADER_SOURCE);
const THREAD_HEADER_ANYWHERE = new RegExp(THREAD_HEADER_SOURCE, "m");

const STATE_LINE = /^java\.lang\.Thread\.State:\s*([A-Z_]+)(?:\s*\((.*)\))?/;
const FRAME_LINE = /^(?:at |- )/;
const LOCK_LINE =
  /^-\s+(waiting to lock|waiting on|parking to wait for|waiting to re-lock in wait\(\)|locked)\s+<(0x[0-9a-f]+)>\s+\((?:an? )?(.+)\)\s*$/;
const OWNABLE_LINE = /^-\s+<(0x[0-9a-f]+)>\s+\((?:an? )?(.+)\)\s*$/;
const OWNABLE_HEADING = /^Locked ownable synchronizers:/;

const DEADLOCK_START = /^Found one Java-level deadlock:/;
const DEADLOCK_STACKS = /^Java stack information for the threads listed above:/;
const DEADLOCK_THREAD = /^"(.*)":\s*$/;
const DEADLOCK_MONITOR = /^waiting to lock monitor 0x[0-9a-f]+ \(object (0x[0-9a-f]+), (?:an? )?(.+?)\),?$/;
const DEADLOCK_OWNABLE = /^waiting for ownable synchronizer (0x[0-9a-f]+), \((?:an? )?(.+?)\),?$/;
const DEADLOCK_HELD_BY = /^which is held by "(.*)"\s*$/;

const STATES = new Set<string>(["RUNNABLE", "BLOCKED", "WAITING", "TIMED_WAITING", "NEW", "TERMINATED"]);

// JVM-owned threads that still get a `#n` id in the dump; native ones (VM Thread, GC workers)
// have none and are caught by the missing number.
const INTERNAL_NAMES = new Set([
  "Reference Handler",
  "Finalizer",
  "Signal Dispatcher",
  "Attach Listener",
  "Common-Cleaner",
  "Notification Thread",
  "Service Thread",
  "Monitor Deflation Thread",
  "Sweeper thread",
]);
const INTERNAL_PATTERN = /^(?:C[12] CompilerThread|G1 |GC Thread|VM Thread|VM Periodic Task Thread|ZGC |Shenandoah )/;

function lockLabel(type: string, address: string): string {
  return `${type} <${address}>`;
}

function isInternal(name: string, number: number | null): boolean {
  return number === null || INTERNAL_NAMES.has(name) || INTERNAL_PATTERN.test(name);
}

function newThread(name: string, attrs: string): DumpThread {
  const number = /^#(\d+)\b/.exec(attrs)?.[1];
  const prioAt = attrs.search(/(?:^|\s)prio=/);
  const flags = prioAt < 0 ? attrs : attrs.slice(0, prioAt);
  const parsedNumber = number === undefined ? null : Number(number);
  return {
    name,
    number: parsedNumber,
    daemon: /\bdaemon\b/.test(flags),
    state: "UNKNOWN",
    stateDetail: "",
    frames: [],
    holds: [],
    waitsOn: null,
    internal: isInternal(name, parsedNumber),
    deadlocked: false,
  };
}

function applyStackLine(thread: DumpThread, line: string): void {
  thread.frames.push(line);
  const lock = LOCK_LINE.exec(line);
  if (!lock) return;
  const label = lockLabel(lock[3] ?? "", lock[2] ?? "");
  if (lock[1] === "locked") thread.holds.push(label);
  else thread.waitsOn ??= label;
}

function deadlockWaitsFor(line: string): string | null {
  const monitor = DEADLOCK_MONITOR.exec(line);
  if (monitor) return lockLabel(monitor[2] ?? "", monitor[1] ?? "");
  const ownable = DEADLOCK_OWNABLE.exec(line);
  if (ownable) return lockLabel(ownable[2] ?? "", ownable[1] ?? "");
  return line.startsWith("waiting") ? line.replace(/,$/, "") : null;
}

export function isThreadDump(text: string): boolean {
  return THREAD_HEADER_ANYWHERE.test(text);
}

export function parseThreadDump(text: string): ThreadDump | null {
  const threads: DumpThread[] = [];
  const deadlocks: DeadlockLink[][] = [];
  let header = "";
  let current: DumpThread | null = null;
  let inOwnable = false;
  // Threads are listed first; once the deadlock report starts, `"name":` lines and `at` lines
  // describe the same threads again and must not be read as new ones.
  let section: "threads" | "links" | "stacks" = "threads";
  let cycle: DeadlockLink[] | null = null;
  let linkThread = "";
  let linkWaitsFor = "";

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    const trimmed = line.trimStart();

    if (DEADLOCK_START.test(trimmed)) {
      section = "links";
      current = null;
      cycle = [];
      deadlocks.push(cycle);
      linkThread = "";
      linkWaitsFor = "";
      continue;
    }

    if (section === "threads") {
      if (!header && trimmed.startsWith("Full thread dump")) {
        header = trimmed;
        continue;
      }
      const start = THREAD_HEADER.exec(line);
      if (start) {
        current = newThread(start[1] ?? "", start[2] ?? "");
        threads.push(current);
        inOwnable = false;
        continue;
      }
      if (!current) continue;
      const state = STATE_LINE.exec(trimmed);
      if (state) {
        const name = state[1] ?? "";
        current.state = STATES.has(name) ? (name as ThreadState) : "UNKNOWN";
        current.stateDetail = state[2] ?? "";
      } else if (OWNABLE_HEADING.test(trimmed)) {
        inOwnable = true;
      } else if (inOwnable) {
        const ownable = OWNABLE_LINE.exec(trimmed);
        if (ownable) current.holds.push(lockLabel(ownable[2] ?? "", ownable[1] ?? ""));
      } else if (FRAME_LINE.test(trimmed)) {
        applyStackLine(current, trimmed);
      }
      continue;
    }

    if (DEADLOCK_STACKS.test(trimmed)) {
      section = "stacks";
      continue;
    }
    if (section !== "links" || !cycle) continue;

    const owner = DEADLOCK_THREAD.exec(trimmed);
    if (owner) {
      linkThread = owner[1] ?? "";
      linkWaitsFor = "";
      continue;
    }
    const waitsFor = deadlockWaitsFor(trimmed);
    if (waitsFor !== null) {
      linkWaitsFor = waitsFor;
      continue;
    }
    const heldBy = DEADLOCK_HELD_BY.exec(trimmed);
    if (heldBy && linkThread) cycle.push({ thread: linkThread, waitsFor: linkWaitsFor, heldBy: heldBy[1] ?? "" });
  }

  if (threads.length === 0) return null;

  const deadlocked = new Set(deadlocks.flatMap((links) => links.map((l) => l.thread)));
  for (const t of threads) t.deadlocked = deadlocked.has(t.name);
  return { header, threads, deadlocks };
}
