/**
 * The review flow buttons (`GHPRDetailsActionsComponentFactory`): nothing once merged,
 * "Reopen Pull Request" when closed, "Post Pull Request" for a draft; an open pull request
 * gets its role's buttons — Request / Re-request Review…, Submit Review…, Set Myself as
 * Reviewer, the Merge split button — and the More (⋯) menu. Every action is disabled while
 * another one runs; managing needs triage access or authorship, merging the rules of
 * `pullRequestPermissions`.
 */
import { useRef, useState, type RefObject } from "react";
import { Button, Icon, IconButton, Spinner, showContextMenu, type MenuItem } from "@/ui";
import { useTx } from "@/platform/i18n";
import type { GHPRMergeabilityState, GHPullRequest, GHPullRequestRequestedReviewer } from "../api/types";
import * as ops from "../data/operations";
import { isTeam, pullRequestPermissions, reviewerKey, type ReviewerWithState } from "../data/model";
import { useGhRepository, usePotentialReviewers } from "../data/repository";
import { usePullRequestData } from "../data/pullRequest";
import { ChooserPopup } from "../ui/ChooserPopup";
import { adjustReviewers, merge, reRequestReview, runFlow, useFlowBusy } from "./flow";
import {
  dedupe,
  MERGE_METHOD_LABEL,
  mergeButtonMethods,
  openedActions,
  reviewRequestState,
  reviewRole,
  type MergeMethod,
  type ReviewState,
} from "./model";
import { showSubmitReview } from "./SubmitReviewPopup";
import styles from "./Details.module.css";

