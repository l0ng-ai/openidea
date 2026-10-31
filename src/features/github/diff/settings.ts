/**
 * Review-in-diff settings, persisted in local storage: "Show Review Threads"
 * (`GithubPullRequestsProjectUISettings.editorReviewViewOption`), the new comment's preferred
 * button (`reviewCommentsPreferred`) and "Automatically mark opened files as viewed"
 * (`GithubSettings.isAutomaticallyMarkAsViewed`, on Settings › Version Control › GitHub).
 */
import { create } from "zustand";
import { THREADS_VIEW_OPTIONS, type ThreadsViewOption } from "./model";

export interface ReviewDiffSettings {
  threadsView: ThreadsViewOption;
  /** "Start Review" is the primary button of a new comment (else "Add Single Comment"). */
  reviewCommentsPreferred: boolean;
  autoMarkViewed: boolean;
}

const KEY = "openidea.github.reviewDiff.v1";

/** IntelliJ's defaults. */
const DEFAULTS: ReviewDiffSettings = {
  threadsView: "unresolved",
  reviewCommentsPreferred: true,
  autoMarkViewed: false,
};

export function parseReviewDiffSettings(raw: unknown): ReviewDiffSettings {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  return {
    threadsView: THREADS_VIEW_OPTIONS.some((x) => x.value === o.threadsView)
      ? (o.threadsView as ThreadsViewOption)
      : DEFAULTS.threadsView,
    reviewCommentsPreferred: bool(o.reviewCommentsPreferred, DEFAULTS.reviewCommentsPreferred),
    autoMarkViewed: bool(o.autoMarkViewed, DEFAULTS.autoMarkViewed),
  };
}

function load(): ReviewDiffSettings {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    return parseReviewDiffSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return DEFAULTS;
  }
}

export const useReviewDiffSettings = create<ReviewDiffSettings>(load);

export function setReviewDiffSettings(patch: Partial<ReviewDiffSettings>) {
  useReviewDiffSettings.setState(patch);
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(useReviewDiffSettings.getState()));
  } catch {
    /* storage unavailable */
  }
}
