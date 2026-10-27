/**
 * Tools › SSH Configurations: the app-wide SSH hosts used by data source tunnels,
 * deployment servers, run targets and Tools › Start SSH Session.
 */
import { useId, useState } from "react";
import clsx from "clsx";
import { call, commands, IpcError, isTauri } from "@/platform/ipc";
import { useTx } from "@/platform/i18n";
import {
  DEFAULT_SSH_CONFIG,
  newRemoteId,
  sshLabel,
  type SshAuthValid,
  type SshConfigValid,
} from "@/platform/remoteSettings";
import { Button, Checkbox, IconButton, Input, type SelectOption, T } from "@/ui";
import { Row, Section, Select } from "../components/Form";
import { useSetting } from "../components/context";
import type { PageSpec } from "./spec";
import { parseSshPort, secretKind, sshTestRemedy, type SshTestRemedy } from "./sshConnection";
import { TOOLS_GROUP } from "./tools";
import styles from "./Workflow.module.css";

const AUTH: Array<SelectOption<SshAuthValid>> = [
  { value: "password", label: "Password" },
  { value: "keyPair", label: "Key pair (OpenSSH or PuTTY)" },
  { value: "openSsh", label: "OpenSSH config and authentication agent" },
];

type TestState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "ok"; text: string }
  | { status: "failed"; text: string; remedy: SshTestRemedy };

function Field({
  label,
  value,
  onChange,
  placeholder,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  const id = useId();
  const tx = useTx();
  return (
    <Row label={label} htmlFor={id} className={styles.alignedRow}>
      <Input
        id={id}
        mono={mono}
        className={styles.wide}
        value={value}
        placeholder={placeholder && tx(placeholder)}
        onChange={(e) => onChange(e.target.value)}
      />
    </Row>
  );
}

function HostRow({ config, update }: { config: SshConfigValid; update: (p: Partial<SshConfigValid>) => void }) {
  const hostId = useId();
  const portId = useId();
  const tx = useTx();
  // What is typed (e.g. an invalid port); the form is keyed by configuration.
  const [portText, setPortText] = useState(config.port?.toString() ?? "");
  return (
    <Row label="Host" htmlFor={hostId} className={styles.alignedRow}>
      <span className={styles.inlineRow}>
        <Input
          id={hostId}
          className={styles.medium}
          value={config.host}
          placeholder={tx(config.auth === "openSsh" ? "host or ~/.ssh/config alias" : "example.com")}
          onChange={(e) => update({ host: e.target.value })}
        />
        <label htmlFor={portId}>
          <T>Port:</T>
        </label>
        <Input
          id={portId}
          className={styles.small}
          inputMode="numeric"
          value={portText}
          placeholder="22"
          invalid={!!portText.trim() && parseSshPort(portText) === null}
          onChange={(e) => {
            setPortText(e.target.value);
            update({ port: parseSshPort(e.target.value) });
          }}
        />
      </span>
    </Row>
  );
}

function KeyFileRow({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const id = useId();
  const tx = useTx();
  const browse = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ multiple: false, title: tx("Private Key File") });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (path) onChange(path);
  };
  return (
    <Row label="Private key file" htmlFor={id} className={styles.alignedRow}>
      <span className={styles.inlineRow}>
        <Input
          id={id}
          mono
          className={styles.wide}
          value={value}
          placeholder="~/.ssh/id_ed25519"
          onChange={(e) => onChange(e.target.value)}
        />
        <IconButton
          icon="folder-open"
          size="small"
          title="Browse…"
          aria-label="Browse"
          disabled={!isTauri()}
          onClick={() => void browse()}
        />
      </span>
    </Row>
  );
}

/** Test Connection with the configuration as edited, offering host key trust and a password prompt. */
function TestConnection({ config }: { config: SshConfigValid }) {
  const tx = useTx();
  const secretId = useId();
  const [state, setState] = useState<TestState>({ status: "idle" });
  const [secret, setSecret] = useState("");

  const run = async (typed?: string) => {
    setState({ status: "running" });
    try {
      const text = await call(commands.sshTest(config, typed ?? null));
      if (typed !== undefined) await commands.sshSetSecret(config.id, typed, config.saveSecret);
      setSecret("");
      setState({ status: "ok", text });
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      const remedy = e instanceof IpcError ? sshTestRemedy(e.kind, e.message, config.auth) : null;
      setState({ status: "failed", text, remedy });
    }
  };
  const trust = async () => {
    setState({ status: "running" });
    try {
      await call(commands.sshTrustHost(config.id));
    } catch (e) {
      setState({ status: "failed", text: e instanceof Error ? e.message : String(e), remedy: null });
      return;
    }
    await run();
  };

  const running = state.status === "running";
  const kind = state.status === "failed" ? secretKind(config.auth, state.text) : "password";
  return (
    <div className={styles.toolsLayout}>
      <span className={styles.inlineRow}>
        <Button size="small" disabled={running || !config.host.trim()} onClick={() => void run()}>
          <T>Test Connection</T>
        </Button>
        <span
          role="status"
          className={clsx(state.status === "ok" && styles.ok, state.status === "failed" && styles.error)}
        >
          {running ? tx("Connecting…") : state.status === "idle" ? "" : state.text}
        </span>
      </span>
      {state.status === "failed" && state.remedy === "trustHostKey" && (
        <span className={styles.inlineRow}>
          <span className={styles.note}>
            <T>The authenticity of the host cannot be established. Trust it and add the key to ~/.ssh/known_hosts?</T>
          </span>
          <Button size="small" onClick={() => void trust()}>
            <T>Trust Host and Retry</T>
          </Button>
        </span>
      )}
      {state.status === "failed" && state.remedy === "secret" && (
        <form
          className={styles.inlineRow}
          onSubmit={(e) => {
            e.preventDefault();
            void run(secret);
          }}
        >
          <label htmlFor={secretId}>{tx(kind === "password" ? "Password:" : "Passphrase:")}</label>
          <Input
            id={secretId}
            type="password"
            autoFocus
            className={styles.medium}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
          <Button size="small" type="submit">
            <T>Connect</T>
          </Button>
        </form>
      )}
    </div>
  );
}

