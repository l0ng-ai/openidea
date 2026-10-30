/**
 * The head branch widget (`CodeReviewDetailsBranchComponentFactory`): the branch icon
 * (the current-branch icon once the head branch is checked out) and a dropdown link with
 * the head branch (`owner:branch` for forks and equal names). Its popup lists Checkout,
 * Open in Worktree (when the branch is not checked out), Show in Git Log and Copy Branch
 * Name, with the "{base} ← {head}" note below.
 */
import { useRef, useState } from "react";
import clsx from "clsx";
import { Icon, List, Popup } from "@/ui";
import { useTx } from "@/platform/i18n";
import type { GHPullRequest } from "../api/types";
import { checkoutPullRequest, openInWorktree } from "../data/local";
import { copyBranchName, showInGitLog } from "./flow";
import { headBranchLabel } from "./model";
import styles from "./Details.module.css";

type BranchAction = "checkout" | "worktree" | "log" | "copy";

export function BranchWidget({
  pr,
  checkedOut,
  headRemote,
  hasRemoteBranch = true,
}: {
  pr: GHPullRequest;
  checkedOut: boolean;
  /** The local remote of the head repository, for Show in Git Log. */
  headRemote: string | null;
  /** GitHub always has the head branch remotely (`CodeReviewBranches.hasRemoteBranch`). */
  hasRemoteBranch?: boolean;
}) {
  const tx = useTx();
  const anchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const source = headBranchLabel(pr);
  const actions: BranchAction[] = ["checkout", ...(checkedOut ? [] : ["worktree" as const]), "log", "copy"];
  const label: Record<BranchAction, string> = {
    checkout: hasRemoteBranch ? tx("Checkout") : tx("Checkout as detached HEAD"),
    worktree: tx("Open in Worktree"),
    log: tx("Show in Git Log"),
    copy: tx("Copy Branch Name"),
  };
  const run = (a: BranchAction) => {
    setOpen(false);
    if (a === "checkout") void checkoutPullRequest(pr.number);
    else if (a === "worktree") void openInWorktree(pr.number);
    else if (a === "log") void showInGitLog(pr, headRemote);
    else void copyBranchName(source);
  };
  return (
    <div ref={anchor} className={styles.branch}>
      <button type="button" className={styles.branchIcon} aria-label={tx("Branches")} onClick={() => setOpen(true)}>
        <Icon name={checkedOut ? "current-branch-label" : "branch-label"} size={16} />
      </button>
      <button
        type="button"
        className={clsx(styles.link, styles.dropdownLink, styles.branchLink)}
        title={source}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span className={styles.ellipsis}>{source}</span>
        <Icon name="chevron-down" size={12} />
      </button>
      {open && (
        <Popup
          open
          anchor={anchor}
          placement="bottom-start"
          onClose={() => setOpen(false)}
          aria-label={tx("Branches")}
          className={styles.branchPopup}
        >
          <List
            items={actions}
            getKey={(a) => a}
            onActivate={(a) => run(a)}
            hoverSelects
            rowHeight={24}
            aria-label={tx("Branches")}
            renderItem={(a, state) => (
              <div className={styles.popupRow} data-active={state.active || undefined}>
                {label[a]}
              </div>
            )}
          />
          <div className={styles.advertiser}>
            {hasRemoteBranch ? (
              tx`${pr.baseRefName} ← ${source}`
            ) : (
              <>
                <Icon name="warning" size={16} />
                {tx("Remote branches are not available for private forks")}
              </>
            )}
          </div>
        </Popup>
      )}
    </div>
  );
}
