/**
 * The review group at the editor's top-right (`ReviewInEditorUtil.showReviewToolbarWithActions`
 * with `CodeReviewInEditorToolbarActionGroup`): Previous / Next Comment, then "Review Mode"
 * (a warning icon when the branch is out of sync; only the eye while review mode is off)
 * opening its menu: "Update Branch to Enable Review Mode…" (out of sync), "Disable Review
 * Mode", "Show Unresolved Comments Only", "Show All Comments".
 */
import { useRef, useState } from "react";
import clsx from "clsx";
import { tx } from "@/platform/i18n";
import { Icon, Menu, tooltipAttrs, type MenuItem } from "@/ui";
import type { ReviewEditor } from "./editor";
import { setEditorThreadsOption, setReviewModeEnabled, useReviewModeSettings } from "./settings";
import { updateReviewBranch, useReviewBranch } from "./state";
import styles from "./ReviewMode.module.css";

export function ReviewModeToolbar({ editor }: { editor: ReviewEditor }) {
  const { enabled, threads } = useReviewModeSettings();
  const updateRequired = useReviewBranch((s) => s.updateRequired);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const shown = enabled && !updateRequired;
  const items: MenuItem[] = [
    ...(updateRequired
      ? [
          { label: "Update Branch to Enable Review Mode…", icon: "branch", run: () => void updateReviewBranch() },
          { kind: "separator" as const },
        ]
      : []),
    { label: "Disable Review Mode", checked: !enabled, run: () => setReviewModeEnabled(false) },
    {
      label: "Show Unresolved Comments Only",
      checked: enabled && threads === "unresolved",
      run: () => {
        setReviewModeEnabled(true);
        setEditorThreadsOption("unresolved");
      },
    },
    {
      label: "Show All Comments",
      checked: enabled && threads === "all",
      run: () => {
        setReviewModeEnabled(true);
        setEditorThreadsOption("all");
      },
    },
  ];
  return (
    <div className={styles.toolbar} role="toolbar" aria-label={tx("Review Mode")}>
      {shown && (
        <>
          <button
            type="button"
            className={styles.button}
            aria-label={tx("Previous Comment")}
            {...tooltipAttrs(tx("Previous Comment"))}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void editor.gotoComment(-1)}
          >
            <Icon name="arrow-up" size={14} />
          </button>
          <button
            type="button"
            className={styles.button}
            aria-label={tx("Next Comment")}
            {...tooltipAttrs(tx("Next Comment"))}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void editor.gotoComment(1)}
          >
            <Icon name="arrow-down" size={14} />
          </button>
        </>
      )}
      <button
        ref={ref}
        type="button"
        className={clsx(styles.button, enabled && styles.text)}
        aria-label={tx("Configure review mode")}
        aria-haspopup="menu"
        aria-expanded={open}
        data-review-mode={enabled ? (updateRequired ? "outOfSync" : "on") : "off"}
        {...tooltipAttrs(tx("In Review Mode, you can see review comments and proposed changes right in the editor"))}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
      >
        {enabled ? (
          <>
            {updateRequired && <Icon name="warning" size={14} className={styles.warning} />}
            {tx("Review Mode")}
          </>
        ) : (
          <Icon name="eye" size={14} />
        )}
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchor={ref} items={items} placement="bottom-end" />
    </div>
  );
}
