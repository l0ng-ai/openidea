/**
 * Client state of the details tab: the changes of single commits (REST `commits/{sha}`,
 * cached per commit), the changes tree's grouping (`GithubPullRequestsProjectUISettings
 * .changesGrouping`, kept in local storage) and the Submit Review popup's text, kept per
 * pull request until the review is submitted (IntelliJ keeps it as the pending review's
 * comment).
 */
import { useEffect } from "react";
import { create } from "zustand";
import { errorMessage } from "../api/client";
import { commitChangedFiles } from "../api/requests";
import type { GHCommitFile } from "../api/types";
import type { Loadable } from "../data/pullRequest";
import { useGhRepository } from "../data/repository";

const useCommitFiles = create<{ bySha: Record<string, Loadable<GHCommitFile[]>> }>(() => ({ bySha: {} }));

const EMPTY: Loadable<GHCommitFile[]> = { value: undefined, loading: false, error: null };

function loadCommitFiles(sha: string) {
  const cur = useCommitFiles.getState().bySha[sha];
  if (cur?.value || cur?.loading) return;
  const put = (v: Loadable<GHCommitFile[]>) => useCommitFiles.setState((s) => ({ bySha: { ...s.bySha, [sha]: v } }));
  put({ value: undefined, loading: true, error: null });
  commitChangedFiles(sha).then(
    (value) => put({ value, loading: false, error: null }),
    (e: unknown) => put({ value: undefined, loading: false, error: errorMessage(e) }),
  );
}

/** The files commit `sha` changes; nothing for null. */
export function useCommitFilesOf(sha: string | null): Loadable<GHCommitFile[]> {
  useEffect(() => {
    if (sha) loadCommitFiles(sha);
  }, [sha]);
  return useCommitFiles((s) => (sha ? (s.bySha[sha] ?? EMPTY) : EMPTY));
}

/** Drops the cached commit changes (Refresh). */
export function clearCommitFiles() {
  useCommitFiles.setState({ bySha: {} });
}

useGhRepository.subscribe((s, prev) => {
  if (s.connection?.coordinates !== prev.connection?.coordinates) clearCommitFiles();
});

// ---------------------------------------------------------------------------

const GROUPING_KEY = "openidea.github.changesGrouping.v1";

function loadGrouping(): boolean {
  try {
    return globalThis.localStorage?.getItem(GROUPING_KEY) !== "none";
  } catch {
    return true;
  }
}

/** Group By › Directory of the changes tree (on by default). */
export const useChangesGrouping = create<{ byDirectory: boolean }>(() => ({ byDirectory: loadGrouping() }));

export function setGroupByDirectory(on: boolean) {
  useChangesGrouping.setState({ byDirectory: on });
  try {
    globalThis.localStorage?.setItem(GROUPING_KEY, on ? "directory" : "none");
  } catch {
    /* storage unavailable */
  }
}

// ---------------------------------------------------------------------------

/** The Submit Review popup's text per pull request. */
export const useReviewText = create<{ text: Record<number, string> }>(() => ({ text: {} }));

export function setReviewText(number: number, text: string) {
  useReviewText.setState((s) => ({ text: { ...s.text, [number]: text } }));
}
