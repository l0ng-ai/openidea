/**
 * Pure rules of the pull request list, ported from IntelliJ: the Quick Filters
 * (`GHPRListQuickFilter`), the chips' option lists and texts (`GHPRSearchPanelFactory`),
 * the search history's text (`getShortText`) and save rule
 * (`ReviewListSearchPanelViewModelBase`), the row's presentation
 * (`GHPRListComponentFactory`) and the 70% paging threshold (`ReviewListUtil`).
 */
import { tx } from "@/platform/i18n";
import type { GHPRReviewerState, GHPullRequestRequestedReviewer, GHPullRequestShort } from "../api/types";
import {
  filterCount,
  isTeam,
  sameSearch,
  sortedReviewersStates,
  type PrSearchReviewState,
  type PrSearchSort,
  type PrSearchState,
  type PrSearchValue,
} from "../data/model";

// ---------------------------------------------------------------------------
// Quick Filters

export type QuickFilterId = "OPEN" | "YOURS" | "ASSIGNED" | "REVIEW_REQUESTS";

export interface QuickFilter {
  id: QuickFilterId;
  title: string;
  filter: PrSearchValue;
}

/** The Quick Filters of the signed-in user, in menu order. */
export function quickFilters(login: string): QuickFilter[] {
  return [
    { id: "OPEN", title: "Open", filter: { state: "OPEN" } },
    { id: "YOURS", title: "Your pull requests", filter: { state: "OPEN", author: login } },
    { id: "ASSIGNED", title: "Assigned to you", filter: { state: "OPEN", assignee: login } },
    { id: "REVIEW_REQUESTS", title: "Review requests", filter: { state: "OPEN", reviewState: "AWAITING_REVIEW" } },
  ];
}

/** The list's first-run filter and the one the history never keeps: "Assigned to you". */
export const defaultFilter = (login: string): PrSearchValue => ({ state: "OPEN", assignee: login });

/** A quick filter is checked only when the search is exactly it. */
export const isQuickFilterSelected = (search: PrSearchValue, q: QuickFilter) => sameSearch(search, q.filter);

// ---------------------------------------------------------------------------
// Chips

export interface ChipOption<V extends string> {
  value: V;
  /** The chip's text (and the history's). */
  text: string;
  /** The popup's text, when it differs. */
  label?: string;
}

export const STATE_OPTIONS: ChipOption<PrSearchState>[] = [
  { value: "OPEN", text: "Open" },
  { value: "CLOSED", text: "Closed" },
  { value: "MERGED", text: "Merged" },
];

export const REVIEW_OPTIONS: ChipOption<PrSearchReviewState>[] = [
  { value: "NO_REVIEW", text: "No reviews" },
  { value: "REQUIRED", text: "Review required" },
  { value: "APPROVED", text: "Approved review" },
  { value: "CHANGES_REQUESTED", text: "Changes requested" },
  { value: "REVIEWED_BY_ME", text: "Reviewed", label: "Reviewed by you" },
  { value: "NOT_REVIEWED_BY_ME", text: "Not reviewed", label: "Not reviewed by you" },
  { value: "AWAITING_REVIEW", text: "Awaiting review", label: "Awaiting review from you" },
];

export const SORT_OPTIONS: ChipOption<PrSearchSort>[] = [
  { value: "NEWEST", text: "Newest" },
  { value: "OLDEST", text: "Oldest" },
  { value: "MOST_COMMENTED", text: "Most commented" },
  { value: "LEAST_COMMENTED", text: "Least commented" },
  { value: "RECENTLY_UPDATED", text: "Recently updated" },
  { value: "LEAST_RECENTLY_UPDATED", text: "Least recently updated" },
];

const optionText = <V extends string>(options: readonly ChipOption<V>[], v: V) =>
  tx(options.find((o) => o.value === v)?.text ?? v);

export const stateText = (v: PrSearchState) => optionText(STATE_OPTIONS, v);
export const reviewText = (v: PrSearchReviewState) => optionText(REVIEW_OPTIONS, v);
export const sortText = (v: PrSearchSort) => optionText(SORT_OPTIONS, v);

/**
 * The history popup's text of a search (`getShortText`), e.g.
 * `"foo" state:"Open" label:bug assignee:me reviewState:"Awaiting review" author:x sort:"Newest"`.
 */
