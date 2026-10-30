/**
 * Reviewers, assignees and labels of the new pull request (`LabeledListComponentsFactory`
 * grid): a grey label ("Reviewers:", or "No reviewers" while empty), the chosen items
 * with avatars or label colours and an edit button opening a multi-select chooser above.
 */
import { useState, type ReactNode } from "react";
import { IconButton } from "@/ui";
import { useTx } from "@/platform/i18n";
import type { GHLabel, GHPullRequestRequestedReviewer, GHUser } from "../api/types";
import { isTeam, reviewerKey } from "../data/model";
import { usePotentialReviewers, useGhRepository, useRepositoryList } from "../data/repository";
import { Avatar, AVATAR_SIZE } from "../ui/Avatar";
import { ChooserPopup, type ChooserItemPresentation } from "../ui/ChooserPopup";
import { LabelChip, LabelSwatch } from "../ui/chips";
import { selectableReviewers, setAssignees, setLabels, setReviewers, useCreatePr } from "./store";
import styles from "./Create.module.css";

interface ListRowProps<T> {
  label: string;
  emptyLabel: string;
  items: readonly T[];
  getKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  chooser: (anchor: HTMLElement, close: () => void) => ReactNode;
}

function ListRow<T>(props: ListRowProps<T>) {
  const tx = useTx();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const label = props.items.length ? props.label : props.emptyLabel;
  return (
    <>
      <div className={styles.metaLabel}>{tx(label)}</div>
      <div className={styles.metaList}>
        {props.items.map((item) => (
          <span key={props.getKey(item)} className={styles.metaItem}>
            {props.renderItem(item)}
          </span>
        ))}
        <IconButton icon="edit" size="small" title="Edit" onClick={(e) => setAnchor(e.currentTarget)} />
        {anchor && props.chooser(anchor, () => setAnchor(null))}
      </div>
    </>
  );
}

const userPresentation = (u: GHUser): ChooserItemPresentation => ({
  text: u.login,
  detail: u.name,
  avatarUrl: u.avatarUrl,
});

function reviewerPresentation(r: GHPullRequestRequestedReviewer): ChooserItemPresentation {
  if (isTeam(r)) return { text: r.slug, detail: r.teamName, avatarUrl: r.teamAvatarUrl };
  return { text: r.login, detail: r.name ?? null, avatarUrl: r.avatarUrl };
}

function UserItem({ text, avatarUrl }: { text: string; avatarUrl?: string | null }) {
  return (
    <span className={styles.userItem}>
      <Avatar url={avatarUrl} name={text} size={AVATAR_SIZE.BASE} />
      <span>{text}</span>
    </span>
  );
}

export function MetadataGrid() {
  const reviewers = useCreatePr((s) => s.reviewers);
  const assignees = useCreatePr((s) => s.assignees);
  const labels = useCreatePr((s) => s.labels);
  const me = useGhRepository((s) => s.connection?.currentUser);
  const potentialReviewers = usePotentialReviewers();
  const potentialAssignees = useRepositoryList("assignees");
  const repoLabels = useRepositoryList("labels");
  return (
    <div className={styles.metadata}>
      <ListRow
        label="Reviewers:"
        emptyLabel="No reviewers"
        items={reviewers}
        getKey={reviewerKey}
        renderItem={(r) => <UserItem {...reviewerPresentation(r)} />}
        chooser={(anchor, close) => (
          <ChooserPopup<GHPullRequestRequestedReviewer>
            mode="multi"
            anchor={anchor}
            placement="top-start"
            items={selectableReviewers(potentialReviewers.items, me)}
            loading={potentialReviewers.loading}
            error={potentialReviewers.error}
            chosen={reviewers}
            getKey={reviewerKey}
            present={reviewerPresentation}
            aria-label="Reviewers"
            onClose={(chosen) => {
              setReviewers(chosen);
              close();
            }}
          />
        )}
      />
      <ListRow
        label="Assignees:"
        emptyLabel="Unassigned"
        items={assignees}
        getKey={(u) => u.login}
        renderItem={(u) => <UserItem text={u.login} avatarUrl={u.avatarUrl} />}
        chooser={(anchor, close) => (
          <ChooserPopup<GHUser>
            mode="multi"
            anchor={anchor}
            placement="top-start"
            items={potentialAssignees.items}
            loading={potentialAssignees.loading}
            error={potentialAssignees.error}
            chosen={assignees}
            getKey={(u) => u.login}
            present={userPresentation}
            aria-label="Assignees"
            onClose={(chosen) => {
              setAssignees(chosen);
              close();
            }}
          />
        )}
      />
      <ListRow
        label="Labels:"
        emptyLabel="No labels"
        items={labels}
        getKey={(l) => l.name}
        renderItem={(l) => <LabelChip label={l} />}
        chooser={(anchor, close) => (
          <ChooserPopup<GHLabel>
            mode="multi"
            anchor={anchor}
            placement="top-start"
            items={repoLabels.items}
            loading={repoLabels.loading}
            error={repoLabels.error}
            chosen={labels}
            getKey={(l) => l.name}
            present={(l) => ({ text: l.name, leading: <LabelSwatch label={l} /> })}
            aria-label="Labels"
            onClose={(chosen) => {
              setLabels(chosen);
              close();
            }}
          />
        )}
      />
    </div>
  );
}
