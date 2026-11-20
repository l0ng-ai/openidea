/** A task has one interactive conversation view, even when that view lives in another window. */
import type { ComposerDraft } from "./composerModel";

type Route = (task: string | null, prompt?: string) => boolean;
type Drafts = {
  read(task: string): ComposerDraft | undefined;
  update(task: string, patch: Partial<ComposerDraft>): boolean;
};
let route: Route | undefined;
let focused: ((task: string) => boolean) | undefined;
let drafts: Drafts | undefined;

export function installTaskWindowRouting(
  open: Route,
  isFocused?: (task: string) => boolean,
  composers?: Drafts,
): () => void {
  route = open;
  focused = isFocused;
  drafts = composers;
  return () => {
    if (route === open) {
      route = undefined;
      focused = undefined;
      drafts = undefined;
    }
  };
}

export const taskWindowFocused = (task: string): boolean => focused?.(task) ?? false;

/** Whether another window shows `task` (New Task when null) instead of this one. */
export const routeToWindow: Route = (task, prompt) => route?.(task, prompt) ?? false;
export const taskWindowDraft = (task: string) => drafts?.read(task);
export const updateTaskWindowDraft = (task: string, patch: Partial<ComposerDraft>) =>
  drafts?.update(task, patch) ?? false;
