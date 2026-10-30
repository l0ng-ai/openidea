/**
 * The timeline's items (`GHPRTimelineItemComponentFactory`, `GHPRTimelineEventComponentFactoryImpl`):
 * conversation comments, reviews with their status and threads, grouped commits, and the
 * events with IntelliJ's texts — merged simple events as stacked paragraphs, merged state
 * events as their last state.
 */
import type { ReactNode } from "react";
import { tx, txTemplate, useTx } from "@/platform/i18n";
import type {
  GHActor,
  GHLabel,
  GHPullRequest,
  GHPullRequestRequestedReviewer,
  GHPullRequestReviewThread,
  GHReferencedSubject,
} from "../api/types";
import { GHOST_USER } from "../data/model";
import { openInBrowser } from "../data/local";
import { deleteIssueComment, toggleReaction, updateIssueComment, updateReviewBody } from "../data/operations";
import { sameRepository, useGhRepository } from "../data/repository";
import { openPullRequest } from "../toolwindow/open";
import { BranchChip, LabelChip } from "../ui/chips";
import { Markdown } from "../ui/Markdown";
import { prettyDateTime } from "../ui/prettyDate";
import { ChatItem, CommentItem, ThreadView } from "./comments";
import { joined, rich } from "./comments/ChatItem";
import {
  canEditReview,
  commitsActor,
  effectiveRename,
  presentableName,
  reviewStatus,
  threadReviewId,
  type ComplexEvent,
  type SimpleGroup,
  type StateGroup,
  type StatusType,
  type TimelineCommit,
  type TimelineEntry,
} from "./model";
import cstyles from "./comments/comments.module.css";
import styles from "./Timeline.module.css";

/** A web link (opens the browser). */
export function WebLink({ url, children }: { url: string; children: ReactNode }) {
  return (
    <a
      className={styles.link}
      href={url}
      onClick={(e) => {
        e.preventDefault();
        void openInBrowser(url);
      }}
    >
      {children}
    </a>
  );
}

/** `StatusMessageComponentFactory`: the content with a coloured bar on its left. */
export function StatusLine({ type = "INFO", children }: { type?: StatusType; children: ReactNode }) {
  return (
    <div className={cstyles.status} data-type={type}>
      <div>{children}</div>
    </div>
  );
}

const actorLink = (a: GHActor | GHPullRequestRequestedReviewer | null) => {
  const r = a ?? GHOST_USER;
  return <WebLink url={r.url}>{presentableName(r)}</WebLink>;
};

// ---------------------------------------------------------------------------
// Events

function labelsText(added: GHLabel[], removed: GHLabel[]): ReactNode {
  const a = added.length ? joined(added.map((l) => <LabelChip key={l.id || l.name} label={l} />)) : null;
  const r = removed.length ? joined(removed.map((l) => <LabelChip key={l.id || l.name} label={l} />)) : null;
  if (a && r) return rich(txTemplate("added labels {added} and removed labels {removed}"), { added: a, removed: r });
  if (a) return rich(txTemplate("added labels {labels}"), { labels: a });
  if (r) return rich(txTemplate("removed labels {labels}"), { labels: r });
  return null;
}

function assigneesText(assigned: GHActor[], unassigned: GHActor[]): ReactNode {
  const a = assigned.length ? joined(assigned.map(actorLink)) : null;
  const u = unassigned.length ? joined(unassigned.map(actorLink)) : null;
  if (a && u)
    return rich(txTemplate("assigned {assigned} and unassigned {unassigned}"), { assigned: a, unassigned: u });
  if (a) return rich(txTemplate("assigned {users}"), { users: a });
  if (u) return rich(txTemplate("unassigned {users}"), { users: u });
  return null;
}

function reviewersText(
  added: Array<GHPullRequestRequestedReviewer | null>,
  removed: Array<GHPullRequestRequestedReviewer | null>,
): ReactNode {
  const a = added.length ? joined(added.map(actorLink)) : null;
  const r = removed.length ? joined(removed.map(actorLink)) : null;
  if (a && r)
    return rich(txTemplate("requested a review from {added} and removed review request from {removed}"), {
      added: a,
      removed: r,
    });
  if (a) return rich(txTemplate("requested a review from {reviewers}"), { reviewers: a });
  if (r) return rich(txTemplate("removed review request from {reviewers}"), { reviewers: r });
  return null;
}

const renameText = ([from, to]: [string, string]) =>
  rich(txTemplate("renamed this pull request from '{from}' to '{to}'"), { from, to });

