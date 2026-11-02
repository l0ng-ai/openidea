/** The merge editor's toolbar and the buttons along its bottom, after IntelliJ's merge dialog. */
import clsx from "clsx";
import { tx } from "@/platform/i18n";
import { shortcutLabel } from "@/platform/keymap";
import { Button, IconButton, T } from "@/ui";
import { applyNonConflicting, resolveSimple, revertResolved, type MergeSummary } from "./mergeModel";
import type { RunCommand } from "./mergeMenus";
import styles from "./MergeEditor.module.css";

export interface ToolbarProps {
  summary: MergeSummary;
  goto(dir: 1 | -1): void;
  run: RunCommand;
  onCompare(e: React.MouseEvent): void;
  onReload(): void;
  onSettings(e: React.MouseEvent): void;
}

function statusText({ pending, conflicts }: MergeSummary) {
  if (!pending) return tx("All changes processed");
  const left = pending === 1 ? tx`${pending} change left` : tx`${pending} changes left`;
  if (!conflicts) return left;
  return `${left}, ${conflicts === 1 ? tx`${conflicts} conflict` : tx`${conflicts} conflicts`}`;
}

export function MergeToolbar({ summary, goto, run, onCompare, onReload, onSettings }: ToolbarProps) {
  return (
    <div className={styles.toolbar} role="toolbar" aria-label={tx("Merge")}>
      <IconButton
        icon="arrow-up"
        title="Previous Change"
        shortcut={shortcutLabel("diff.prevDifference")}
        size="small"
        onClick={() => goto(-1)}
      />
      <IconButton
        icon="arrow-down"
        title="Next Change"
        shortcut={shortcutLabel("diff.nextDifference")}
        size="small"
        onClick={() => goto(1)}
      />
      <span className={styles.sep} />
      <IconButton
        icon="diff-apply-left"
        title="Apply Non-Conflicting Changes from the Left Side"
        size="small"
        disabled={!summary.left}
        onClick={() => run((s) => applyNonConflicting(s, "left"), true)}
      />
      <IconButton
        icon="diff-apply-all"
        title="Apply All Non-Conflicting Changes"
        size="small"
        disabled={!summary.all}
        onClick={() => run((s) => applyNonConflicting(s, "base"), true)}
      />
      <IconButton
        icon="diff-apply-right"
        title="Apply Non-Conflicting Changes from the Right Side"
        size="small"
        disabled={!summary.right}
        onClick={() => run((s) => applyNonConflicting(s, "right"), true)}
      />
      <IconButton
        icon="diff-magic-toolbar"
        title="Resolve Simple Conflicts"
        size="small"
        disabled={!summary.simple}
        onClick={() => run(resolveSimple, true)}
      />
      <IconButton
        icon="diff-revert"
        title="Revert Conflict Resolution"
        size="small"
        disabled={!summary.revert}
        onClick={() => run(revertResolved, true)}
      />
      <span className={styles.sep} />
      <IconButton icon="diff" title="Compare Contents" size="small" onClick={onCompare} />
      <span className={clsx(styles.status, !summary.pending && styles.statusDone)}>{statusText(summary)}</span>
      <IconButton icon="refresh" title="Reload from Disk" size="small" onClick={onReload} />
      <IconButton icon="settings" title="Settings" size="small" onClick={onSettings} />
    </div>
  );
}

export interface FooterProps {
  onAccept(side: "left" | "right"): void;
  onCancel(): void;
  onApply(): void;
}

export function MergeFooter({ onAccept, onCancel, onApply }: FooterProps) {
  return (
    <div className={styles.footer}>
      <div className={styles.footerGroup}>
        <Button onClick={() => onAccept("left")}>
          <T>Accept Yours</T>
        </Button>
        <Button onClick={() => onAccept("right")}>
          <T>Accept Theirs</T>
        </Button>
      </div>
      <div className={styles.footerGroup}>
        <Button onClick={onCancel}>
          <T>Cancel</T>
        </Button>
        <Button variant="primary" onClick={onApply}>
          <T>Apply</T>
        </Button>
      </div>
    </div>
  );
}
