/** The Agents task list holding focus, so its shortcuts act on the selected tasks. */
import { setContext } from "@/platform/context";

let selection: (() => string[]) | null = null;

export function setFocusedTaskList(get: (() => string[]) | null) {
  selection = get;
  setContext("agentTaskListFocus", !!get);
}

export const focusedTaskListSelection = (): string[] => selection?.() ?? [];