/** An event item: the actor's row with the text in a status line. */
function EventItem({
  actor,
  date,
  type,
  children,
}: {
  actor: GHActor | null;
  date: string | null;
  type?: StatusType;
  children: ReactNode;
}) {
  return (
    <ChatItem author={actor ?? GHOST_USER} date={date}>
      <StatusLine type={type}>{children}</StatusLine>
    </ChatItem>
  );
}

function SimpleEventItem({ group }: { group: SimpleGroup }) {
  const rename = effectiveRename(group);
  const paragraphs = [
    labelsText(group.addedLabels, group.removedLabels),
    assigneesText(group.assigned, group.unassigned),
    reviewersText(group.addedReviewers, group.removedReviewers),
    rename && renameText(rename),
  ].filter(Boolean);
  return (
    <EventItem actor={group.actor} date={group.createdAt}>
      {paragraphs.length === 1
        ? paragraphs[0]
        : paragraphs.map((p, i) => (
            <p key={i} className={styles.paragraph}>
              {p}
            </p>
          ))}
    </EventItem>
  );
}

function StateEventItem({ group }: { group: StateGroup }) {
  const t = useTx();
  if (group.newState === "CLOSED")
    return (
      <EventItem actor={group.actor} date={group.createdAt} type="SECONDARY_INFO">
        {t("closed this")}
      </EventItem>
    );
  if (group.newState === "OPEN")
    return (
      <EventItem actor={group.actor} date={group.createdAt}>
        {t("reopened this")}
      </EventItem>
    );
  const merged = group.last.__typename === "MergedEvent" ? group.last : null;
  const commit = merged?.mergedEventCommit;
  return (
    <EventItem actor={group.actor} date={group.createdAt} type="SUCCESS">
      {commit && merged
        ? rich(txTemplate("merged commit {commit} into {branch}"), {
            commit: <WebLink url={commit.url}>{commit.abbreviatedOid}</WebLink>,
            branch: <BranchChip name={merged.mergeRefName} className={styles.branch} />,
          })
        : t("merged this")}
    </EventItem>
  );
}

/** A referenced issue or pull request: "Title #N", the number opening it (in the IDE when it is of this repository). */
function ReferenceLink({ subject }: { subject: GHReferencedSubject }) {
  const repo = useGhRepository((s) => s.connection?.coordinates ?? null);
  const local = subject.__typename === "PullRequest" && sameRepository(repo, repoOfUrl(subject.url));
  return (
    <div>
      {subject.title}&nbsp;
      <a
        className={styles.link}
        href={subject.url}
        onClick={(e) => {
          e.preventDefault();
          if (local) void openPullRequest(subject.number);
          else void openInBrowser(subject.url);
        }}
      >
        #{subject.number}
      </a>
    </div>
  );
}

function repoOfUrl(url: string) {
  const m = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\//.exec(url);
  return m ? { owner: m[1]!, name: m[2]! } : null;
}

