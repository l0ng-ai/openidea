import { useProject } from "@/platform/project";
import { splitTarget } from "./model";

let projectGeneration = 0;
const generations = new Map<string, object>();

useProject.subscribe((state, previous) => {
  if (state.project?.root === previous.project?.root) return;
  projectGeneration++;
  generations.clear();
});

function generation(id: string): object {
  let value = generations.get(id);
  if (!value) generations.set(id, (value = {}));
  return value;
}

/** A return to the same project or target is a new lifetime, too. */
export function projectRequest(): () => boolean {
  const project = projectGeneration;
  return () => project === projectGeneration;
}

export function databaseRequest(id: string): () => boolean {
  const project = projectRequest();
  const sourceId = splitTarget(id).id;
  const source = generation(sourceId);
  const target = generation(id);
  return () => project() && generations.get(sourceId) === source && generations.get(id) === target;
}

export function invalidateDatabaseRequests(id: string) {
  generations.set(id, {});
}
