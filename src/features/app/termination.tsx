/** IDEA's "Terminating 'X'" progress: a graceful stop in flight, with a Kill escape hatch. */
import { create } from "zustand";
import { Dialog, ProgressBar } from "@/ui";
import { tx } from "@/platform/i18n";
import styles from "./Termination.module.css";

interface TerminationState {
  names: readonly string[];
  /** Set while the window waits for the processes to disappear. */
  active: boolean;
  kill: () => void;
}

const useTermination = create<TerminationState>(() => ({ names: [], active: false, kill: () => {} }));

/** Shows the progress panel; call [`endTermination`] once every process is gone. */
export function beginTermination(names: readonly string[], kill: () => void) {
  useTermination.setState({ names, active: true, kill });
}

export function endTermination() {
  useTermination.setState({ names: [], active: false, kill: () => {} });
}

export function TerminationOverlay() {
  const { names, active, kill } = useTermination();
  if (!active) return null;
  const title = names.length > 1 ? tx`Terminating ${names.length} processes` : tx`Terminating '${names[0] ?? ""}'`;
  return (
    <Dialog
      open
      // The close is in flight: Escape must not dismiss the only progress the window shows.
      onClose={() => {}}
      title={title}
      width={420}
      buttons={[{ label: tx`Kill process`, role: "default", onClick: kill }]}
    >
      <div className={styles.body}>
        <ProgressBar aria-label={tx`Terminating`} />
        <div className={styles.text}>{tx`Waiting for process detach`}</div>
      </div>
    </Dialog>
  );
}
