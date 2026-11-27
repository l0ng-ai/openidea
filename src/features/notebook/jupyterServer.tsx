/** Connect to Jupyter Server…: saves a server's URL and token; its kernels join the notebook's kernel list. */
import { useState } from "react";
import { create } from "zustand";
import type { JupyterServer } from "@/bindings";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { Dialog, Input, T } from "@/ui";
import { notebookSessions, type NotebookSession } from "./session";
import styles from "./Notebook.module.css";

/** The kernel drop-down's value for a kernel spec of a server. */
export const remoteKernel = (server: string, spec: string) => `${server}#${spec}`;

/** The drop-down entry that opens the dialog. */
export const CONNECT = "jupyter:connect";

const useConnect = create<{ open: boolean; session: NotebookSession | null }>(() => ({ open: false, session: null }));

/** Opens the dialog; a server added from a notebook's drop-down becomes that notebook's kernel. */
export function connectJupyterServer(session: NotebookSession | null = null) {
  useConnect.setState({ open: true, session });
}

function connected(server: JupyterServer, session: NotebookSession | null) {
  for (const open of notebookSessions()) void open.detectEnvironments();
  const first = server.kernels[0];
  if (session && first) session.selectPython(remoteKernel(server.url, first.name));
}

export function JupyterServerDialog() {
  const { open, session } = useConnect();
  if (!open) return null;
  return <ConnectDialog session={session} onClose={() => useConnect.setState({ open: false, session: null })} />;
}

function ConnectDialog({ session, onClose }: { session: NotebookSession | null; onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      connected(await call(commands.jupyterServerAdd(url, token)), session);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title="Connect to Jupyter Server"
      onClose={onClose}
      width={480}
      buttons={[
        { label: "Cancel", role: "cancel" },
        { label: "Connect", role: "default", disabled: busy || !url.trim(), onClick: () => void connect() },
      ]}
    >
      <div className={styles.serverForm}>
        <label className={styles.serverLabel} htmlFor="jupyter-server-url">
          <T>URL:</T>
        </label>
        <Input
          id="jupyter-server-url"
          autoFocus
          placeholder="http://localhost:8888/"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <label className={styles.serverLabel} htmlFor="jupyter-server-token">
          <T>Token:</T>
        </label>
        <Input
          id="jupyter-server-token"
          type="password"
          placeholder={tx("Not needed when the URL has ?token=")}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <span />
        <span className={styles.serverHint}>
          <T>The token is kept in the system credential store. Only cell source is sent to the server.</T>
        </span>
        {error && (
          <>
            <span />
            <span className={styles.serverError} role="alert">
              {error}
            </span>
          </>
        )}
      </div>
    </Dialog>
  );
}
