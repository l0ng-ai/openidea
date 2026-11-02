/**
 * Title bar buttons for a merge, rebase, cherry-pick or revert that stopped, and for conflicts
 * left by anything else (IntelliJ's GitMergeRebaseWidget): Resolve and Continue green, Abort red.
 */
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { Icon } from "@/ui";
import type { IconName } from "@/ui/icons";
import { controlLabel, controlOperation, inProgress } from "./operations";
import { useVcs } from "./store";
import styles from "./MergeRebaseWidget.module.css";

function Button(props: { label: string; icon: IconName; tone: "go" | "abort"; disabled: boolean; run: () => void }) {
  return (
    <button
      type="button"
      className={styles[props.tone]}
      title={props.label}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={props.run}
    >
      <Icon name={props.icon} size={16} />
    </button>
  );
}

export function MergeRebaseWidget() {
  const op = useVcs((s) => inProgress(s.branch?.operation));
  const conflicts = useVcs((s) => s.status.some((f) => f.unstaged === "conflicted"));
  const busy = useVcs((s) => !!s.remoteBusy);
  if (!op && !conflicts) return null;
  return (
    <div className={styles.widget} role="group" aria-label={tx("Merge conflicts")}>
      {conflicts && (
        <Button
          label={tx("Resolve Conflicts…")}
          icon="resolve-continue"
          tone="go"
          disabled={busy}
          run={() => void executeAction("vcs.resolveConflicts")}
        />
      )}
      {op && op !== "merge" && !conflicts && (
        <Button
          label={controlLabel(op, "continue")}
          icon="resolve-continue"
          tone="go"
          disabled={busy}
          run={() => void controlOperation("continue", op)}
        />
      )}
      {op && (
        <Button
          label={controlLabel(op, "abort")}
          icon="vcs-abort"
          tone="abort"
          disabled={busy}
          run={() => void controlOperation("abort", op)}
        />
      )}
    </div>
  );
}
