/** Imperative prompt dialogs of the Services view, rendered by one overlay. */
import { Fragment, useState, type ReactNode } from "react";
import { create } from "zustand";
import { SshConfigSelect } from "@/features/settings/components/SshConfigSelect";
import { executeAction } from "@/platform/actions";
import type { DockerConnection, DockerEndpoint, DockerRegistry } from "@/platform/ipc";
import type { SshConfigValid } from "@/platform/remoteSettings";
import { useWorkflowSettings } from "@/platform/workflowSettings";
import { Button, Dialog, Input, Select, T } from "@/ui";
import { errorMessage, newId, saveConnection, saveRegistry, testRegistryLogin } from "./store";
import styles from "./Services.module.css";

interface Entry {
  id: number;
  node: ReactNode;
}

const useDialogs = create<{ stack: Entry[] }>(() => ({ stack: [] }));
let seq = 0;

function open(render: (close: () => void) => ReactNode): void {
  const id = ++seq;
  const close = () => useDialogs.setState((s) => ({ stack: s.stack.filter((e) => e.id !== id) }));
  useDialogs.setState((s) => ({ stack: [...s.stack, { id, node: render(close) }] }));
}

export function ServicesDialogHost() {
  const stack = useDialogs((s) => s.stack);
  return (
    <>
      {stack.map((e) => (
        <Fragment key={e.id}>{e.node}</Fragment>
      ))}
    </>
  );
}

export function promptText(title: string, label: string, placeholder: string): Promise<string | null> {
  return new Promise((resolve) =>
    open((close) => (
      <PromptDialog
        title={title}
        label={label}
        placeholder={placeholder}
        onDone={(v) => {
          close();
          resolve(v);
        }}
      />
    )),
  );
}

function PromptDialog(props: {
  title: string;
  label: string;
  placeholder: string;
  onDone: (v: string | null) => void;
}) {
  const [value, setValue] = useState("");
  const ok = value.trim().length > 0;
  return (
    <Dialog
      open
      title={props.title}
      onClose={() => props.onDone(null)}
      width={420}
      buttons={[
        { label: "OK", role: "default", disabled: !ok, onClick: () => props.onDone(value.trim()) },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) props.onDone(value.trim());
        }}
      >
        <label className={styles.fieldLabel}>
          <T>{props.label}</T>
        </label>
        <Input
          data-autofocus
          mono
          aria-label={props.label}
          placeholder={props.placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </form>
    </Dialog>
  );
}

async function pickDirectory(title: string): Promise<string | null> {
  const { open: openDialog } = await import("@/platform/dialog");
  const dir = await openDialog({ multiple: false, directory: true, title });
  return typeof dir === "string" ? dir : null;
}

type EndpointKind = DockerEndpoint["kind"];

const ENDPOINT_KINDS: Array<{ value: EndpointKind; label: string }> = [
  { value: "default", label: "Docker CLI default (DOCKER_HOST / current context)" },
  { value: "socket", label: "Unix socket" },
  { value: "tcp", label: "TCP / SSH host" },
  { value: "context", label: "Docker context" },
];

/** The endpoint described by the dialog's fields, or null while incomplete. */
export function endpointFrom(
  kind: EndpointKind,
  fields: { path: string; host: string; tls: string; context: string },
): DockerEndpoint | null {
  switch (kind) {
    case "default":
      return { kind };
    case "socket":
      return fields.path.trim() ? { kind, path: fields.path.trim() } : null;
    case "tcp":
      return fields.host.trim() ? { kind, host: fields.host.trim(), tlsCertDir: fields.tls.trim() || null } : null;
    case "context": {
      const name = fields.context.trim();
      return name && !name.startsWith("-") ? { kind, name } : null;
    }
  }
}

/** "Add Service › Docker Connection…" (or edit `existing`). */
export function openConnectionDialog(existing?: DockerConnection) {
  open((close) => <ConnectionDialog existing={existing} onDone={close} />);
}

/** `ssh://[user@]host[:port]` of an SSH configuration whose authentication is the OpenSSH
 * config: the alias stays in the URL so the system `ssh` that docker runs applies the
 * entry's user, key and jump hosts. */
export function sshConfigUrl(c: Pick<SshConfigValid, "user" | "host" | "port">): string {
  return `ssh://${c.user ? `${c.user}@` : ""}${c.host}${c.port ? `:${c.port}` : ""}`;
}

