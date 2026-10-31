/** "New Remote Branch for Pull Request": the name to push a local head without a push target to. */
import { useState } from "react";
import { Dialog, Input, T } from "@/ui";
import { openDialog } from "../ui/dialogs";
import styles from "./Create.module.css";

/** Asks for the remote branch name (suggesting `suggested`); null when cancelled. */
export function remoteBranchNameDialog(suggested: string): Promise<string | null> {
  return openDialog<string>((done) => <RemoteBranchDialog suggested={suggested} onDone={done} />);
}

function RemoteBranchDialog(props: { suggested: string; onDone: (name: string | null) => void }) {
  const [name, setName] = useState(props.suggested);
  const valid = !!name.trim();
  return (
    <Dialog
      open
      title="New Remote Branch for Pull Request"
      onClose={() => props.onDone(null)}
      width={420}
      buttons={[
        { label: "OK", role: "default", disabled: !valid, onClick: () => props.onDone(name.trim()) },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <form
        className={styles.dialogForm}
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) props.onDone(name.trim());
        }}
      >
        <label className={styles.dialogLabel}>
          <T>Remote branch name:</T>
        </label>
        <Input data-autofocus aria-label="Remote branch name" value={name} onChange={(e) => setName(e.target.value)} />
        <div className={styles.dialogComment}>
          <T>Your changes will be pushed to the remote repository to create the pull request</T>
        </div>
      </form>
    </Dialog>
  );
}
