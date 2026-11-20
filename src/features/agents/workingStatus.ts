/** The label of the row under a conversation while the agent works: what the turn's latest output says it is doing. */
import type { AgentEntry } from "@/bindings";
import { subagentWorking } from "./model";

/** What the agent can be doing, as the status tells it; `working` covers the rest. */
type Activity =
  | "working"
  | "thinking"
  | "writing"
  | "reading"
  | "editing"
  | "deleting"
  | "moving"
  | "searching"
  | "running"
  | "fetching"
  | "subagent";

/** The status of each activity. */
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
