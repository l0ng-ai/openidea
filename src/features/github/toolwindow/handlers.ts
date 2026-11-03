/**
 * Implementations of registered actions that live in other parts of the port (the
 * details panel, review diff, review mode). A part provides its handler on activation;
 * until then the action is disabled (`when` reads the `github.<name>` context key).
 *
 *   const dispose = provideGithubHandler("submitReview", (number) => showSubmitReview(number));
 */
import { setContext } from "@/platform/context";

export interface GithubHandlers {
  /** Submit Review… for the pull request (its pending review, if any). */
  submitReview: (number: number) => void;
  /** Toggle viewed/not viewed state of the selected files / the file in the active diff. */
  toggleViewed: () => void;
  /** Review mode: Show Pull Request in the Tool Window (the current branch's PR). */
  showCurrentBranchPullRequest: () => void;
  /** Review mode: Update to Enable Review Mode… */
  updateReviewBranch: () => void;
  /** Review mode: the Review Mode toggle. */
  toggleReviewMode: () => void;
  /** Review mode: whether it is on (the toggle's state). */
  isReviewModeOn: () => boolean;
}

export type GithubHandlerName = keyof GithubHandlers;

const handlers: Partial<GithubHandlers> = {};

/** The context key enabling the action(s) of handler `name`. */
export const handlerContextKey = (name: GithubHandlerName) => `github.${name}`;

/** Provides handler `name`, enabling its actions; returns the disposer. */
export function provideGithubHandler<K extends GithubHandlerName>(name: K, handler: GithubHandlers[K]): () => void {
  handlers[name] = handler;
  setContext(handlerContextKey(name), true);
  return () => {
    if (handlers[name] !== handler) return;
    delete handlers[name];
    setContext(handlerContextKey(name), false);
  };
}

export function githubHandler<K extends GithubHandlerName>(name: K): GithubHandlers[K] | undefined {
  return handlers[name];
}
