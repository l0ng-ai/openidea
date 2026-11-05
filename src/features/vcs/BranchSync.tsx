import clsx from "clsx";
import { Icon } from "@/ui";
import { tx } from "@/platform/i18n";
import styles from "./BranchSync.module.css";

interface BranchSyncProps {
  ahead: number;
  behind: number;
  /** Include the commit counts; the title-bar widget passes false and keeps them in the tooltip. */
  showCounts?: boolean;
  className?: string;
}

/** Incoming / outgoing branch markers shared by the branch widget, popup and Git Log tree. */
export function BranchSync({ ahead, behind, showCounts = true, className }: BranchSyncProps) {
  if (ahead <= 0 && behind <= 0) return null;
  return (
    <span className={clsx(styles.sync, className)}>
      {behind > 0 && <BranchSyncItem count={behind} direction="incoming" showCount={showCounts} />}
      {ahead > 0 && <BranchSyncItem count={ahead} direction="outgoing" showCount={showCounts} />}
    </span>
  );
}

function BranchSyncItem({
  count,
  direction,
  showCount,
}: {
  count: number;
  direction: "incoming" | "outgoing";
  showCount: boolean;
}) {
  const label = direction === "incoming" ? tx`${count} incoming commits` : tx`${count} outgoing commits`;
  return (
    <span className={clsx(styles.item, styles[direction])} role="img" aria-label={label} title={label}>
      <Icon name={direction === "incoming" ? "vcs-incoming" : "vcs-outgoing"} size={12} />
      {showCount && <span className={styles.count}>{count}</span>}
    </span>
  );
}
