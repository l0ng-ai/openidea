/**
 * The task list's search (#3148): a query fuzzy-matches every task's title, first user
 * message and project name, and each imported session's title — whatever group or pinned
 * section the task sits in. Case-insensitive, non-contiguous hits allowed (`fuzzyMatch`,
 * as in the other choosers); the title's hit characters are what the rows highlight.
 */
import type { AgentTask, ExternalSession } from "@/bindings";
import { fuzzyMatch } from "@/ui";

/** A row's match: the hit characters of its title, `null` when only its other text matched. */
type TitleHit = number[] | null;

/** Whether the list is searching: a query with anything but whitespace. */
export const searching = (query: string) => !!query.trim();

/**
 * The tasks matching `query`, by id. Every task is a candidate, whatever section shows
 * it; a task matched by its prompt or project has no title characters to highlight.
 * An empty query matches nothing: the list stays whole, unhighlighted.
 */
export function taskHits(
  tasks: Iterable<AgentTask>,
  query: string,
  projectName: (task: AgentTask) => string | null,
): Map<string, TitleHit> {
  const q = query.trim();
  const hits = new Map<string, TitleHit>();
  if (!q) return hits;
  for (const task of tasks) {
    const title = fuzzyMatch(task.title, q);
    if (title) {
      hits.set(task.id, title);
      continue;
    }
    const prompt = task.prompt ? fuzzyMatch(task.prompt, q) : null;
    const name = projectName(task);
    if (prompt || (name && fuzzyMatch(name, q))) hits.set(task.id, null);
  }
  return hits;
}

/** The imported sessions matching `query`, by `provider:sessionId` key. */
export function sessionHits(sessions: readonly ExternalSession[], query: string): Map<string, TitleHit> {
  const q = query.trim();
  const hits = new Map<string, TitleHit>();
  if (!q) return hits;
  for (const session of sessions) {
    const title = fuzzyMatch(session.title, q);
    if (title) hits.set(`${session.provider}:${session.sessionId}`, title);
  }
  return hits;
}
