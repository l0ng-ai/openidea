/** Data source (add / edit / test connection) and password dialogs. */
import { Fragment, useState } from "react";
import { call, commands, type DataSource } from "@/platform/ipc";
import { Checkbox, Dialog, Input, lazyComponent, T } from "@/ui";
import { sshLabel } from "./model";
import { SourceDialog } from "./SourceDialog";
import { closeDialog, useDatabase } from "./store";
import styles from "./Database.module.css";

const ObjectDialogs = lazyComponent(() => import("./ObjectDialogs").then((m) => m.ObjectDialogs));
const ExportDialog = lazyComponent(() => import("./ExportDialog").then((m) => m.ExportDialog));
const HistoryDialog = lazyComponent(() => import("./DataDialogs").then((m) => m.HistoryDialog));
const ImportDialog = lazyComponent(() => import("./DataDialogs").then((m) => m.ImportDialog));

function PasswordDialog({ source, resolve }: { source: DataSource; resolve: (ok: boolean) => void }) {
  const [password, setPassword] = useState("");
  const [save, setSave] = useState(!!source.savePassword);
  const done = (ok: boolean) => {
    closeDialog();
    resolve(ok);
  };
  const submit = async () => {
    await call(commands.dbSetPassword(source.id ?? "", password, save));
    done(true);
  };
  return (
    <Dialog
      open
      onClose={() => done(false)}
      title={`Connect to ${source.name}`}
      width={400}
      buttons={[
        { label: "Cancel", role: "cancel" },
        { label: "Connect", role: "default", onClick: () => void submit() },
      ]}
    >
      <div className={styles.form}>
        <span className={styles.formLabel}>
          <T>User:</T>
        </span>
        <span>{source.user || "(default)"}</span>
        <label className={styles.formLabel} htmlFor="db-ask-password">
          <T>Password:</T>
        </label>
        <Input
          id="db-ask-password"
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <span />
        <Checkbox checked={save} onChange={setSave} label="Save password" />
      </div>
    </Dialog>
  );
}

/** SSH password / key passphrase asked on connect. */
function SshSecretDialog({
  source,
  prompt,
  resolve,
}: {
  source: DataSource;
  prompt: string;
  resolve: (ok: boolean) => void;
}) {
  const [secret, setSecret] = useState("");
  const [save, setSave] = useState(!!source.ssh?.saveSecret);
  const password = source.ssh?.auth === "password" || /password required/.test(prompt);
  const done = (ok: boolean) => {
    closeDialog();
    resolve(ok);
  };
  const submit = async () => {
    await call(commands.dbSetSshSecret(source.id ?? "", secret, save));
    done(true);
  };
  return (
    <Dialog
      open
      onClose={() => done(false)}
      title={`SSH: ${sshLabel(source) || source.name}`}
      width={440}
      buttons={[
        { label: "Cancel", role: "cancel" },
        { label: "Connect", role: "default", onClick: () => void submit() },
      ]}
    >
      <div className={styles.form}>
        <span />
        <span className={styles.formHint}>{prompt}</span>
        <label className={styles.formLabel} htmlFor="db-ask-ssh-secret">
          {password ? "Password:" : "Passphrase:"}
        </label>
        <Input
          id="db-ask-ssh-secret"
          type="password"
          autoFocus
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
        <span />
        <Checkbox checked={save} onChange={setSave} label="Save password" />
      </div>
    </Dialog>
  );
}

/** IDEA's parameter dialog: one SQL value per query parameter, remembered for the next run. */
function ParamsDialog({
  names,
  resolve,
}: {
  names: string[];
  resolve: (values: Record<string, string> | null) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const last = useDatabase.getState().paramValues;
    return Object.fromEntries(names.map((n) => [n, last[n] ?? ""]));
  });
  const done = (v: Record<string, string> | null) => {
    closeDialog();
    resolve(v);
  };
  return (
    <Dialog
      open
      onClose={() => done(null)}
      title="Parameters"
      width={480}
      buttons={[
        { label: "Cancel", role: "cancel" },
        { label: "Execute", role: "default", onClick: () => done(values) },
      ]}
    >
      <div
        className={styles.form}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
          e.preventDefault();
          done(values);
        }}
      >
        {names.map((n, i) => (
          <Fragment key={n}>
            <label className={styles.formLabel} htmlFor={`db-param-${i}`}>
              {n}
            </label>
            <Input
              id={`db-param-${i}`}
              className={styles.paramInput}
              autoFocus={i === 0}
              value={values[n] ?? ""}
              placeholder="NULL"
              onChange={(e) => setValues((v) => ({ ...v, [n]: e.target.value }))}
            />
          </Fragment>
        ))}
        <span />
        <span className={styles.formHint}>
          <T>Values are inserted as SQL: quote strings, e.g. 'abc'.</T>
        </span>
      </div>
    </Dialog>
  );
}

/** Overlay host: whichever dialog the store asks for. */
export function DatabaseDialogs() {
  const dialog = useDatabase((s) => s.dialog);
  if (!dialog) return null;
  if (dialog.kind === "source")
    return (
      <SourceDialog
        key={dialog.source?.id ?? "new"}
        initial={dialog.source}
        preset={dialog.preset}
        presetPassword={dialog.password}
      />
    );
  if (dialog.kind === "params") return <ParamsDialog names={dialog.names} resolve={dialog.resolve} />;
  if (dialog.kind === "export")
    return <ExportDialog data={dialog.data} source={dialog.source} initialFormat={dialog.format} />;
  if (dialog.kind === "history") return <HistoryDialog key={dialog.id} id={dialog.id} path={dialog.path} />;
  if (dialog.kind === "import")
    return (
      <ImportDialog key={`${dialog.id}.${dialog.table}`} id={dialog.id} schema={dialog.schema} table={dialog.table} />
    );
  if (dialog.kind === "sshSecret")
    return (
      <SshSecretDialog key={dialog.source.id} source={dialog.source} prompt={dialog.prompt} resolve={dialog.resolve} />
    );
  if (dialog.kind === "password")
    return <PasswordDialog key={dialog.source.id} source={dialog.source} resolve={dialog.resolve} />;
  return <ObjectDialogs />;
}
