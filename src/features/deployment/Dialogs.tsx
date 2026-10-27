/** Deployment dialogs: Sync with Deployed and the SSH password prompt. */
import { useState } from "react";
import clsx from "clsx";
import type { SyncEntry, SyncStatus } from "@/platform/ipc";
import { useTx, useTxTemplate } from "@/platform/i18n";
import { relativePath, useProject } from "@/platform/project";
import { Checkbox, Dialog, Input, Spinner, T } from "@/ui";
import { closeSync, runSync } from "./actions";
import { formatSize, formatTime, syncChoices, syncSteps, type SyncChoice } from "./model";
import { patchSync, useDeployment } from "./store";
import styles from "./Deployment.module.css";

const STATUS_LABELS: Record<SyncStatus, string> = {
  localOnly: "Local only",
  remoteOnly: "Remote only",
  localNewer: "Local is newer",
  remoteNewer: "Remote is newer",
  different: "Different size",
  same: "Identical",
};

const CHOICE_LABELS: Record<SyncChoice, string> = {
  skip: "Skip",
  upload: "Upload",
  download: "Download",
  deleteRemote: "Delete remote",
  deleteLocal: "Delete local",
};

function SyncRow({
  entry,
  choice,
  onChoice,
  disabled,
}: {
  entry: SyncEntry;
  choice: SyncChoice;
  onChoice: (c: SyncChoice) => void;
  disabled: boolean;
}) {
  const tx = useTx();
  return (
    <tr className={clsx(choice === "skip" && styles.skipped)}>
      <td>
        <select
          className={styles.choice}
          value={choice}
          disabled={disabled}
          aria-label={`${tx("Action")} ${entry.path}`}
          onChange={(e) => onChoice(e.target.value as SyncChoice)}
        >
          {syncChoices(entry).map((c) => (
            <option key={c} value={c}>
              {tx(CHOICE_LABELS[c])}
            </option>
          ))}
        </select>
      </td>
      <td className={styles.mono} title={entry.remotePath}>
        {entry.path}
      </td>
      <td className={styles.num}>{entry.local ? formatSize(entry.local.size) : ""}</td>
      <td>{formatTime(entry.local?.mtime)}</td>
      <td className={styles.num}>{entry.remote ? formatSize(entry.remote.size) : ""}</td>
      <td>{formatTime(entry.remote?.mtime)}</td>
      <td className={styles[`status-${entry.status}`]}>{tx(STATUS_LABELS[entry.status])}</td>
    </tr>
  );
}

function SyncDialog() {
  const sync = useDeployment((s) => s.sync);
  const root = useProject((s) => s.project?.root ?? null);
  const tx = useTx();
  const txt = useTxTemplate();
  if (!sync) return null;
  const entries = sync.entries;
  const shown = entries?.filter((e) => !sync.hideSame || e.status !== "same") ?? [];
  const steps = syncSteps(sync.choices);
  const same = entries?.filter((e) => e.status === "same").length ?? 0;
  const where = root ? relativePath(root, sync.path) || "/" : sync.path;

  return (
    <Dialog
      open
      title={txt(`Sync with ${sync.serverName}`)}
      onClose={closeSync}
      width={920}
      footerStart={
        entries && (
          <Checkbox
            checked={sync.hideSame}
            onChange={(hideSame) => patchSync({ hideSame })}
            label={txt(`Hide identical files (${same})`)}
          />
        )
      }
      buttons={[
        { label: "Cancel", role: "cancel" },
        {
          label: "Synchronize",
          role: "default",
          disabled: !entries || sync.running || steps.length === 0,
          onClick: () => void runSync(steps),
        },
      ]}
    >
      <div className={styles.sync}>
        <div className={styles.note}>
          <span className={styles.mono}>{where}</span>
          {entries && <> · {txt(`${steps.length} of ${entries.length} files will change`)}</>}
        </div>
        {sync.error && <div className={styles.error}>{sync.error}</div>}
        {!entries && !sync.error && (
          <div className={styles.center}>
            <Spinner /> <T>Comparing local and remote files…</T>
          </div>
        )}
        {entries && (
          <div className={styles.syncTableHost}>
            <table className={styles.syncTable} aria-label={tx("Files to synchronize")}>
              <thead>
                <tr>
                  <th className={styles.choiceCol}>{tx("Action")}</th>
                  <th>{tx("Path")}</th>
                  <th className={styles.sizeCol}>{tx("Local size")}</th>
                  <th className={styles.timeCol}>{tx("Local modified")}</th>
                  <th className={styles.sizeCol}>{tx("Remote size")}</th>
                  <th className={styles.timeCol}>{tx("Remote modified")}</th>
                  <th className={styles.statusCol}>{tx("Status")}</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={7} className={styles.emptyCell}>
                      <T>Local and remote files are identical</T>
                    </td>
                  </tr>
                )}
                {shown.map((e) => (
                  <SyncRow
                    key={e.path}
                    entry={e}
                    choice={sync.choices[e.path] ?? "skip"}
                    disabled={sync.running}
                    onChoice={(c) => patchSync({ choices: { ...sync.choices, [e.path]: c } })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {sync.running && (
          <div className={styles.center}>
            <Spinner /> <T>Synchronizing…</T>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function SecretDialog() {
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
