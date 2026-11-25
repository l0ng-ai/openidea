import { create } from "zustand";
import type { RemoteTarget } from "@/bindings";
import { useProject } from "./project";
import { useRemote } from "./remote";

type TodoFilterContext = "commit" | "view";

function storageKey(context: TodoFilterContext, root: string | undefined, remote: RemoteTarget | undefined) {
  return root ? `openidea.todo.filter.${context}:${JSON.stringify([remote ?? null, root])}` : null;
}

const useSelections = create<Record<string, string | null>>(() => ({}));

function readSelection(key: string | null, cached: string | null | undefined): string | null {
  if (cached !== undefined) return cached;
  try {
    return key ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function currentKey(context: TodoFilterContext) {
  return storageKey(context, useProject.getState().project?.root, useRemote.getState().session?.target);
}

export function todoFilterSelection(context: TodoFilterContext): string | null {
  const key = currentKey(context);
  return readSelection(key, key ? useSelections.getState()[key] : undefined);
}

export function useTodoFilterSelection(context: TodoFilterContext) {
  const root = useProject((state) => state.project?.root);
  const target = useRemote((state) => state.session?.target);
  const key = storageKey(context, root, target);
  const cached = useSelections((state) => (key ? state[key] : undefined));
  return readSelection(key, cached);
}

export function setTodoFilterSelection(context: TodoFilterContext, id: string | null) {
  const key = currentKey(context);
  if (!key) return;
  useSelections.setState({ [key]: id });
  try {
    if (id === null) localStorage.removeItem(key);
    else localStorage.setItem(key, id);
  } catch {
    // The in-memory selection still applies in this window.
  }
}
