/**
 * PLACEHOLDER (foundation stub) — review mode in the regular editor (wave 2 "reviewMode").
 *
 * Contract: `activateReviewMode()` runs once from the feature's `activate()` and returns
 * its disposer. When the checked-out branch belongs to a pull request of the connected
 * repository it shows review comments in the editor and the status-bar branch widget, and
 * provides the `showCurrentBranchPullRequest`, `updateReviewBranch`, `toggleReviewMode`
 * and `isReviewModeOn` handlers (`toolwindow/handlers.ts`) behind the
 * `github.pullRequest.showInToolWindow`, `.updateBranch` and `.reviewMode` actions.
 */
export function activateReviewMode(): () => void {
  return () => {};
}
