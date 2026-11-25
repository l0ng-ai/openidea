/**
 * Commit dialog of the modal commit interface (Settings › Version Control › Commit ›
 * "Use non-modal commit interface" off): the changes with inclusion checkboxes and
 * the Commit Options beside them, the message below. Commits through the same
 * pipeline as the Commit tool window.
 */
import { tx } from "@/platform/i18n";
import { Dialog, SplitGroup, SplitHandle, SplitPanel } from "@/ui";
import { CommitOptionsBody } from "./CommitOptions";
import { useCommit } from "./commitStore";
import {
  ChangesTree,
  CommitMessageField,
  commitAndPushLabel,
  commitLabel,
  useCommitRunner,
  useIncludedCount,
} from "./CommitView";
import { openDialog } from "./dialogs";
import { useVcs } from "./store";
import viewStyles from "./CommitView.module.css";
import styles from "./CommitDialog.module.css";

let open = false;

/** Opens the Commit dialog (or focuses the message of the one open). */
export function showCommitDialog() {
  if (open) {
    useCommit.setState((s) => ({ focusTick: s.focusTick + 1 }));
    return;
  }
  useCommit.setState({ tab: "changes" });
  open = true;
  openDialog((close) => (
    <CommitDialog
      onClose={() => {
        open = false;
        close();
      }}
    />
  ));
}

function CommitDialog({ onClose }: { onClose: () => void }) {
  const included = useIncludedCount();
  const amend = useCommit((s) => s.amend);
  const blocked = useCommit((s) => !!s.checkResult?.blocked && !s.checkResult.stale);
  const remoteBusy = useVcs((s) => s.remoteBusy);
  const runner = useCommitRunner(included, onClose);
  return (
    <Dialog
      open
      title="Commit Changes"
      onClose={onClose}
      width={880}
      buttons={[
        {
          label: commitLabel(amend, blocked),
          role: "default",
          disabled: !runner.canCommit,
          title: "⌘↩",
          onClick: () => void runner.run(false),
        },
        {
          label: commitAndPushLabel(amend),
          role: "extra",
          disabled: !runner.canCommit || !!remoteBusy,
          title: "⌥⌘↩",
          onClick: () => void runner.run(true),
        },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.body}>
        <SplitGroup orientation="vertical" className={styles.split} storageKey="openidea.vcs.commitDialogSplit">
          <SplitPanel id="top" defaultSize="58%" minSize="25%">
            <SplitGroup
              orientation="horizontal"
              className={styles.split}
              storageKey="openidea.vcs.commitDialogOptionsSplit"
            >
              <SplitPanel id="changes" defaultSize="64%" minSize="35%">
                <ChangesTree mode="dialog" />
              </SplitPanel>
              <SplitHandle />
              <SplitPanel id="options" defaultSize="36%" minSize="200px">
                <div className={styles.options} role="group" aria-label={tx("Commit Options")}>
                  <CommitOptionsBody />
                </div>
              </SplitPanel>
            </SplitGroup>
          </SplitPanel>
          <SplitHandle />
          <SplitPanel id="message" defaultSize="42%" minSize="120px">
            <div className={viewStyles.commit}>
              <CommitMessageField runner={runner} onOpenToolWindow={onClose} />
            </div>
          </SplitPanel>
        </SplitGroup>
      </div>
    </Dialog>
  );
}