function SshConfigForm({
  config,
  update,
}: {
  config: SshConfigValid;
  update: (patch: Partial<SshConfigValid>) => void;
}) {
  return (
    <Section title="Connection">
      <Field label="Name" value={config.name} onChange={(name) => update({ name })} />
      <HostRow config={config} update={update} />
      <Field
        label="User name"
        value={config.user}
        onChange={(user) => update({ user })}
        placeholder={config.auth === "openSsh" ? "from ~/.ssh/config" : undefined}
      />
      <Row label="Authentication type" className={styles.alignedRow}>
        <Select
          value={config.auth}
          options={AUTH}
          onChange={(auth) => update({ auth })}
          aria-label="Authentication type"
        />
      </Row>
      {config.auth === "keyPair" && <KeyFileRow value={config.keyFile} onChange={(keyFile) => update({ keyFile })} />}
      {config.auth === "openSsh" ? (
        <div className={styles.note}>
          <T>
            {"Uses HostName, User, Port, IdentityFile and ProxyJump from ~/.ssh/config, and keys of the SSH agent."}
          </T>
        </div>
      ) : (
        <Checkbox
          checked={config.saveSecret}
          onChange={(saveSecret) => update({ saveSecret })}
          label={config.auth === "password" ? "Save password" : "Save passphrase"}
        />
      )}
      <TestConnection config={config} />
    </Section>
  );
}

function SshConfigsEditor() {
  const [stored, setConfigs] = useSetting<SshConfigValid[] | undefined>("ssh.configs", "global");
  const configs = stored ?? [];
  const [selected, setSelected] = useState<string | null>(configs[0]?.id ?? null);
  const current = configs.find((c) => c.id === selected) ?? null;
  const index = current ? configs.indexOf(current) : -1;

  const update = (patch: Partial<SshConfigValid>) => {
    if (!current) return;
    setConfigs(configs.map((c) => (c.id === current.id ? { ...c, ...patch } : c)));
  };
  const add = (base?: SshConfigValid) => {
    const config: SshConfigValid = base
      ? { ...base, id: newRemoteId("ssh"), name: `${base.name || sshLabel(base)} (copy)` }
      : { ...DEFAULT_SSH_CONFIG, id: newRemoteId("ssh"), name: `SSH ${configs.length + 1}` };
    setConfigs([...configs, config]);
    setSelected(config.id);
  };
  const remove = () => {
    if (!current) return;
    const rest = configs.filter((c) => c.id !== current.id);
    setConfigs(rest);
    setSelected(rest[Math.min(index, rest.length - 1)]?.id ?? null);
  };

  return (
    <div className={styles.toolsLayout}>
      <div className={styles.tableBox}>
        <div className={styles.toolbar} role="toolbar" aria-label="SSH configurations actions">
          <IconButton icon="plus" title="Add" size="small" onClick={() => add()} />
          <IconButton icon="minus" title="Remove" size="small" disabled={!current} onClick={remove} />
          <IconButton
            icon="copy"
            title="Copy"
            size="small"
            disabled={!current}
            onClick={() => current && add(current)}
          />
        </div>
        <div className={styles.toolList} role="listbox" aria-label="SSH configurations">
          {configs.length === 0 && (
            <div className={clsx(styles.toolRow, styles.empty)}>
              <T>No SSH configurations. Click + to add one.</T>
            </div>
          )}
          {configs.map((c) => (
            <div
              key={c.id}
              role="option"
              aria-selected={c.id === selected}
              className={clsx(styles.toolRow, c.id === selected && styles.toolRowSelected)}
              onMouseDown={() => setSelected(c.id)}
            >
              <span>{c.name.trim() || sshLabel(c) || c.id}</span>
              <span className={styles.toolGroup}>{sshLabel(c)}</span>
            </div>
          ))}
        </div>
      </div>
      {current && <SshConfigForm key={current.id} config={current} update={update} />}
      <div className={styles.note}>
        <T>
          {
            "SSH configurations are shared by all projects: data source tunnels, deployment servers, run targets and Tools › Start SSH Session connect with them."
          }
        </T>
      </div>
    </div>
  );
}

export const SSH_PAGES: PageSpec[] = [
  {
    id: "tools.sshConfigurations",
    title: "SSH Configurations",
    group: TOOLS_GROUP,
    order: 603,
    keywords: ["ssh", "remote", "host", "server", "key pair", "private key", "password", "known_hosts", "agent"],
    sections: [
      {
        options: [
          {
            kind: "custom",
            label: "SSH Configurations",
            keywords: [
              "Host",
              "Port",
              "User name",
              "Authentication type",
              "Private key file",
              "Save password",
              "Save passphrase",
              "Test Connection",
              "OpenSSH config and authentication agent",
            ],
            component: SshConfigsEditor,
          },
        ],
      },
    ],
  },
];
