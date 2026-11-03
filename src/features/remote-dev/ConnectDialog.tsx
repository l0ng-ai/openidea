/** Picks an SSH configuration and a folder on that host, then opens it in this or a new window. */
import { useEffect, useState } from "react";
import { executeAction } from "@/platform/actions";
import { useTx } from "@/platform/i18n";
import { call, commands, isCancelled, type RemoteEntry, type RemoteTarget } from "@/platform/ipc";
import { useRemoteProgress } from "@/platform/remote";
import { sshLabel } from "@/platform/remoteSettings";
import { useWorkflowSettings } from "@/platform/workflowSettings";
import { Button, Dialog, Icon, Input, ProgressBar, Select, Spinner } from "@/ui";
import { openRemoteProject } from "@/workbench/projectWindow";
import {
  browsableFolders,
  closeConnectDialog,
  listedDirectory,
  remoteParent,
  stageLabel,
  useConnectDialog,
} from "./model";
import styles from "./RemoteDev.module.css";

export function ConnectHost() {
  const open = useConnectDialog((s) => s.open);
  return open ? <ConnectDialog /> : null;
}

const SSH_SETTINGS_PAGE = "tools.sshConfigurations";

function ConnectDialog() {
  const tx = useTx();
  const configs = useWorkflowSettings((s) => s.ssh.configs);
  const [ssh, setSsh] = useState(configs[0]?.id ?? "");
  const [kind, setKind] = useState<RemoteTarget["kind"]>("ssh");
  // Installed WSL distributions; none (or no WSL at all) hides the WSL choice.
  const [distros, setDistros] = useState<string[]>([]);
  const [distro, setDistro] = useState("");
  const [path, setPath] = useState("~");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browse, setBrowse] = useState<{ dir: string; folders: RemoteEntry[] } | null>(null);

  useEffect(() => {
    let live = true;
    // Detection is a convenience: any failure just leaves SSH as the only choice.
    void call(commands.wslDistros())
      .then((found) => {
        if (!live) return;
        setDistros(found);
        setDistro((d) => d || (found[0] ?? ""));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const wsl = kind === "wsl";
  const name = wsl ? distro : ssh;
  const target: RemoteTarget = wsl ? { kind: "wsl", distro } : { kind: "ssh", config: ssh };

  const list = async (dir: string) => {
    setError(null);
    setBusy(true);
    try {
      const entries = await call(commands.remoteBootstrapList(ssh, dir));
      const shown = listedDirectory(dir, entries);
      setBrowse({ dir: shown, folders: browsableFolders(entries) });
      setPath(shown);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    setError(null);
    setBusy(true);
    try {
      if (await openRemoteProject(target, path.trim() || "~")) closeConnectDialog();
      else setBusy(false);
    } catch (e) {
      if (!isCancelled(e)) setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const options = configs.map((c) => ({ value: c.id, label: c.name.trim() || sshLabel(c), detail: sshLabel(c) }));
  const ready = !!name && !busy && !!path.trim();
  const connecting = useRemoteProgress((s) => s.progress !== null);

  return (
    <Dialog
      open
      title={tx("Remote Development")}
      onClose={closeConnectDialog}
      width={560}
      buttons={[
        {
          label: connecting ? "Connecting…" : "Open",
          role: "default",
          disabled: !ready,
          onClick: () => void connect(),
        },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void connect();
        }}
      >
        <p className={styles.hint}>
          {tx("The project runs on the remote host; the IDE backend is installed there on first use.")}
        </p>
        {distros.length > 0 && (
          <>
            <label className={styles.label}>{tx("Connect through:")}</label>
            <Select
              value={kind}
              options={[
                { value: "ssh", label: "SSH" },
                { value: "wsl", label: "WSL" },
              ]}
              onChange={(k) => {
                setKind(k as RemoteTarget["kind"]);
                setBrowse(null);
              }}
              aria-label={tx("Connect through")}
            />
          </>
        )}
        {wsl ? (
          <>
            <label className={styles.label}>{tx("WSL distribution:")}</label>
            <Select
              value={distro || null}
              options={distros.map((d) => ({ value: d, label: d }))}
              onChange={setDistro}
              aria-label={tx("WSL distribution")}
            />
          </>
        ) : (
          <>
            <label className={styles.label}>{tx("SSH configuration:")}</label>
            <div className={styles.row}>
              <Select
                className={styles.grow}
                value={ssh || null}
                options={options}
                placeholder={tx("No SSH configurations")}
                onChange={(id) => {
                  setSsh(id);
                  setBrowse(null);
                }}
                aria-label={tx("SSH configuration")}
              />
              <Button onClick={() => void executeAction("file.settings", SSH_SETTINGS_PAGE)}>{tx("Configure…")}</Button>
            </div>
          </>
        )}
        <label className={styles.label} htmlFor="remote-dev-path">
          {tx("Project directory:")}
        </label>
        <div className={styles.row}>
          <Input
            id="remote-dev-path"
            className={styles.grow}
            data-autofocus
            value={path}
            spellCheck={false}
            onChange={(e) => setPath(e.target.value)}
          />
          {/* Browsing lists over SFTP; a WSL distribution has no such session before connecting. */}
          {!wsl && (
            <Button disabled={!ssh || busy} onClick={() => void list(path.trim() || "~")}>
              {tx("Browse")}
            </Button>
          )}
        </div>
        {browse && (
          <ul className={styles.folders} aria-label={tx("Remote folders")}>
            {browse.dir !== "/" && (
              <li>
                <button type="button" className={styles.folder} onClick={() => void list(remoteParent(browse.dir))}>
                  <Icon name="folder" />
                  ..
                </button>
              </li>
            )}
            {browse.folders.map((f) => (
              <li key={f.path}>
                <button type="button" className={styles.folder} onClick={() => void list(f.path)}>
                  <Icon name="folder" />
                  {f.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        <ConnectProgress />
        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}
      </form>
    </Dialog>
  );
}

/** The stage of the connection in progress (and how far a download / upload is). */
function ConnectProgress() {
  const tx = useTx();
  const progress = useRemoteProgress((s) => s.progress);
  if (!progress) return null;
  const percent = progress.fraction == null ? null : Math.round(progress.fraction * 100);
  return (
    <div className={styles.progress} role="status">
      <div className={styles.progressLine}>
        <Spinner size={12} />
        <span>{tx(stageLabel(progress.stage))}</span>
        {percent != null && <span className={styles.percent}>{percent}%</span>}
      </div>
      <ProgressBar value={progress.fraction} aria-label={tx(stageLabel(progress.stage))} />
    </div>
  );
}
