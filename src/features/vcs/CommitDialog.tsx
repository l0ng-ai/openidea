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
  useCommit.setState((s) => ({ tab: "changes", focusTick: s.focusTick + 1 }));
  if (open) return;
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
  const problems = useCommit((s) => s.checkProblems.length > 0);
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
          label: commitLabel(amend, problems),
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
        <SplitGroup orientation="vertical" className={styles.split}>
          <SplitPanel defaultSize="58%" minSize="25%">
            <SplitGroup orientation="horizontal" className={styles.split}>
              <SplitPanel defaultSize="64%" minSize="35%">
                <ChangesTree mode="dialog" />
              </SplitPanel>
              <SplitHandle />
              <SplitPanel defaultSize="36%" minSize="200px">
                <div className={styles.options} role="group" aria-label={tx("Commit Options")}>
                  <CommitOptionsBody />
                </div>
              </SplitPanel>
            </SplitGroup>
          </SplitPanel>
          <SplitHandle />
          <SplitPanel defaultSize="42%" minSize="120px">
            <div className={viewStyles.commit}>
              <CommitMessageField included={included} runner={runner} />
            </div>
          </SplitPanel>
        </SplitGroup>
      </div>
    </Dialog>
  );
}
