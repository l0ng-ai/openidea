/**
 * A list row (`ReviewListCellRenderer` with `GHPRListComponentFactory.presentPR`).
 * First line, 6px apart: the unread dot, the title (full title as tooltip when cut off)
 * and the labels icon on the left; the state tag, the conflict icon, up to 2 assignee
 * and 2 reviewer avatars and the unresolved comment counter on the right. Second line,
 * one size smaller and grey: `#N · created {date}, by {login}`.
 */
import { memo, useMemo, type PointerEvent } from "react";
import { Icon } from "@/ui";
import type { GHPullRequestShort, GHUser } from "../api/types";
import { usePullRequestSeen } from "../data/interaction";
import { unresolvedThreadsCount } from "../data/model";
import { Avatar, AvatarStack, AVATAR_SIZE, reviewerRingColor } from "../ui/Avatar";
import { labelColor, StateTag } from "../ui/chips";
import { prettyDate } from "../ui/prettyDate";
import { HoverBalloon, type BalloonItem } from "./HoverBalloon";
import {
  assigneesTitle,
  infoLine,
  labelsTitle,
  reviewersTitle,
  rowReviewers,
  unresolvedCommentsTooltip,
} from "./model";
import styles from "./List.module.css";

/** The participant icons a row shows per group (`MAX_PARTICIPANT_ICONS`). */
const MAX_AVATARS = 2;

/** Sets the full title as the tooltip only while it is cut off. */
function titleTooltip(e: PointerEvent<HTMLElement>) {
  const el = e.currentTarget;
  if (el.scrollWidth > el.clientWidth) el.dataset.tooltip = el.textContent ?? "";
  else delete el.dataset.tooltip;
}

export const PullRequestRow = memo(function PullRequestRow({
  pr,
  currentUser,
}: {
  pr: GHPullRequestShort;
  currentUser: GHUser | null;
}) {
  const seen = usePullRequestSeen(pr, currentUser);
  const reviewers = useMemo(() => rowReviewers(pr), [pr]);
  const labels = pr.labels.nodes;
  const assignees = pr.assignees.nodes;
  const comments = unresolvedThreadsCount(pr);

  const labelItems: BalloonItem[] = labels.map((l) => ({
    key: l.id || l.name,
    icon: (
      <span className={styles.tintedIcon} style={{ color: labelColor(l) }}>
        <Icon name="branch-label" size={16} />
      </span>
    ),
    text: l.name,
  }));
  const assigneeItems: BalloonItem[] = assignees.map((u) => ({
    key: u.id || u.login,
    icon: <Avatar url={u.avatarUrl} name={u.login} size={AVATAR_SIZE.BASE} title={null} />,
    text: u.login,
  }));
  const reviewerItems: BalloonItem[] = reviewers.map((r) => ({
    key: r.key,
    icon: (
      <Avatar
        url={r.avatarUrl}
        name={r.name}
        size={AVATAR_SIZE.OUTLINED}
        ring={reviewerRingColor(r.state)}
        title={null}
      />
    ),
    text: r.name,
  }));

  return (
    <div className={styles.row} data-pr={pr.number}>
      <div className={styles.line}>
        <div className={styles.left}>
          {!seen && <span className={styles.unread} aria-hidden data-unread />}
          <span className={styles.title} onPointerEnter={titleTooltip}>
            {pr.title}
          </span>
          {labels.length > 0 && (
            <HoverBalloon title={labelsTitle(labels.length)} items={labelItems} className={styles.icon}>
              <Icon name="branch-label" size={16} />
            </HoverBalloon>
          )}
        </div>
        <div className={styles.right}>
          <StateTag state={pr.state} isDraft={pr.isDraft} />
          {pr.mergeable === "CONFLICTING" && (
            <span className={styles.icon} data-tooltip="Pull request cannot be merged">
              <Icon name="review-non-mergeable" size={16} />
            </span>
          )}
          {assignees.length > 0 && (
            <HoverBalloon title={assigneesTitle(assignees.length)} items={assigneeItems} className={styles.icon}>
              <AvatarStack
                max={MAX_AVATARS}
                size={AVATAR_SIZE.BASE}
                items={assignees.map((u) => ({ key: u.id || u.login, url: u.avatarUrl, name: u.login }))}
                title={null}
              />
            </HoverBalloon>
          )}
          {reviewers.length > 0 && (
            <HoverBalloon title={reviewersTitle(reviewers.length)} items={reviewerItems} className={styles.icon}>
              <AvatarStack
                max={MAX_AVATARS}
                size={AVATAR_SIZE.OUTLINED}
                items={reviewers.map((r) => ({
                  key: r.key,
                  url: r.avatarUrl,
                  name: r.name,
                  ring: reviewerRingColor(r.state),
                }))}
                title={null}
              />
            </HoverBalloon>
          )}
          <span className={styles.comments} data-tooltip={unresolvedCommentsTooltip(comments)}>
            <Icon name="review-comment" size={16} />
            {comments}
          </span>
        </div>
      </div>
      <div className={styles.info}>{infoLine(pr.number, prettyDate(pr.createdAt), pr.author?.login)}</div>
    </div>
  );
});