export function ReviewActions(props: {
  pr: GHPullRequest;
  mergeability: GHPRMergeabilityState | undefined;
  reviewers: readonly ReviewerWithState[];
  reviewState: ReviewState;
  /** The Submit Review… button, for the `submitReview` handler to anchor its popup. */
  submitRef: RefObject<HTMLButtonElement | null>;
}) {
  const { pr, mergeability, reviewers, reviewState, submitRef } = props;
  const tx = useTx();
  const n = pr.number;
  const connection = useGhRepository((s) => s.connection);
  const progress = useFlowBusy((s) => s.busy[n]);
  const busy = progress !== undefined;
  const pending = usePullRequestData(n, "pendingReview").value;
  const more = useRef<HTMLButtonElement>(null);
  const [picker, setPicker] = useState<Element | null>(null);
  if (!connection) return null;
  const me = connection.currentUser;
  const repo = connection.repository;
  const perms = pullRequestPermissions(pr, repo, mergeability ?? null);
  const canManage = perms.canManage && !busy;
  const enabled: Record<MergeMethod, boolean> = {
    merge: perms.canMerge && !busy,
    squash: perms.canSquashMerge && !busy,
    rebase: perms.canRebaseMerge && !busy,
  };
  const requested = pr.reviewRequests.nodes.flatMap((r) => (r.requestedReviewer ? [r.requestedReviewer] : []));
  const requestState = reviewRequestState(pr);

  const progressText = progress ? (
    <span className={styles.progressText}>
      <Spinner size={12} />
      {progress}
    </span>
  ) : null;

  if (requestState === "MERGED") return null;
  if (requestState === "CLOSED")
    return (
      <div className={styles.actions}>
        <Button disabled={!canManage} onClick={() => void runFlow(n, () => ops.reopenPullRequest(n))}>
          Reopen Pull Request
        </Button>
        {progressText}
      </div>
    );
  if (requestState === "DRAFT")
    return (
      <div className={styles.actions}>
        <Button disabled={!canManage} onClick={() => void runFlow(n, () => ops.markReadyForReview(n))}>
          Post Pull Request
        </Button>
        {progressText}
      </div>
    );

  const role = reviewRole(pr, me);
  const myState = reviewers.find((r) => !isTeam(r.reviewer) && r.reviewer.id === me.id)?.state ?? null;
  const shown = openedActions(role, reviewState, requested.length, myState);
  const comments = pending?.commentsCount ?? 0;
  const methods = mergeButtonMethods(repo);

  const mergeItems = (): MenuItem[] =>
    (["merge", "squash", "rebase"] as const).map((m) => ({
      label: MERGE_METHOD_LABEL[m],
      disabled: !enabled[m],
      run: () => void merge(n, m),
    }));
  const showMore = () => {
    const r = more.current?.getBoundingClientRect();
    if (!r) return;
    const items: MenuItem[] = shown.more.map((item): MenuItem => {
      if (item === "requestReview")
        return { label: "Request Review…", disabled: !canManage, run: () => setPicker(more.current) };
      if (item === "mergeGroup") return { label: "Merge Review…", submenu: mergeItems() };
      return {
        label: "Close Pull Request",
        disabled: !canManage,
        run: () => void runFlow(n, () => ops.closePullRequest(n)),
      };
    });
    showContextMenu({ x: r.left, y: r.bottom + 8 }, items);
  };

  return (
    <div className={styles.actions}>
      {shown.requestReview && (
        <Button disabled={!canManage} onClick={(e) => setPicker(e.currentTarget)}>
          Request Review…
        </Button>
      )}
      {shown.reRequestReview && (
        <Button disabled={!canManage} onClick={() => void reRequestReview(n, requested, reviewers)}>
          Re-request Review…
        </Button>
      )}
      {shown.submitReview && (
        <Button ref={submitRef} onClick={(e) => void showSubmitReview(n, e.currentTarget)}>
          {comments > 0 ? tx`Submit Review (${comments})…` : tx("Submit Review…")}
        </Button>
      )}
      {shown.setMyselfAsReviewer && (
        <Button disabled={!canManage} onClick={() => void adjustReviewers(n, requested, [...requested, me])}>
          Set Myself as Reviewer
        </Button>
      )}
      {shown.merge && (
        <span className={styles.optionButton}>
          <Button
            className={styles.optionMain}
            disabled={!enabled[methods.main]}
            onClick={() => void merge(n, methods.main)}
          >
            {MERGE_METHOD_LABEL[methods.main]}
          </Button>
          <button
            type="button"
            className={styles.optionArrow}
            aria-label={tx("More merge options")}
            aria-haspopup="menu"
            onClick={(e) => {
              const r = e.currentTarget.parentElement!.getBoundingClientRect();
              showContextMenu(
                { x: r.left, y: r.bottom + 2 },
                methods.others.map((m) => ({
                  label: MERGE_METHOD_LABEL[m],
                  disabled: !enabled[m],
                  run: () => void merge(n, m),
                })),
              );
            }}
          >
            <Icon name="chevron-down" size={12} />
          </button>
        </span>
      )}
      <IconButton ref={more} icon="more-horizontal" title="More Actions" className={styles.more} onClick={showMore} />
      {progressText}
      {picker && (
        <ReviewerPicker
          anchor={picker}
          pr={pr}
          current={dedupe([...requested, ...reviewers.map((r) => r.reviewer)])}
          onClose={(chosen) => {
            setPicker(null);
            void adjustReviewers(n, dedupe([...requested, ...reviewers.map((r) => r.reviewer)]), chosen);
          }}
        />
      )}
    </div>
  );
}

/** `showMultipleChooserPopupWithIncrementalLoading` of the potential reviewers (the author excluded), above the button. */
function ReviewerPicker(props: {
  anchor: Element;
  pr: GHPullRequest;
  current: GHPullRequestRequestedReviewer[];
  onClose: (chosen: GHPullRequestRequestedReviewer[]) => void;
}) {
  const tx = useTx();
  const candidates = usePotentialReviewers();
  const authorId = props.pr.author?.id;
  const items = candidates.items.filter((r) => isTeam(r) || r.id !== authorId);
  return (
    <ChooserPopup
      mode="multi"
      anchor={props.anchor}
      placement="top-start"
      items={items}
      loading={candidates.loading}
      error={candidates.error}
      chosen={props.current}
      getKey={reviewerKey}
      present={(r) =>
        isTeam(r)
          ? { text: r.combinedSlug, detail: r.teamName, avatarUrl: r.teamAvatarUrl }
          : { text: r.login, detail: r.name, avatarUrl: r.avatarUrl }
      }
      onClose={props.onClose}
      aria-label={tx("Reviewers")}
    />
  );
}
