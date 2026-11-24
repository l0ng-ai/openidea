import clsx from "clsx";
import { Icon } from "@/ui";
import { tx } from "@/platform/i18n";
import type { SyncDirection } from "./syncCommits";
import styles from "./BranchSync.module.css";

interface BranchSyncProps {
  ahead: number;
  behind: number;
  unfetched?: boolean;
  incomingRepositories?: number;
  outgoingRepositories?: number;
  /** Include the commit counts; the title-bar widget passes false and keeps them in the tooltip. */
  showCounts?: boolean;
  className?: string;
  /** The markers open their commit list: a click picks the direction instead of the widget's action. */
  onSelect?: (direction: SyncDirection) => void;
}

/** Incoming / outgoing branch markers shared by the branch widget, popup and Git Log tree. */
export function BranchSync({
  ahead,
  behind,
  unfetched,
  incomingRepositories = 0,
  outgoingRepositories = 0,
  showCounts = true,
  className,
  onSelect,
}: BranchSyncProps) {
  if (ahead <= 0 && behind <= 0 && !unfetched) return null;
  return (
    <span className={clsx(styles.sync, className)}>
      {(behind > 0 || unfetched) && (
        <BranchSyncItem
          count={behind > 0 ? behind : null}
          direction="incoming"
          repositories={incomingRepositories}
          unfetched={unfetched}
          showCount={showCounts}
          onSelect={onSelect}
        />
      )}
      {ahead > 0 && (
        <BranchSyncItem
          count={ahead}
          direction="outgoing"
          repositories={outgoingRepositories}
          showCount={showCounts}
          onSelect={onSelect}
        />
      )}
    </span>
  );
}

function BranchSyncItem({
  count,
  direction,
  repositories,
  unfetched,
  showCount,
  onSelect,
}: {
  count: number | null;
  direction: SyncDirection;
  repositories: number;
  unfetched?: boolean;
  showCount: boolean;
  onSelect?: (direction: SyncDirection) => void;
}) {
  let commits = "";
  if (count !== null) {
    commits =
      repositories > 1
        ? direction === "incoming"
          ? tx`${count} incoming commits in ${repositories} repositories`
          : tx`${count} outgoing commits in ${repositories} repositories`
        : direction === "incoming"
          ? tx`${count} incoming commits`
          : tx`${count} outgoing commits`;
  }
  const label = [commits, unfetched ? tx("Remote changes available to fetch") : ""].filter(Boolean).join("\n");
  return (
    <span
      className={clsx(styles.item, styles[direction], onSelect && styles.selectable)}
      role="img"
      aria-label={label}
      title={label}
      data-sync-direction={direction}
      onClick={
        onSelect
          ? (e) => {
              // The widget button would open the branches popup; the marker opens the commit list.
              e.stopPropagation();
              onSelect(direction);
            }
          : undefined
      }
    >
      <Icon name={direction === "incoming" ? "vcs-incoming" : "vcs-outgoing"} size={12} />
      {showCount && count !== null && <span>{count > 99 ? "99+" : count}</span>}
    </span>
  );
}