/**
 * The id of the SSH configuration an Engine API URL was filled from, to show the selection:
 * an exact `ssh://[user@]host[:port]` URL matching an OpenSSH-config configuration's user,
 * host and port. Anything else (a `tcp://` URL, a different user or port) is manual.
 */
export function sshConfigForUrl(url: string, configs: readonly SshConfigValid[]): string {
  const m = /^ssh:\/\/(?:([^@/\s]+)@)?([A-Za-z0-9._-]+)(?::(\d+))?$/i.exec(url.trim());
  if (!m) return "";
  const config = configs.find(
    (c) =>
      c.auth === "openSsh" &&
      c.host.trim().toLowerCase() === (m[2] ?? "").toLowerCase() &&
      (!m[1] || c.user === m[1]) &&
      (!m[3] || c.port === Number(m[3])),
  );
  return config?.id ?? "";
}

/** Settings › Tools › SSH Configurations, where the TCP/SSH kind's picker is edited. */
const SSH_SETTINGS_PAGE = "tools.sshConfigurations";

function ConnectionDialog({ existing, onDone }: { existing?: DockerConnection; onDone: () => void }) {
  const ep = existing?.endpoint;
  const sshConfigs = useWorkflowSettings((w) => w.ssh.configs);
  const [name, setName] = useState(existing?.name ?? "Docker");
  const [kind, setKind] = useState<EndpointKind>(ep?.kind ?? "socket");
  const [path, setPath] = useState(ep?.kind === "socket" ? ep.path : "/var/run/docker.sock");
  const [host, setHost] = useState(ep?.kind === "tcp" ? ep.host : "");
  const [tls, setTls] = useState(ep?.kind === "tcp" ? (ep.tlsCertDir ?? "") : "");
  const [context, setContext] = useState(ep?.kind === "context" ? ep.name : "");
  // The configuration picked in the dropdown; shown even when docker cannot use it yet.
  const [picked, setPicked] = useState(() => (ep?.kind === "tcp" ? sshConfigForUrl(ep.host, sshConfigs) : ""));
  const fromUrl = sshConfigForUrl(host, sshConfigs);
  const shown = fromUrl || picked;
  const unusable = !fromUrl && sshConfigs.find((c) => c.id === picked && c.auth !== "openSsh");
  const pickSsh = (id: string) => {
    setPicked(id);
    const config = sshConfigs.find((c) => c.id === id);
    if (config?.auth === "openSsh" && config.host.trim()) setHost(sshConfigUrl(config));
  };
  const endpoint = endpointFrom(kind, { path, host, tls, context });
  const ok = !!endpoint && name.trim().length > 0;
  const submit = async () => {
    if (!endpoint || !ok) return;
    if (await saveConnection({ id: existing?.id ?? newId("c"), name: name.trim(), endpoint })) onDone();
  };
  return (
    <Dialog
      open
      title={existing ? "Edit Docker Connection" : "New Docker Connection"}
      onClose={onDone}
      width={480}
      buttons={[
        { label: "OK", role: "default", disabled: !ok, onClick: () => void submit() },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className={styles.fieldLabel} htmlFor="docker-conn-name">
          <T>Name:</T>
        </label>
        <Input id="docker-conn-name" data-autofocus value={name} onChange={(e) => setName(e.target.value)} />
        <span className={styles.fieldLabel}>
          <T>Connect to Docker daemon with:</T>
        </span>
        <Select<EndpointKind> aria-label="Connection type" value={kind} options={ENDPOINT_KINDS} onChange={setKind} />
        {kind === "socket" && (
          <>
            <label className={styles.fieldLabel} htmlFor="docker-conn-socket">
              <T>Socket path or Engine API URL:</T>
            </label>
            <Input
              id="docker-conn-socket"
              mono
              value={path}
              placeholder="/var/run/docker.sock"
              onChange={(e) => setPath(e.target.value)}
            />
          </>
        )}
        {kind === "tcp" && (
          <>
            <span className={styles.fieldLabel}>
              <T>SSH configuration:</T>
            </span>
            <div className={styles.fieldRow}>
              <SshConfigSelect
                value={shown}
                onChange={pickSsh}
                none="None — type the Engine API URL below"
                aria-label="SSH configuration"
              />
              <Button
                title="Settings › Tools › SSH Configurations"
                aria-label="Edit SSH Configurations"
                onClick={() => void executeAction("file.settings", SSH_SETTINGS_PAGE)}
              >
                …
              </Button>
            </div>
            {unusable && (
              <span className={styles.hint}>
                <T>Docker over SSH uses the system ssh: choose a configuration with OpenSSH config authentication.</T>
              </span>
            )}
            <label className={styles.fieldLabel} htmlFor="docker-conn-host">
              <T>Engine API URL:</T>
            </label>
            <Input
              id="docker-conn-host"
              mono
              value={host}
              placeholder="tcp://build-host:2376 or ssh://me@build-host"
              onChange={(e) => setHost(e.target.value)}
            />
            <label className={styles.fieldLabel} htmlFor="docker-conn-tls">
              <T>Certificates folder (TLS, optional):</T>
            </label>
            <div className={styles.fieldRow}>
              <Input
                id="docker-conn-tls"
                mono
                value={tls}
                placeholder="contains ca.pem, cert.pem and key.pem"
                onChange={(e) => setTls(e.target.value)}
              />
              <Button onClick={() => void pickDirectory("Certificates Folder").then((d) => d && setTls(d))}>
                Browse…
              </Button>
            </div>
          </>
        )}
        {kind === "context" && (
          <>
            <label className={styles.fieldLabel} htmlFor="docker-conn-context">
              <T>Context name:</T>
            </label>
            <Input
              id="docker-conn-context"
              mono
              value={context}
              placeholder="e.g. desktop-linux, orbstack, colima"
              onChange={(e) => setContext(e.target.value)}
            />
          </>
        )}
      </form>
    </Dialog>
  );
}

/** "Add Service › Docker Registry…" (or edit `existing`). */
export function openRegistryDialog(existing?: DockerRegistry) {
  open((close) => <RegistryDialog existing={existing} onDone={close} />);
}

function RegistryDialog({ existing, onDone }: { existing?: DockerRegistry; onDone: () => void }) {
  const [name, setName] = useState(existing?.name ?? "Docker Registry");
  const [address, setAddress] = useState(existing?.address ?? "docker.io");
  const [username, setUsername] = useState(existing?.username ?? "");
  // Left empty when editing: the saved password stays.
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [id] = useState(() => existing?.id ?? newId("r"));
  const ok = name.trim().length > 0 && address.trim().length > 0;
  const registry = (): DockerRegistry => ({
    id,
    name: name.trim(),
    address: address.trim(),
    username: username.trim(),
  });
  const submit = async () => {
    if (!ok) return;
    if (await saveRegistry(registry(), password ? password : existing ? undefined : null)) onDone();
  };
  const test = async () => {
    setTesting(true);
    setStatus(null);
    try {
      setStatus({ ok: true, text: await testRegistryLogin(registry(), password || null) });
    } catch (e) {
      setStatus({ ok: false, text: errorMessage(e) });
    } finally {
      setTesting(false);
    }
  };
  return (
    <Dialog
      open
      title={existing ? "Edit Docker Registry" : "New Docker Registry"}
      onClose={onDone}
      width={480}
      footerStart={status && <span className={status.ok ? styles.okText : styles.stderr}>{status.text}</span>}
      buttons={[
        {
          label: "Test Connection",
          role: "extra",
          disabled: !ok || !username.trim() || testing,
          onClick: () => void test(),
        },
        { label: "OK", role: "default", disabled: !ok, onClick: () => void submit() },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className={styles.fieldLabel} htmlFor="docker-reg-name">
          <T>Name:</T>
        </label>
        <Input id="docker-reg-name" data-autofocus value={name} onChange={(e) => setName(e.target.value)} />
        <label className={styles.fieldLabel} htmlFor="docker-reg-address">
          <T>Address:</T>
        </label>
        <Input
          id="docker-reg-address"
          mono
          value={address}
          placeholder="docker.io, ghcr.io, registry.example.com:5000"
          onChange={(e) => setAddress(e.target.value)}
        />
        <label className={styles.fieldLabel} htmlFor="docker-reg-user">
          <T>Username:</T>
        </label>
        <Input id="docker-reg-user" value={username} onChange={(e) => setUsername(e.target.value)} />
        <label className={styles.fieldLabel} htmlFor="docker-reg-password">
          <T>Password:</T>
        </label>
        <Input
          id="docker-reg-password"
          type="password"
          value={password}
          placeholder={existing ? "Unchanged" : "Password or access token"}
          onChange={(e) => setPassword(e.target.value)}
        />
        <span className={styles.hint}>
          <T>Images from this registry are pulled with these credentials.</T>
        </span>
      </form>
    </Dialog>
  );
}
