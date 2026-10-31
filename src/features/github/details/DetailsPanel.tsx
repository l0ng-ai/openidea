/**
 * The `#N` tab of the Pull Requests tool window (IntelliJ's `GHPRDetailsComponentFactory`),
 * top to bottom: the title with `#N` and the state tag, "View Timeline", the commit picker
 * with the head branch widget on the right, the selected commit's info, the changes tree,
 * the status section and the review flow buttons. Right-click elsewhere:
 * `Github.PullRequest.Details.Popup` (Refresh, View in Browser, Copy URL).
 *
 * Provides the `submitReview` and `toggleViewed` handlers while it is shown.
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent, type RefObject } from "react";
import { useVcs } from "@/features/vcs/store";
import { useTx } from "@/platform/i18n";
import { Spinner, T, showContextMenu, tooltipAttrs, type MenuItem } from "@/ui";
import { hasPermission, reviewersStates } from "../data/model";
import { openInBrowser } from "../data/local";
import { reloadPullRequestData, usePullRequestData } from "../data/pullRequest";
import { useGhRepository } from "../data/repository";
import { provideGithubHandler } from "../toolwindow/handlers";
import { openTimeline } from "../toolwindow/timelineInput";
import { StateTag } from "../ui/chips";
import { BranchWidget } from "./BranchWidget";
import { ChangesTree } from "./ChangesTree";
import { CommitInfo, CommitPicker } from "./CommitPicker";
import { isInCurrentHistory, resolveConflictsLocally, useFlowBusy } from "./flow";
import { isHeadCheckedOut, overallReviewState, remoteOf, resolveConflicts, reviewRequestState } from "./model";
import { ReviewActions } from "./ReviewActions";
import { useCommitFilesOf } from "./state";
import { StatusSection } from "./StatusSection";
import { showSubmitReview } from "./SubmitReviewPopup";
import styles from "./Details.module.css";

const PANEL_MENU: (n: number) => MenuItem[] = (n) => [
  { kind: "action", action: "github.pullRequest.refresh", arg: n },
  { kind: "action", action: "github.pullRequest.openInBrowser", arg: n },
  { kind: "action", action: "github.pullRequest.copyUrl", arg: n },
];

export function DetailsPanel({ number }: { number: number }) {
  const details = usePullRequestData(number, "details");
  const submitRef = useRef<HTMLButtonElement>(null);

  useEffect(
    () =>
      provideGithubHandler("submitReview", (n) => void showSubmitReview(n, n === number ? submitRef.current : null)),
    [number],
  );

  const onContextMenu = (e: MouseEvent) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    showContextMenu(e, PANEL_MENU(number));
  };

  const pr = details.value;
  return (
    <div className={styles.panel} onContextMenu={onContextMenu}>
      {pr ? (
        <Details number={number} submitRef={submitRef} />
      ) : details.error ? (
        <div className={styles.centered}>
          <div className={styles.error}>{details.error}</div>
          <button
            type="button"
            className={styles.link}
            onClick={() => void reloadPullRequestData(number, "details").catch(() => undefined)}
          >
            <T>Retry</T>
          </button>
        </div>
      ) : (
        <div className={styles.centered}>
          <Spinner size={16} />
        </div>
      )}
    </div>
  );
}

function Details({ number, submitRef }: { number: number; submitRef: RefObject<HTMLButtonElement | null> }) {
  const tx = useTx();
  const pr = usePullRequestData(number, "details").value!;
  const mergeability = usePullRequestData(number, "mergeability").value;
  const commits = usePullRequestData(number, "commits").value ?? [];
  const changes = usePullRequestData(number, "changes");
  const viewedState = usePullRequestData(number, "viewedState").value;
  const threads = usePullRequestData(number, "threads").value;
  const permission = useGhRepository((s) => s.connection?.repository.viewerPermission);
  const remotes = useGhRepository((s) => s.remotes);
  const branch = useVcs((s) => s.branch);
  const busy = useFlowBusy((s) => s.busy[number] !== undefined);

  const [selected, setSelected] = useState(-1);
  // A single-commit pull request only has the cumulative list (`GHPRChangesViewModel`).
  const commit = commits.length > 1 ? commits[selected] : undefined;
  const commitFiles = useCommitFilesOf(commit?.commit.oid ?? null);
  const files = commit ? commitFiles : changes;

  const reviewers = useMemo(() => reviewersStates(pr), [pr]);
  const reviewState = overallReviewState(pr, reviewers, mergeability?.requiredApprovingReviewsCount ?? 0);
  const checkedOut = isHeadCheckedOut(branch, remotes, pr);
  const headRemote = remoteOf(remotes, pr.headRepository?.nameWithOwner)?.remote ?? null;

  // "Already resolved locally": the head branch is checked out and already has the base commit.
  const historyKey = checkedOut ? `${pr.baseRefOid}:${branch?.headCommit ?? ""}` : null;
  const [inHistory, setInHistory] = useState<{ key: string; value: boolean } | null>(null);
  useEffect(() => {
    let alive = true;
    if (historyKey)
      void isInCurrentHistory(historyKey.slice(0, historyKey.indexOf(":"))).then(
        (value) => alive && setInHistory({ key: historyKey, value }),
      );
    return () => {
      alive = false;
    };
  }, [historyKey]);
  const baseInHistory = !!historyKey && inHistory?.key === historyKey && inHistory.value;
  const resolve = resolveConflicts({
    details: pr,
    remotes,
    mergeInProgress: !!branch?.operation,
    alreadyResolvedLocally: checkedOut && baseInHistory,
  });

  const state = reviewRequestState(pr);
  return (
    <>
      <div className={styles.titlePanel}>
        <div className={styles.titleRow}>
          <h2 className={styles.title}>
            {pr.title}
            {" "}
            <a
              href={pr.url}
              className={styles.number}
              {...tooltipAttrs(tx("View in browser"))}
              onClick={(e) => {
                e.preventDefault();
                void openInBrowser(pr.url);
              }}
            >
              #{pr.number}
            </a>
          </h2>
          {state !== "OPENED" && (
            <StateTag
              state={state === "DRAFT" ? "OPEN" : pr.state}
              isDraft={state === "DRAFT"}
              className={styles.tag}
            />
          )}
        </div>
        <button type="button" className={styles.link} onClick={() => void openTimeline(number, { focus: true })}>
          <T>View Timeline</T>
        </button>
      </div>
      <div className={styles.commitsAndBranches}>
        <CommitPicker commits={commits} selected={commit ? selected : -1} onSelect={setSelected} />
        <BranchWidget pr={pr} checkedOut={checkedOut} headRemote={headRemote} />
      </div>
      {commit && <CommitInfo key={commit.commit.oid} commit={commit} />}
      <div className={styles.changes}>
        {files.value ? (
          <ChangesTree
            key={commit?.commit.oid ?? "all"}
            number={number}
            files={files.value}
            commitSha={commit?.commit.oid ?? null}
            viewedState={viewedState}
            threads={threads}
            checkedOut={checkedOut}
          />
        ) : files.error ? (
          <div className={styles.centered}>
            <div className={styles.error}>
              <T>Can't load changes</T>
            </div>
            <div className={styles.secondary}>{files.error}</div>
            <button
              type="button"
              className={styles.link}
              onClick={() => void reloadPullRequestData(number, "changes").catch(() => undefined)}
            >
              <T>Retry</T>
            </button>
          </div>
        ) : (
          <div className={styles.centered}>
            <Spinner size={14} />
            <T>Loading…</T>
          </div>
        )}
      </div>
      <StatusSection
        pr={pr}
        mergeability={mergeability}
        reviewers={reviewers}
        canManage={hasPermission(permission, "TRIAGE") || pr.viewerDidAuthor}
        busy={busy}
        resolve={resolve}
        permission={permission}
        onResolve={() => {
          if ("baseRemote" in resolve) void resolveConflictsLocally(number, resolve, checkedOut);
        }}
      />
      <ReviewActions
        pr={pr}
        mergeability={mergeability}
        reviewers={reviewers}
        reviewState={reviewState}
        submitRef={submitRef}
      />
    </>
  );
}
