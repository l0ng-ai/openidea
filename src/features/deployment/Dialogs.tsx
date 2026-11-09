/** Deployment comparison and SSH password prompt. */
import { useState } from "react";
import { Checkbox, Dialog, Input } from "@/ui";
import { useDeployment } from "./store";
import { SyncDialog } from "./SyncDialog";
import styles from "./Deployment.module.css";

export function SecretDialog() {
  const prompt = useDeployment((s) => s.secret);
  const [secret, setSecret] = useState("");
  const [save, setSave] = useState(false);
  if (!prompt) return null;
  const finish = (answer: { secret: string; save: boolean } | null) => {
    prompt.resolve(answer);
    setSecret("");
    setSave(false);
  };
  return (
    <Dialog
      open
      title="SSH Password"
      onClose={() => finish(null)}
      width={420}
      buttons={[
        { label: "Cancel", role: "cancel" },
        { label: "OK", role: "default", disabled: !secret, onClick: () => finish({ secret, save }) },
      ]}
    >
      <form
        className={styles.secret}
        onSubmit={(e) => {
          e.preventDefault();
          if (secret) finish({ secret, save });
        }}
      >
        <div className={styles.note}>{prompt.message}</div>
        <Input
          type="password"
          autoFocus
          value={secret}
          aria-label="Password or passphrase"
          placeholder="Password or passphrase"
          onChange={(e) => setSecret(e.target.value)}
        />
        <Checkbox checked={save} onChange={setSave} label="Save password" />
      </form>
    </Dialog>
  );
}

export function DeploymentDialogs() {
  return (
    <>
      <SyncDialog />
      <SecretDialog />
    </>
  );
}
