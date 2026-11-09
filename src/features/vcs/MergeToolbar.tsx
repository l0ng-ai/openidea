/** The merge editor's toolbar and the buttons along its bottom, after IntelliJ's merge dialog. */
import clsx from "clsx";
import { tx } from "@/platform/i18n";
import { executeAction } from "@/platform/actions";
import { Button, IconButton, T } from "@/ui";
import type { MergeSummary } from "./mergeModel";
import styles from "./MergeEditor.module.css";

export interface ToolbarProps {
  summary: MergeSummary;
}

function statusText({ pending, conflicts }: MergeSummary) {
  if (!pending) return tx("All changes processed");
  const left = pending === 1 ? tx`${pending} change left` : tx`${pending} changes left`;
  if (!conflicts) return left;
  return `${left}, ${conflicts === 1 ? tx`${conflicts} conflict` : tx`${conflicts} conflicts`}`;
}

export function MergeToolbar({ summary }: ToolbarProps) {
  return (
    <div className={styles.toolbar} role="toolbar" aria-label={tx("Merge")}>
      <IconButton icon="arrow-up" title="Previous Change" action="diff.prevDifference" size="small" />
      <IconButton icon="arrow-down" title="Next Change" action="diff.nextDifference" size="small" />
      <span className={styles.sep} />
      <IconButton
        icon="diff-apply-left"
        title="Apply Non-Conflicting Changes from the Left Side"
        size="small"
        disabled={!summary.left}
        action="merge.applyLeft"
      />
      <IconButton
        icon="diff-apply-all"
        title="Apply All Non-Conflicting Changes"
        size="small"
        disabled={!summary.all}
        action="merge.applyAll"
      />
      <IconButton
        icon="diff-apply-right"
        title="Apply Non-Conflicting Changes from the Right Side"
        size="small"
        disabled={!summary.right}
        action="merge.applyRight"
      />
      <IconButton
        icon="diff-magic-toolbar"
        title="Resolve Simple Conflicts"
        size="small"
        disabled={!summary.simple}
        action="merge.resolveSimple"
      />
      <IconButton
        icon="diff-revert"
        title="Revert Conflict Resolution"
        size="small"
        disabled={!summary.revert}
        action="merge.revert"
      />
      <span className={styles.sep} />
      <IconButton icon="diff" title="Compare Contents" size="small" action="merge.compare" data-merge-menu="compare" />
      <span className={clsx(styles.status, !summary.pending && styles.statusDone)}>{statusText(summary)}</span>
      <IconButton icon="refresh" title="Reload from Disk" size="small" action="merge.reload" />
      <IconButton icon="settings" title="Settings" size="small" action="merge.settings" data-merge-menu="settings" />
    </div>
  );
}

export function MergeFooter() {
  return (
    <div className={styles.footer}>
      <div className={styles.footerGroup}>
        <Button onClick={() => void executeAction("merge.acceptYours")}>
          <T>Accept Yours</T>
        </Button>
        <Button onClick={() => void executeAction("merge.acceptTheirs")}>
          <T>Accept Theirs</T>
        </Button>
      </div>
      <div className={styles.footerGroup}>
        <Button onClick={() => void executeAction("merge.cancel")}>
          <T>Cancel</T>
        </Button>
        <Button variant="primary" onClick={() => void executeAction("merge.apply")}>
          <T>Apply</T>
        </Button>
      </div>
    </div>
  );
}
