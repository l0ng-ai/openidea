/**
 * Run feature dialogs: "Process is running" (rerun confirmation), the External Tools
 * `$Prompt$` input and the SSH password / passphrase of a run target.
 */
import { useState } from "react";
import { create } from "zustand";
import { call, commands, isTauri } from "@/platform/ipc";
import { loadSettings } from "@/platform/project";
import { Checkbox, Dialog, Input } from "@/ui";
import { confirmChecked } from "@/workbench/messages";
import styles from "./Run.module.css";
import { tx } from "@/platform/i18n";

interface Pending {
  title: string;
  resolve: (value: string | null) => void;
}

interface PendingSecret {
  message: string;
  save: boolean;
  resolve: (value: { secret: string; save: boolean } | null) => void;
}

const useRunDialog = create<{ pending: Pending | null; secret: PendingSecret | null }>(() => ({
  pending: null,
  secret: null,
}));

/**
 * IDEA's "Process 'x' Is Running" dialog, shown when Run starts a configuration
 * that doesn't allow parallel runs. Resolves true for Stop and Rerun.
 */
export async function confirmRerun(name: string, instances = 1): Promise<boolean> {
  const answer = await confirmChecked({
    title: tx`Process '${name}' Is Running`,
    message:
      instances > 1
        ? tx`'${name}' is not allowed to run in parallel.\nWould you like to stop ${instances} running instances?`
        : tx`'${name}' is not allowed to run in parallel.\nWould you like to stop the running one?`,
    ok: "Stop and Rerun",
    checkbox: "Do not ask again",
  });
  if (answer?.checked && isTauri()) {
    try {
      await call(commands.settingsSet("global", "run.confirmRerun", "false"));
      await loadSettings();
    } catch {
      /* keep asking */
    }
  }
  return answer !== null;
}

/** IDEA's question before closing a Run tab whose process still runs. Resolves true for Terminate. */
export async function confirmTerminate(name: string): Promise<boolean> {
  const answer = await confirmChecked({
    title: tx`Process '${name}' Is Running`,
    message: tx`Do you want to terminate the process '${name}'?`,
    ok: "Terminate",
    checkbox: "Do not ask again",
  });
  if (answer?.checked && isTauri()) {
    try {
      await call(commands.settingsSet("global", "run.confirmTerminate", "false"));
      await loadSettings();
    } catch {
      /* keep asking */
    }
  }
  return answer !== null;
}

/** Asks for the value of `$Prompt$`; null when cancelled. */
export function promptValue(title: string): Promise<string | null> {
  return new Promise((resolve) => useRunDialog.setState({ pending: { title, resolve } }));
}

/** Asks for the SSH password or key passphrase of a run target (`message`: the backend's error); null when cancelled. */
export function promptSecret(message: string, save: boolean): Promise<{ secret: string; save: boolean } | null> {
  return new Promise((resolve) => useRunDialog.setState({ secret: { message, save, resolve } }));
}

function close() {
  useRunDialog.setState({ pending: null });
}

function SecretDialog({ message, save: initialSave, resolve }: PendingSecret) {
  const [secret, setSecret] = useState("");
  const [save, setSave] = useState(initialSave);
  const done = (v: { secret: string; save: boolean } | null) => {
    useRunDialog.setState({ secret: null });
    resolve(v);
  };
  return (
    <Dialog
      open
      title="SSH Authentication"
      onClose={() => done(null)}
      width={420}
      footerStart={<Checkbox checked={save} onChange={setSave} label="Save" />}
      buttons={[
        { label: "Connect", role: "default", disabled: !secret, onClick: () => done({ secret, save }) },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.dialogBody}>
        <span>{message}</span>
        <Input
          autoFocus
          type="password"
          aria-label="Password or passphrase"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && secret) {
              e.preventDefault();
              done({ secret, save });
            }
          }}
        />
      </div>
    </Dialog>
  );
}

function PromptDialog({ title, resolve }: { title: string; resolve: (v: string | null) => void }) {
  const [value, setValue] = useState("");
  const done = (v: string | null) => {
    close();
    resolve(v);
  };
  return (
    <Dialog
      open
      title={title}
      onClose={() => done(null)}
      width={420}
      buttons={[
        { label: "OK", role: "default", onClick: () => done(value) },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.dialogBody}>
        <Input autoFocus aria-label="Value" value={value} onChange={(e) => setValue(e.target.value)} />
      </div>
    </Dialog>
  );
}

export function RunDialogsOverlay() {
  const pending = useRunDialog((s) => s.pending);
  const secret = useRunDialog((s) => s.secret);
  return (
    <>
      {pending && <PromptDialog title={pending.title} resolve={pending.resolve} />}
      {secret && <SecretDialog {...secret} />}
    </>
  );
}
