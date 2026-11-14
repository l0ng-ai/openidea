/** Filtering the Agents task list: fuzzy on the title (highlighted), word starts on the project folder and branch. */
import type { AgentTask } from "@/bindings";
import { fuzzyMatch, wordMatch } from "@/ui";
import { basename } from "@/platform/project";

/** Indices of `query` in the task's title to highlight ([] when another field matched), or null when it doesn't match. */
export function matchTask(task: AgentTask, query: string): number[] | null {
  const q = query.trim();
  if (!q) return [];
  const title = fuzzyMatch(task.title, q);
  if (title) return title;
  const others = [task.projectRoot ? basename(task.projectRoot) : null, task.branch];
  return others.some((text) => text && wordMatch(text, q)) ? [] : null;
}
