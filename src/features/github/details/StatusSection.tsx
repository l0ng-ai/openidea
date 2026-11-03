/**
 * The status section (`GHPRStatusChecksComponentFactory`): "Loading pull request status"
 * until the mergeability loads, then the access line, the CI line with its "Details…"
 * chooser, the conflicts line with Resolve, the required reviews and restriction lines,
 * "Missing reviewer" and a row per reviewer (right-click: Re-request / Remove for users
 * who can manage the pull request). At most 149px high, scrolling.
 */
import { useRef, useState, type MouseEvent, type ReactNode } from "react";
import clsx from "clsx";
import { Icon, showContextMenu, T, tooltipAttrs, type MenuItem } from "@/ui";
import { useTx } from "@/platform/i18n";
import type { CodeReviewCIJob, GHPRMergeabilityState, GHPullRequest } from "../api/types";
import { openInBrowser } from "../data/local";
import { reviewerKey, type ReviewerWithState } from "../data/model";
import { Avatar, AVATAR_SIZE, reviewerRingColor } from "../ui/Avatar";
import { ChooserPopup } from "../ui/ChooserPopup";
import { adjustReviewers } from "./flow";
import {
  accessDeniedText,
  ciSummary,
  isAwaitingReview,
  JOB_ICON,
  presentableName,
  reviewerStatusIcon,
  reviewerStatusText,
  STATUS_ICON,
  type ResolveConflicts,
  type StatusIcon,
} from "./model";
import styles from "./Details.module.css";

const StatusGlyph = ({ icon }: { icon: StatusIcon }) => (
  <Icon name={STATUS_ICON[icon]} size={16} className={styles.statusIcon} />
);

function StatusLine({ icon, children }: { icon: StatusIcon; children: ReactNode }) {
  return (
    <div className={styles.statusRow}>
      <StatusGlyph icon={icon} />
      <span className={styles.statusText}>{children}</span>
    </div>
  );
}

export function StatusSection(props: {
  pr: GHPullRequest;
  mergeability: GHPRMergeabilityState | undefined;
  reviewers: readonly ReviewerWithState[];
  canManage: boolean;
  busy: boolean;
  resolve: ResolveConflicts;
  onResolve: () => void;
  permission: Parameters<typeof accessDeniedText>[0];
}) {
  const { pr, mergeability, reviewers } = props;
  const tx = useTx();
  const access = accessDeniedText(props.permission, pr.viewerDidAuthor, pr.isDraft);
  const accessLine = access && (
    <div className={styles.statusRow}>
      <StatusGlyph icon="error" />
      <span className={styles.statusText}>
        <T>{access}</T>
      </span>
    </div>
  );
  if (!mergeability)
    return (
      <div className={styles.status}>
        <StatusLine icon="pending">
          <T>Loading pull request status</T>
        </StatusLine>
        {accessLine}
      </div>
    );
  const required = mergeability.requiredApprovingReviewsCount;
  return (
    <div className={styles.status}>
      {accessLine}
      <CiLine jobs={mergeability.ciJobs} />
      <ConflictsLine
        hasConflicts={mergeability.hasConflicts}
        resolve={props.resolve}
        busy={props.busy}
        onResolve={props.onResolve}
      />
      {required > 0 && !pr.isDraft && (
        <StatusLine icon="failed">
          {tx`At least ${required} approving review is required by reviewers with write access`}
        </StatusLine>
      )}
      {mergeability.isRestricted && !pr.isDraft && (
        <StatusLine icon="failed">
          <T>You are not authorized to merge request into this branch</T>
        </StatusLine>
      )}
      {!reviewers.length && (
        <StatusLine icon="warning">
          <T>Missing reviewer</T>
        </StatusLine>
      )}
      {reviewers.map((r) => (
        <ReviewerRow key={reviewerKey(r.reviewer)} pr={pr} entry={r} canManage={props.canManage} />
      ))}
    </div>
  );
}

function CiLine({ jobs }: { jobs: readonly CodeReviewCIJob[] }) {
  const tx = useTx();
  const link = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const summary = ciSummary(jobs);
  if (!summary) return null;
  return (
    <div className={styles.statusRow}>
      <StatusGlyph icon={summary.icon} />
      <span className={styles.statusText}>
        <T>{summary.text}</T>
      </span>
      <button ref={link} type="button" className={styles.link} onClick={() => setOpen(true)}>
        <T>Details…</T>
      </button>
      {open && (
        <ChooserPopup
          mode="single"
          anchor={link}
          placement="top-start"
          items={jobs}
          getKey={(j) => `${j.name}\u0000${j.detailsUrl ?? ""}`}
          present={(j) => ({ text: j.name, icon: STATUS_ICON[JOB_ICON[j.status]] })}
          onChoose={(j) => j.detailsUrl && void openInBrowser(j.detailsUrl)}
          onClose={() => setOpen(false)}
          height={Math.min(300, 40 + jobs.length * 28)}
          aria-label={tx("Open in Browser")}
        />
      )}
    </div>
  );
}

function ConflictsLine(props: {
  hasConflicts: boolean | null;
  resolve: ResolveConflicts;
  busy: boolean;
  onResolve: () => void;
}) {
  const { hasConflicts, resolve } = props;
  // Shown while GitHub is still checking, hidden once it found none.
  if (hasConflicts === false) return null;
  const error = "error" in resolve ? resolve.error : null;
  return (
    <div className={styles.statusRow}>
      <StatusGlyph icon={hasConflicts === null ? "pending" : "failed"} />
      <span className={styles.statusText}>
        <T>{hasConflicts === null ? "Checking branch for conflicts" : "Branch has conflicts that must be resolved"}</T>
      </span>
      {hasConflicts && (
        <button
          type="button"
          className={styles.link}
          disabled={props.busy || !!error}
          onClick={props.onResolve}
          {...(error ? tooltipAttrs(error) : {})}
        >
          <T>Resolve</T>
        </button>
      )}
    </div>
  );
}

function ReviewerRow({ pr, entry, canManage }: { pr: GHPullRequest; entry: ReviewerWithState; canManage: boolean }) {
  const { reviewer, state } = entry;
  const tx = useTx();
  const number = pr.number;
  const name = presentableName(reviewer);
  const requested = pr.reviewRequests.nodes.flatMap((r) => (r.requestedReviewer ? [r.requestedReviewer] : []));
  const onContextMenu = (e: MouseEvent) => {
    if (!canManage) return;
    e.preventDefault();
    e.stopPropagation();
    const items: MenuItem[] = [
      ...(!isAwaitingReview(state)
        ? [
            {
              label: tx`Re-request Review from ${name}`,
              verbatim: true,
              run: () => void adjustReviewers(number, requested, [...requested, reviewer]),
            },
          ]
        : []),
      {
        label: tx`Remove ${name} from reviewers`,
        verbatim: true,
        run: () =>
          void adjustReviewers(
            number,
            requested,
            requested.filter((r) => reviewerKey(r) !== reviewerKey(reviewer)),
          ),
      },
    ];
    showContextMenu(e, items);
  };
  const avatarUrl = "teamAvatarUrl" in reviewer ? reviewer.teamAvatarUrl : reviewer.avatarUrl;
  return (
    <div className={clsx(styles.statusRow, styles.reviewerRow)} onContextMenu={onContextMenu}>
      <Icon name={reviewerStatusIcon(state)} size={16} className={styles.statusIcon} />
      <Avatar url={avatarUrl} name={name} size={AVATAR_SIZE.OUTLINED} ring={reviewerRingColor(state)} title={null} />
      <span className={styles.statusText}>{reviewerStatusText(state, name)}</span>
    </div>
  );
}
