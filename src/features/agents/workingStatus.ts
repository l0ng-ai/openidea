/**
 * The label of the row under a conversation while the agent works: what the turn's latest
 * output says it is doing, and playful words while it reports nothing new (or nothing yet).
 */
import type { AgentEntry } from "@/bindings";
import { subagentWorking } from "./model";

/** How long one playful word stays while the agent still reports nothing new. */
export const PLAYFUL_WORD_MS = 8_000;
/** How long a playful word stays at least, even when the agent reports something new meanwhile. */
export const PLAYFUL_MIN_MS = 3_000;

/** What the agent can be doing, as the status tells it; `working` covers the rest. */
export const ACTIVITIES = [
  "working",
  "thinking",
  "writing",
  "reading",
  "editing",
  "deleting",
  "moving",
  "searching",
  "running",
  "fetching",
  "subagent",
] as const;
export type Activity = (typeof ACTIVITIES)[number];

/** The factual status of each activity, also what screen readers hear while it is playful. */
export const ACTIVITY_STATUS: Record<Activity, string> = {
  working: "Working…",
  thinking: "Thinking…",
  writing: "Writing…",
  reading: "Reading…",
  editing: "Editing…",
  deleting: "Deleting…",
  moving: "Moving files…",
  searching: "Searching…",
  running: "Running a command…",
  fetching: "Fetching…",
  subagent: "Running a subagent…",
};

/** The built-in playful words of each activity, until the user writes their own. */
export const PLAYFUL_WORDS: Record<Activity, readonly string[]> = {
  working: [
    "Untangling imports…",
    "Explaining it to the rubber duck…",
    "Herding semicolons…",
    "Rebasing onto reality…",
    "Measuring twice…",
    "Sharpening the pencils…",
    "Invalidating a cache…",
  ],
  thinking: [
    "Refactoring a hunch…",
    "Garbage-collecting thoughts…",
    "Compiling a plan…",
    "Caching an insight…",
    "Bisecting the problem…",
    "Naming things…",
  ],
  writing: [
    "Counting brackets…",
    "Settling tabs versus spaces…",
    "Choosing words carefully…",
    "Polishing the prose…",
    "Drafting, redrafting…",
  ],
  reading: [
    "Reading the fine manual…",
    "Following the breadcrumbs…",
    "Walking the call stack…",
    "Reading between the lines…",
    "Skimming the source…",
  ],
  editing: [
    "Squinting at the diff…",
    "Negotiating with the borrow checker…",
    "Asking the linter nicely…",
    "Nudging a semicolon…",
    "Moving code around gently…",
  ],
  deleting: ["Tidying up…", "Taking out the trash…", "Pruning dead code…", "Saying goodbye…"],
  moving: ["Rearranging the furniture…", "Packing boxes…", "Finding a better home…"],
  searching: ["Grepping the void…", "Chasing a null pointer…", "Looking under the couch…", "Searching high and low…"],
  running: [
    "Warming up the compiler…",
    "Pressing Enter with confidence…",
    "Watching the logs scroll…",
    "Waiting on the shell…",
  ],
  fetching: ["Waiting on the network…", "Downloading the internet…", "Following links…"],
  subagent: ["Delegating…", "Consulting a colleague…", "Calling in reinforcements…", "Holding a quick stand-up…"],
};

const TOOL_ACTIVITY: Record<string, Activity> = {
  read: "reading",
  edit: "editing",
  delete: "deleting",
  move: "moving",
  search: "searching",
  execute: "running",
  fetch: "fetching",
  think: "thinking",
};

/** What the turn's latest entry says the agent is doing; null before it reports anything. */
export function activityOf(turn: readonly AgentEntry[]): Activity | null {
  const last = turn.at(-1);
  if (!last) return null;
  switch (last.type) {
    case "thought":
      return "thinking";
    case "agent":
      return "writing";
    case "tool":
      return last.status === "pending" || last.status === "running"
        ? (TOOL_ACTIVITY[last.kind] ?? "working")
        : "working";
    case "subagent":
      return subagentWorking(last.status) ? "subagent" : "working";
    default:
      return "working";
  }
}

/** Changes whenever the agent reports something new in the turn: an entry, more text, a tool's progress. */
export function progressKey(turn: readonly AgentEntry[]): string {
  const last = turn.at(-1);
  const detail =
    last?.type === "agent" || last?.type === "thought"
      ? last.text.length
      : last?.type === "tool"
        ? `${last.status}:${last.output?.length ?? 0}`
        : last?.type === "subagent"
          ? last.status
          : "";
  return `${turn.length}:${last?.type ?? ""}:${detail}`;
}

/**
 * Which of `count` playful words is the `n`th to show in the turn that started at `seed`. Each turn
 * goes through every word in an order of its own.
 */
export function playfulIndex(count: number, seed: number, n: number): number {
  const order = Array.from({ length: count }, (_, i) => i);
  let state = seed >>> 0;
  for (let i = order.length - 1; i > 0; i--) {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0;
    let r = Math.imul(state ^ (state >>> 15), state | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    const j = ((r ^ (r >>> 14)) >>> 0) % (i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order[n % count]!;
}
