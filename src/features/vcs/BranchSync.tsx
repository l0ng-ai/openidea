import clsx from "clsx";
import { Icon } from "@/ui";
import { tx } from "@/platform/i18n";
import type { SyncDirection } from "./syncCommits";
import styles from "./BranchSync.module.css";

interface BranchSyncProps {
  ahead: number;
  behind: number;
  /** Include the commit counts; the title-bar widget passes false and keeps them in the tooltip. */
  showCounts?: boolean;
  className?: string;
  /** The markers open their commit list: a click picks the direction instead of the widget's action. */
  onSelect?: (direction: SyncDirection) => void;
}

/** Incoming / outgoing branch markers shared by the branch widget, popup and Git Log tree. */
export function BranchSync({ ahead, behind, showCounts = true, className, onSelect }: BranchSyncProps) {
  if (ahead <= 0 && behind <= 0) return null;
  return (
    <span className={clsx(styles.sync, className)}>
      {behind > 0 && <BranchSyncItem count={behind} direction="incoming" showCount={showCounts} onSelect={onSelect} />}
      {ahead > 0 && <BranchSyncItem count={ahead} direction="outgoing" showCount={showCounts} onSelect={onSelect} />}
    </span>
  );
}

function BranchSyncItem({
  count,
  direction,
  showCount,
  onSelect,
}: {
  count: number;
  direction: SyncDirection;
  showCount: boolean;
  onSelect?: (direction: SyncDirection) => void;
}) {
  const label = direction === "incoming" ? tx`${count} incoming commits` : tx`${count} outgoing commits`;
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
      {showCount && <span>{count}</span>}
    </span>
  );
}
