/** The merge editor's toolbar and the buttons along its bottom, after IntelliJ's merge dialog. */
import clsx from "clsx";
import { tx } from "@/platform/i18n";
import { Button, IconButton, T } from "@/ui";
import type { MergeCommand } from "./mergeActions";
import type { MergeSummary } from "./mergeModel";
import styles from "./MergeEditor.module.css";

export interface ToolbarProps {
  summary: MergeSummary;
  /** Moves between the unresolved changes of this merge editor. */
  step: (dir: 1 | -1) => void;
  /** Runs a command on this merge editor, whether or not it has focus. */
  run: (command: MergeCommand) => void;
}

/** Runs the button's command on its own editor; the action only supplies title and shortcut. */
const direct = (run: () => void) => (e: React.MouseEvent) => {
  e.preventDefault();
  run();
};

function statusText({ pending, conflicts }: MergeSummary) {
  if (!pending) return tx("All changes processed");
  const left = pending === 1 ? tx`${pending} change left` : tx`${pending} changes left`;
  if (!conflicts) return left;
  return `${left}, ${conflicts === 1 ? tx`${conflicts} conflict` : tx`${conflicts} conflicts`}`;
}

export function MergeToolbar({ summary, step, run }: ToolbarProps) {
  return (
    <div className={styles.toolbar} role="toolbar" aria-label={tx("Merge")}>
      <IconButton
        icon="arrow-up"
        title="Previous Change"
        action="diff.prevDifference"
        size="small"
        disabled={!summary.pending}
        onClick={direct(() => step(-1))}
      />
      <IconButton
        icon="arrow-down"
        title="Next Change"
        action="diff.nextDifference"
        size="small"
        disabled={!summary.pending}
        onClick={direct(() => step(1))}
      />
      <span className={styles.sep} />
      <IconButton
        icon="diff-apply-left"
        title="Apply Non-Conflicting Changes from the Left Side"
        size="small"
        disabled={!summary.left}
        action="merge.applyLeft"
        onClick={direct(() => run("applyLeft"))}
      />
      <IconButton
        icon="diff-apply-all"
        title="Apply All Non-Conflicting Changes"
        size="small"
        disabled={!summary.all}
        action="merge.applyAll"
        onClick={direct(() => run("applyAll"))}
      />
      <IconButton
        icon="diff-apply-right"
        title="Apply Non-Conflicting Changes from the Right Side"
        size="small"
        disabled={!summary.right}
        action="merge.applyRight"
        onClick={direct(() => run("applyRight"))}
      />
      <IconButton
        icon="diff-magic-toolbar"
        title="Resolve Simple Conflicts"
        size="small"
        disabled={!summary.simple}
        action="merge.resolveSimple"
        onClick={direct(() => run("resolveSimple"))}
      />
      <IconButton
        icon="diff-revert"
        iconSize={14}
        title="Revert Conflict Resolution"
        size="small"
        disabled={!summary.revert}
        action="merge.revert"
        onClick={direct(() => run("revert"))}
      />
      <span className={styles.sep} />
      <IconButton
        icon="diff"
        title="Compare Contents"
        size="small"
        action="merge.compare"
        onClick={direct(() => run("compare"))}
        data-merge-menu="compare"
      />
      <span className={clsx(styles.status, !summary.pending && styles.statusDone)} role="status">
        {statusText(summary)}
      </span>
      <IconButton
        icon="refresh"
        title="Reload from Disk"
        size="small"
        action="merge.reload"
        onClick={direct(() => run("reload"))}
      />
      <IconButton
        icon="settings"
        title="Settings"
        size="small"
        action="merge.settings"
        onClick={direct(() => run("settings"))}
        data-merge-menu="settings"
      />
    </div>
  );
}

export function MergeFooter({ run }: Pick<ToolbarProps, "run">) {
  return (
    <div className={styles.footer}>
      <div className={styles.footerGroup}>
        <Button onClick={() => run("acceptYours")}>
          <T>Accept Yours</T>
        </Button>
        <Button onClick={() => run("acceptTheirs")}>
          <T>Accept Theirs</T>
        </Button>
      </div>
      <div className={styles.footerGroup}>
        <Button onClick={() => run("cancel")}>
          <T>Cancel</T>
        </Button>
        <Button variant="primary" onClick={() => run("apply")}>
          <T>Apply</T>
        </Button>
      </div>
    </div>
  );
}