export function searchHistoryText(v: PrSearchValue): string {
  const parts: string[] = [];
  if (v.searchQuery !== undefined) parts.push(`"${v.searchQuery}"`);
  if (v.state) parts.push(`state:"${stateText(v.state)}"`);
  if (v.label !== undefined) parts.push(`label:${v.label}`);
  if (v.assignee !== undefined) parts.push(`assignee:${v.assignee}`);
  if (v.reviewState) parts.push(`reviewState:"${reviewText(v.reviewState)}"`);
  if (v.author !== undefined) parts.push(`author:${v.author}`);
  if (v.sort) parts.push(`sort:"${sortText(v.sort)}"`);
  return parts.join(" ");
}

/** `v` with the text set (empty text clears it, as Enter in the field). */
export function withQuery(v: PrSearchValue, text: string): PrSearchValue {
  const { searchQuery: _, ...rest } = v;
  return text ? { ...rest, searchQuery: text } : rest;
}

// ---------------------------------------------------------------------------
// History saving

/** IntelliJ waits this long before keeping a search whose text did not change (chip-only changes). */
export const CHIP_ONLY_SAVE_DELAY_MS = 10_000;

export interface SearchHistoryRecorder {
  /** The search changed to `v` (the first call is the initial value). */
  onChange(v: PrSearchValue): void;
  dispose(): void;
}

/**
 * `ReviewListSearchPanelViewModelBase.updateHistoryOnSearchChanges`: every value is saved
 * as the last filter; after the first, a value with filters that is not `defaultSearch` is
 * added to the history, at once when its text changed, else after 10 seconds unless the
 * search changes again in the meantime.
 */
export function createSearchHistoryRecorder(opts: {
  defaultSearch: PrSearchValue;
  saveLast: (v: PrSearchValue) => void;
  remember: (v: PrSearchValue) => void;
  delayMs?: number;
}): SearchHistoryRecorder {
  let previous: PrSearchValue | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    onChange(v) {
      clearTimeout(timer);
      timer = undefined;
      const old = previous;
      previous = v;
      opts.saveLast(v);
      if (!old) return;
      if (filterCount(v) === 0 || sameSearch(v, opts.defaultSearch)) return;
      if (old.searchQuery === v.searchQuery)
        timer = setTimeout(() => opts.remember(v), opts.delayMs ?? CHIP_ONLY_SAVE_DELAY_MS);
      else opts.remember(v);
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}

// ---------------------------------------------------------------------------
// Rows

/** `NamedCollection` titles: "Label" / "Labels" and so on, by count. */
export function labelsTitle(n: number) {
  return n === 1 ? tx("Label") : tx("Labels");
}
export function assigneesTitle(n: number) {
  return n === 1 ? tx("Assignee") : tx("Assignees");
}
export function reviewersTitle(n: number) {
  return n === 1 ? tx("Reviewer") : tx("Reviewers");
}

/** The comment counter's tooltip (`pull.request.unresolved.comments`). */
export function unresolvedCommentsTooltip(count: number): string {
  if (count === 0) return tx("No unresolved comments");
  return count === 1 ? tx`${count} unresolved comment` : tx`${count} unresolved comments`;
}

/** The second line: `#N · created {date}, by {login}`, or without the author. */
export function infoLine(number: number, date: string, author: string | null | undefined): string {
  const id = `#${number}`;
  return author ? tx`${id} · created ${date}, by ${author}` : tx`${id} · created ${date}`;
}

export interface ReviewerPresentation {
  key: string;
  /** Avatar tooltip / list text: the full name, else the login (team: name, else slug). */
  name: string;
  avatarUrl: string | null;
  state: GHPRReviewerState;
}

function reviewerPresentation(r: GHPullRequestRequestedReviewer, state: GHPRReviewerState): ReviewerPresentation {
  if (isTeam(r)) return { key: r.id || r.combinedSlug, name: r.teamName || r.slug, avatarUrl: r.teamAvatarUrl, state };
  return { key: r.id || r.login, name: r.name || r.login, avatarUrl: r.avatarUrl, state };
}

/** The row's reviewers in display order: approved → changes requested → commented → re-requested → needs review. */
export function rowReviewers(pr: Pick<GHPullRequestShort, "author" | "reviews" | "reviewRequests">) {
  return sortedReviewersStates(pr).map((r) => reviewerPresentation(r.reviewer, r.state));
}

// ---------------------------------------------------------------------------
// Paging

/** `BoundedRangeModelThresholdListener(0.7)`: the visible part reaches 70% of the content (or there is no scroll). */
export function pastThreshold(scrollTop: number, clientHeight: number, scrollHeight: number, threshold = 0.7): boolean {
  if (scrollHeight <= 0) return true;
  return (scrollTop + clientHeight) / scrollHeight >= threshold;
}
