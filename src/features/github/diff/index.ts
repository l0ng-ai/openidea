/**
 * PLACEHOLDER (foundation stub) — review in the diff viewer (wave 2 "diff").
 *
 * Contract: `activateReviewDiff()` runs once from the feature's `activate()` and returns
 * its disposer. It extends `src/features/vcs` diff APIs generically to show review threads
 * of pull request diffs (opened by `openPullRequestFileDiff` in `data/local.ts`), the
 * gutter "+", Start Review / Add Single Comment, the review toolbar and the viewed toggle
 * (`provideGithubHandler("toggleViewed", …)`). Data and mutations: `data/pullRequest.ts`,
 * `data/operations.ts`; comment components from `timeline/`.
 */
export function activateReviewDiff(): () => void {
  return () => {};
}