function ComplexEventItem({ event }: { event: ComplexEvent }) {
  const t = useTx();
  const at = { actor: event.actor, date: event.createdAt };
  const branch = (name: string) => <BranchChip name={name} className={styles.branch} />;
  switch (event.__typename) {
    case "BaseRefChangedEvent":
      return <EventItem {...at}>{t("changed the base branch")}</EventItem>;
    case "BaseRefForcePushedEvent":
    case "HeadRefForcePushedEvent":
      return (
        <EventItem {...at}>
          {rich(txTemplate("force-pushed the {branch} branch"), {
            branch: event.ref
              ? branch(event.ref.name)
              : event.__typename === "BaseRefForcePushedEvent"
                ? "base"
                : "head",
          })}
        </EventItem>
      );
    case "HeadRefDeletedEvent":
      return (
        <EventItem {...at}>
          {rich(txTemplate("deleted the {branch} branch"), { branch: branch(event.headRefName) })}
        </EventItem>
      );
    case "HeadRefRestoredEvent":
      return <EventItem {...at}>{t("restored head branch")}</EventItem>;
    case "ReviewDismissedEvent": {
      const login = (event.review?.author ?? GHOST_USER).login;
      return (
        <EventItem {...at}>
          {rich(txTemplate("dismissed {login}'s stale review"), { login: <b>{login}</b> })}
          {event.dismissalMessageHTML && <Markdown text={event.dismissalMessageHTML} />}
        </EventItem>
      );
    }
    case "ReadyForReviewEvent":
      return <EventItem {...at}>{t("marked this pull request as ready for review")}</EventItem>;
    case "ConvertToDraftEvent":
      return <EventItem {...at}>{t("marked this pull request as draft")}</EventItem>;
    case "CrossReferencedEvent":
    case "ConnectedEvent":
    case "DisconnectedEvent": {
      const title =
        event.__typename === "CrossReferencedEvent"
          ? t("mentioned this pull request")
          : event.__typename === "ConnectedEvent"
            ? t("linked an issue that may be closed by this")
            : t("removed a link to an issue");
      const subject = event.__typename === "CrossReferencedEvent" ? event.source : event.subject;
      return (
        <ChatItem author={event.actor ?? GHOST_USER} date={event.createdAt}>
          <div>{title}</div>
          <StatusLine>
            <ReferenceLink subject={subject} />
          </StatusLine>
        </ChatItem>
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Commits, comments, reviews

function CommitsItem({ commits, prAuthor }: { commits: TimelineCommit[]; prAuthor: GHActor | null }) {
  const t = useTx();
  const n = commits.length;
  const single = n === 1 ? commits[0]!.commit.author : null;
  return (
    <ChatItem author={commitsActor(commits, prAuthor) ?? GHOST_USER} date={single?.date ?? null}>
      <div>{n === 1 ? t("added a commit to this pull request") : tx`added ${n} commits to this pull request`}</div>
      <StatusLine>
        <div className={styles.commits}>
          {commits.map(({ commit }) => {
            const author = commit.author;
            const actor = author ? (author.user ?? GHOST_USER) : null;
            return (
              <div key={commit.oid} className={styles.commit}>
                <p className={styles.paragraph}>
                  <WebLink url={commit.url}>{commit.abbreviatedOid}</WebLink>&nbsp;{commit.messageHeadline}
                </p>
                {actor && (
                  <p className={styles.paragraph}>
                    {actorLink(actor)}
                    {author?.date && <>&nbsp;{prettyDateTime(author.date)}</>}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </StatusLine>
    </ChatItem>
  );
}

function ReviewItem({
  number,
  review,
  threads,
}: {
  number: number;
  review: Extract<TimelineEntry, { kind: "review" }>["review"];
  threads: GHPullRequestReviewThread[] | undefined;
}) {
  const t = useTx();
  const status = reviewStatus(review.state);
  const own = threads?.filter((th) => threadReviewId(th) === review.id);
  return (
    <div>
      <CommentItem
        author={review.author}
        createdAt={review.createdAt}
        body={review.body}
        canEdit={canEditReview(review)}
        onSave={(body) => updateReviewBody(number, review.id, body)}
        footer={<StatusLine type={status.type}>{t(status.text)}</StatusLine>}
      />
      {own === undefined ? (
        <div className={styles.loadingThreads}>{t("Loading…")}</div>
      ) : (
        own.map((th) => <ThreadView key={th.id} number={number} thread={th} variant="full" />)
      )}
    </div>
  );
}

/** One timeline entry. */
export function TimelineItem({
  entry,
  pr,
  threads,
}: {
  entry: TimelineEntry;
  pr: GHPullRequest;
  threads: GHPullRequestReviewThread[] | undefined;
}) {
  const number = pr.number;
  switch (entry.kind) {
    case "comment": {
      const c = entry.comment;
      return (
        <CommentItem
          author={c.author}
          createdAt={c.createdAt}
          body={c.body}
          reactions={c.reactions.nodes}
          canEdit={c.viewerCanUpdate}
          canDelete={c.viewerCanDelete}
          canReact={c.viewerCanReact}
          onSave={(body) => updateIssueComment(number, c.id, body)}
          onDelete={() => deleteIssueComment(number, c.id)}
          onToggleReaction={(content, add) => toggleReaction(number, c.id, content, add, "timeline")}
        />
      );
    }
    case "review":
      return <ReviewItem number={number} review={entry.review} threads={threads} />;
    case "commits":
      return <CommitsItem commits={entry.commits} prAuthor={pr.author} />;
    case "simple":
      return <SimpleEventItem group={entry} />;
    case "state":
      return <StateEventItem group={entry} />;
    case "event":
      return <ComplexEventItem event={entry.event} />;
    case "unknown": {
      const type = entry.type;
      return (
        <ChatItem author={pr.author ?? GHOST_USER} date={null}>
          {tx`Cannot display item - ${type}`}
        </ChatItem>
      );
    }
  }
}
