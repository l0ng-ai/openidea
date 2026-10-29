/**
 * Data source properties (IDEA's Data Sources and Drivers page): name, colour and
 * comment above General / Options / SSH/SSL / Schemas / Advanced tabs, Test Connection.
 */
import { useState, type ReactNode } from "react";
import {
  call,
  commands,
  IpcError,
  type DataSource,
  type DbColor,
  type DbIntrospection,
  type DbOptions,
  type DbProperty,
  type DbSsh,
  type SshAuth,
  type DbSslMode,
  type DbTxMode,
} from "@/platform/ipc";
import { executeAction } from "@/platform/actions";
import { tx, useTx, useTxTemplate } from "@/platform/i18n";
import { sshLabel as configLabel } from "@/platform/remoteSettings";
import { useWorkflowSettings } from "@/platform/workflowSettings";
import { Button, Checkbox, Dialog, IconButton, Input, Select, Tabs, T, type SelectOption } from "@/ui";
import {
  colorVar,
  connectRemedy,
  effectiveSsh,
  fileSourceName,
  newSourceId,
  parseSourceUrl,
  sshConfigOf,
  sshLabel,
  sshTunnelReady,
} from "./model";
import { closeDialog, loadDatabases, loadSchemas, saveSource, useDatabase } from "./store";
import { VENDORS, sourceUrl, vendorById, vendorOf } from "./vendors";
import styles from "./Database.module.css";
import { isImeKey } from "@/platform/ime";

type Tab = "general" | "options" | "ssh" | "schemas" | "advanced";

const TYPES: SelectOption[] = VENDORS.map((v) => ({ value: v.id, label: v.label, icon: v.icon }));

const COLORS: Array<SelectOption<DbColor | "none">> = [
  { value: "none", label: "No color" },
  { value: "red", label: "Red" },
  { value: "orange", label: "Orange" },
  { value: "yellow", label: "Yellow" },
  { value: "green", label: "Green" },
  { value: "blue", label: "Blue" },
  { value: "violet", label: "Violet" },
];

const SSL: Array<SelectOption<DbSslMode>> = [
  { value: "disable", label: "Disable" },
  { value: "prefer", label: "Prefer" },
  { value: "require", label: "Require" },
  { value: "verifyCa", label: "Verify CA" },
  { value: "verifyFull", label: "Verify Full" },
];

const TX: Array<SelectOption<DbTxMode>> = [
  { value: "auto", label: "Auto" },
  { value: "manual", label: "Manual" },
];

const SSH_AUTH: Array<SelectOption<SshAuth>> = [
  { value: "openSsh", label: "OpenSSH config and authentication agent" },
  { value: "password", label: "Password" },
  { value: "keyPair", label: "Key pair" },
];

/** Driver property names the Advanced tab suggests, and what the backend does with them. */
const PROPERTIES: Record<string, { names: string[]; hint: string }> = {
  postgres: {
    names: [
      "statement_timeout",
      "lock_timeout",
      "idle_in_transaction_session_timeout",
      "search_path",
      "work_mem",
      "application_name",
      "connect_timeout",
    ],
    hint: "Sent as run-time parameters when connecting (any server setting, e.g. statement_timeout). application_name names the session; connect_timeout is in seconds.",
  },
  mysql: {
    names: ["sql_mode", "max_execution_time", "wait_timeout", "charset", "collation", "connect_timeout"],
    hint: "Set as session variables after connecting (SET SESSION name = value). charset and collation pick the connection character set; connect_timeout is in seconds.",
  },
  sqlite: {
    names: ["foreign_keys", "busy_timeout", "cache_size", "journal_mode", "synchronous"],
    hint: "Applied as pragmas when opening the file (PRAGMA name = value).",
  },
  sqlServer: {
    names: ["connect_timeout"],
    hint: "Connection settings for SQL Server.",
  },
};

const blankSsh = (): DbSsh => ({
  enabled: false,
  host: "",
  port: null,
  user: "",
  auth: "openSsh",
  keyFile: "",
  saveSecret: true,
});

const blankOptions = (): DbOptions => ({
  transaction: "auto",
  defaultSchema: "",
  timeZone: "",
  startupScript: "",
  keepAliveSecs: null,
  autoDisconnectSecs: null,
  singleDatabase: false,
});

const blankIntrospection = (): DbIntrospection => ({
  allDatabases: true,
  databases: [],
  allSchemas: true,
  schemas: [],
  showSystem: false,
  showTemplates: false,
  objectFilter: "",
});

const parsePort = (v: string) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : null;
};

const parseSecs = (v: string) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

function blank(): DataSource {
  return {
    id: newSourceId(),
    name: "",
    driver: "postgres",
    vendor: "",
    host: "localhost",
    port: null,
    database: "",
    user: "",
    file: null,
    ssl: "prefer",
    savePassword: true,
    readOnly: false,
    color: null,
    comment: "",
    urlOnly: false,
    url: "",
    sslCaFile: "",
    sslCertFile: "",
    sslKeyFile: "",
    options: blankOptions(),
    introspection: blankIntrospection(),
    properties: [],
  };
}

async function pickFile(title: string): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const file = await open({ multiple: false, directory: false, title });
  return typeof file === "string" ? file : null;
}

/** A path field with Browse…. */
function FileField({
  id,
  label,
  value,
  placeholder,
  disabled,
  title,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  title: string;
  onChange: (v: string) => void;
}) {
  return (
    <>
      <label className={styles.formLabel} htmlFor={id}>
        <T>{label}</T>
      </label>
      <div className={styles.formRow}>
        <Input
          id={id}
          className={styles.fill}
          disabled={disabled}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        <Button
          disabled={disabled}
          onClick={() =>
            void pickFile(title).then((f) => {
              if (f) onChange(f);
            })
          }
        >
          <T>Browse…</T>
        </Button>
      </div>
    </>
  );
}

/** Seconds after a checkbox (Run keep-alive query each N sec.). */
function SecondsOption({
  label,
  value,
  fallback,
  onChange,
}: {
  label: string;
  value: number | null | undefined;
  fallback: number;
  onChange: (v: number | null) => void;
}) {
  const [draft, setDraft] = useState(String(value ?? fallback));
  const on = value != null;
  return (
    <>
      <span />
      <div className={styles.formRow}>
        <Checkbox checked={on} onChange={(c) => onChange(c ? (parseSecs(draft) ?? fallback) : null)} label={label} />
        <Input
          className={styles.secondsInput}
          inputMode="numeric"
          aria-label={tx`${label} (seconds)`}
          disabled={!on}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            const n = parseSecs(e.target.value);
            if (n) onChange(n);
          }}
        />
        <span>
          <T>sec.</T>
        </span>
      </div>
    </>
  );
}

/** Schemas tab: "All …" or a choice of names and `*` / `?` patterns. */
function NamePicker({
  allLabel,
  addLabel,
  all,
  chosen,
  known,
  onAll,
  onChosen,
}: {
  /** "All databases" */
  allLabel: string;
  /** Accessible name of the pattern input. */
  addLabel: string;
  all: boolean;
  chosen: string[];
  known: string[];
  onAll: (all: boolean) => void;
  onChosen: (chosen: string[]) => void;
}) {
  const [pattern, setPattern] = useState("");
  const names = [...new Set([...known, ...chosen])];
  const add = () => {
    const p = pattern.trim();
    if (p && !chosen.includes(p)) onChosen([...chosen, p]);
    setPattern("");
  };
  return (
    <div className={styles.namePicker}>
      <Checkbox checked={all} onChange={onAll} label={allLabel} />
      {!all && (
        <div className={styles.nameList}>
          {names.map((n) => (
            <Checkbox
              key={n}
              checked={chosen.includes(n)}
              onChange={(c) => onChosen(c ? [...chosen, n] : chosen.filter((x) => x !== n))}
              label={n}
            />
          ))}
          <div className={styles.formRow}>
            <Input
              className={styles.fill}
              value={pattern}
              placeholder="Name or pattern, e.g. app_*"
              aria-label={addLabel}
              onChange={(e) => setPattern(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !isImeKey(e.nativeEvent)) {
                  e.preventDefault();
                  add();
                }
              }}
            />
            <Button disabled={!pattern.trim()} onClick={add}>
              <T>Add Pattern</T>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title }: { title: string }) {
  return (
    <div className={styles.formSection}>
      <T>{title}</T>
    </div>
  );
}

export function SourceDialog({
  initial,
  preset,
  presetPassword,
}: {
  initial: DataSource | null;
  preset?: Partial<DataSource>;
  presetPassword?: string | null;
}) {
  const tx = useTx();
  const txTemplate = useTxTemplate();
  const [s, setS] = useState<DataSource>(() => ({ ...blank(), ...preset, ...initial }));
  // `undefined`: unchanged (editing keeps the stored password).
  const [password, setPassword] = useState<string | undefined>(presetPassword ?? undefined);
  // Same convention for the SSH password / passphrase.
  const [sshSecret, setSshSecret] = useState<string | undefined>(undefined);
  const [tab, setTab] = useState<Tab>("general");
  const [test, setTest] = useState<{ ok: boolean; text: string; trust?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showComment, setShowComment] = useState(!!s.comment);
  // The URL being typed in default mode (null: show the fields' URL).
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const loadedDbs = useDatabase((st) => (initial?.id ? st.databases[initial.id] : undefined));
  const loadedSchemas = useDatabase((st) => (initial?.id ? st.schemas[initial.id] : undefined));

  const set = (patch: Partial<DataSource>) => setS((x) => ({ ...x, ...patch }));
  const ssh: DbSsh = { ...blankSsh(), ...s.ssh };
  const sshConfigs = useWorkflowSettings((w) => w.ssh.configs);
  const sshConfigId = ssh.config?.trim() ?? "";
  const sshConfig = sshConfigOf(ssh, sshConfigs);
  // The host / user / authentication in effect (the chosen SSH configuration's).
  const sshUsed: DbSsh = effectiveSsh(ssh, sshConfigs) ?? ssh;
  const setSsh = (patch: Partial<DbSsh>) => setS((x) => ({ ...x, ssh: { ...blankSsh(), ...x.ssh, ...patch } }));
  const options: DbOptions = { ...blankOptions(), ...s.options };
  const setOptions = (patch: Partial<DbOptions>) =>
    setS((x) => ({ ...x, options: { ...blankOptions(), ...x.options, ...patch } }));
  const intro: DbIntrospection = { ...blankIntrospection(), ...s.introspection };
  const setIntro = (patch: Partial<DbIntrospection>) =>
    setS((x) => ({ ...x, introspection: { ...blankIntrospection(), ...x.introspection, ...patch } }));
  const properties = s.properties ?? [];
  const setProperty = (i: number, patch: Partial<DbProperty>) =>
    set({ properties: properties.map((p, j) => (j === i ? { ...p, ...patch } : p)) });

  const vendor = vendorOf(s);
  const sqlite = s.driver === "sqlite";
  const postgres = s.driver === "postgres";
  const urlOnly = !sqlite && !!s.urlOnly;
  const parsedUrl = urlOnly ? parseSourceUrl(s.url ?? "") : null;
  const urlValid = !!parsedUrl && parsedUrl.source.driver === s.driver;
  const host = urlOnly ? (parsedUrl?.source.host ?? "") : (s.host ?? "");
  const database = urlOnly ? (parsedUrl?.source.database ?? "") : (s.database ?? "");
  const name =
    s.name?.trim() || (sqlite ? fileSourceName(s.file ?? "") : `${database || s.user || "db"}@${host || "localhost"}`);
  const sshOn = !sqlite && !!ssh.enabled;
  const valid = sqlite
    ? !!s.file?.trim()
    : (urlOnly ? urlValid : !!s.host?.trim()) && (!sshOn || sshTunnelReady(ssh, sshConfigs));
  const sslOn = (s.ssl ?? "prefer") !== "disable";

  /** What is saved / tested: a preset's port when the field was left empty. */
  const effective = (): DataSource => ({ ...s, name, port: s.port ?? (s.vendor ? vendor.port : null) });

  const setType = (id: string) => {
    const v = vendorById(id);
    if (!v) return;
    setS((x) => {
      const old = vendorOf(x);
      const port = x.port == null || x.port === old.port ? v.port : x.port;
      return { ...x, driver: v.driver, vendor: v.id === v.driver ? "" : v.id, port, ssl: v.ssl ?? x.ssl };
    });
  };

  /** Typing a URL in default mode fills the fields it names. */
  const typeUrl = (text: string) => {
    setUrlDraft(text);
    const p = parseSourceUrl(text);
    if (!p || p.source.driver !== s.driver) return;
    const { host: h, port, database: db, user, ssl, sslCaFile, sslCertFile, sslKeyFile, vendor: v } = p.source;
    set({
      host: h,
      port,
      database: db,
      ...(user ? { user } : {}),
      ...(ssl ? { ssl } : {}),
      ...(sslCaFile ? { sslCaFile } : {}),
      ...(sslCertFile ? { sslCertFile } : {}),
      ...(sslKeyFile ? { sslKeyFile } : {}),
      ...(v ? { vendor: v } : {}),
    });
    if (p.password) setPassword(p.password);
  };

  const setUrlOnly = (on: boolean) => set(on && !s.url?.trim() ? { urlOnly: on, url: sourceUrl(s) } : { urlOnly: on });

  const runTest = async () => {
    setBusy(true);
    setTest(null);
    try {
      const v = await call(commands.dbTest(effective(), password ?? null, sshOn ? (sshSecret ?? null) : null));
      setTest({ ok: true, text: tx`Succeeded: ${v}` });
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      const trust = e instanceof IpcError && connectRemedy(e.kind, e.message, { ssh: sshUsed }) === "trustHostKey";
      setTest({ ok: false, text, trust });
    } finally {
      setBusy(false);
    }
  };

  const trustAndRetry = async () => {
    // A shared SSH configuration records the failed host key under its own id.
    await call(sshConfigId ? commands.sshTrustHost(sshConfigId) : commands.dbTrustSshHost(s.id ?? ""));
    await runTest();
  };

  const save = async () => {
    setBusy(true);
    try {
      await saveSource(
        { ...effective(), properties: properties.filter((p) => p.name?.trim()) },
        sqlite ? undefined : password === undefined ? undefined : password || null,
        !sshOn || sshSecret === undefined || sshUsed.auth === "openSsh" ? undefined : sshSecret || null,
      );
      closeDialog();
    } catch (e) {
      setTest({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const loadNames = async () => {
    const id = initial?.id;
    if (!id) return;
    await Promise.all([postgres ? loadDatabases(id) : Promise.resolve(), loadSchemas(id)]);
  };

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "general", label: "General" },
    { id: "options", label: "Options" },
    ...(sqlite
      ? []
      : [
          { id: "ssh" as const, label: "SSH/SSL" },
          { id: "schemas" as const, label: "Schemas" },
        ]),
    { id: "advanced", label: "Advanced" },
  ];
  const current = tabs.some((t) => t.id === tab) ? tab : "general";
  const props = PROPERTIES[s.driver ?? "sqlite"]!;

  const general = (
    <>
      <span className={styles.formLabel}>
        <T>Driver:</T>
      </span>
      <Select aria-label="Data source type" value={vendor.id} options={TYPES} onChange={setType} />
      {sqlite ? (
        <FileField
          id="db-file"
          label="File:"
          value={s.file ?? ""}
          placeholder="path/to/database.db (absolute or project-relative)"
          title="SQLite Database File"
          onChange={(file) => set({ file: file || null })}
        />
      ) : (
        <>
          <span className={styles.formLabel}>
            <T>Connection type:</T>
          </span>
          <div className={styles.segmented} role="group" aria-label={tx("Connection type")}>
            <button type="button" aria-pressed={!urlOnly} onClick={() => setUrlOnly(false)}>
              <T>default</T>
            </button>
            <button type="button" aria-pressed={urlOnly} onClick={() => setUrlOnly(true)}>
              <T>URL only</T>
            </button>
          </div>
          {!urlOnly && (
            <>
              <label className={styles.formLabel} htmlFor="db-host">
                <T>Host:</T>
              </label>
              <div className={styles.formRow}>
                <Input
                  id="db-host"
                  className={styles.fill}
                  value={s.host ?? ""}
                  onChange={(e) => set({ host: e.target.value })}
                />
                <label className={styles.formLabel} htmlFor="db-port">
                  <T>Port:</T>
                </label>
                <Input
                  id="db-port"
                  className={styles.portInput}
                  inputMode="numeric"
                  value={s.port ?? ""}
                  placeholder={String(vendor.port ?? "")}
                  onChange={(e) => set({ port: parsePort(e.target.value) })}
                />
              </div>
            </>
          )}
          {sshOn && (
            <>
              <span />
              <span className={styles.formHint}>{tx`Reached from the SSH host ${sshLabel({ ssh: sshUsed })}.`}</span>
            </>
          )}
          <label className={styles.formLabel} htmlFor="db-user">
            <T>User:</T>
          </label>
          <Input
            id="db-user"
            value={s.user ?? ""}
            placeholder={urlOnly ? "from the URL" : ""}
            onChange={(e) => set({ user: e.target.value })}
          />
          <label className={styles.formLabel} htmlFor="db-password">
            <T>Password:</T>
          </label>
          <div className={styles.formRow}>
            <Input
              id="db-password"
              className={styles.fill}
              type="password"
              value={password ?? ""}
              placeholder={initial && password === undefined ? "<unchanged>" : ""}
              onChange={(e) => setPassword(e.target.value)}
            />
            <Checkbox
              checked={!!s.savePassword}
              onChange={(savePassword) => set({ savePassword })}
              label="Save password"
            />
          </div>
          {!urlOnly && (
            <>
              <label className={styles.formLabel} htmlFor="db-database">
                <T>Database:</T>
              </label>
              <Input id="db-database" value={s.database ?? ""} onChange={(e) => set({ database: e.target.value })} />
            </>
          )}
          <label className={styles.formLabel} htmlFor="db-url">
            <T>URL:</T>
          </label>
          <Input
            id="db-url"
            mono
            value={urlOnly ? (s.url ?? "") : (urlDraft ?? sourceUrl(s))}
            invalid={urlOnly ? !urlValid : urlDraft !== null && parseSourceUrl(urlDraft)?.source.driver !== s.driver}
            placeholder={sourceUrl(s)}
            onChange={(e) => (urlOnly ? set({ url: e.target.value }) : typeUrl(e.target.value))}
            onBlur={() => setUrlDraft(null)}
          />
          <span />
          <span className={styles.formHint}>
            {txTemplate(
              urlOnly
                ? urlValid || !s.url?.trim()
                  ? "Connects with the URL alone: host, port, database, SSL and parameters come from it."
                  : `Not a ${vendor.label} URL`
                : "Editing the URL fills in the settings above.",
            )}
          </span>
        </>
      )}
    </>
  );

  const optionsTab = (
    <>
      <Section title="Connection" />
      <span />
      <Checkbox checked={!!s.readOnly} onChange={(readOnly) => set({ readOnly })} label="Read-only" />
      <span className={styles.formLabel}>
        <T>Transaction control:</T>
      </span>
      <Select
        aria-label="Transaction control"
        className={styles.narrowSelect}
        value={options.transaction ?? "auto"}
        options={TX}
        onChange={(transaction) => setOptions({ transaction })}
      />
      {postgres && (
        <>
          <label className={styles.formLabel} htmlFor="db-default-schema">
            <T>Default schema:</T>
          </label>
          <Input
            id="db-default-schema"
            value={options.defaultSchema ?? ""}
            placeholder="public (search_path, e.g. app, public)"
            onChange={(e) => setOptions({ defaultSchema: e.target.value })}
          />
        </>
      )}
      {!sqlite && (
        <>
          <label className={styles.formLabel} htmlFor="db-time-zone">
            <T>Time zone:</T>
          </label>
          <Input
            id="db-time-zone"
            value={options.timeZone ?? ""}
            placeholder={
              postgres ? "Server default, e.g. UTC or Europe/Berlin" : "UTC (+00:00), e.g. Europe/Berlin or +08:00"
            }
            onChange={(e) => setOptions({ timeZone: e.target.value })}
          />
          <SecondsOption
            label="Run keep-alive query each"
            value={options.keepAliveSecs}
            fallback={60}
            onChange={(keepAliveSecs) => setOptions({ keepAliveSecs })}
          />
        </>
      )}
      <SecondsOption
        label="Auto-disconnect after"
        value={options.autoDisconnectSecs}
        fallback={300}
        onChange={(autoDisconnectSecs) => setOptions({ autoDisconnectSecs })}
      />
      {postgres && (
        <>
          <span />
          <Checkbox
            checked={!!options.singleDatabase}
            onChange={(singleDatabase) => setOptions({ singleDatabase })}
            label="Single database mode (show only the configured database)"
          />
        </>
      )}
      <label className={styles.formLabel} htmlFor="db-startup">
        <T>Startup script:</T>
      </label>
      <textarea
        id="db-startup"
        className={styles.textArea}
        spellCheck={false}
        value={options.startupScript ?? ""}
        placeholder={
          postgres
            ? "SET statement_timeout = '30s';"
            : sqlite
              ? "PRAGMA foreign_keys = ON;"
              : "SET SESSION sql_mode = 'ANSI';"
        }
        onChange={(e) => setOptions({ startupScript: e.target.value })}
      />
      <span />
      <span className={styles.formHint}>
        <T>Runs on every new connection, before any other statement.</T>
      </span>
    </>
  );

  const sshConfigOptions: SelectOption[] = [
    { value: "", label: "Custom (fields below)" },
    ...sshConfigs.map((c) => ({ value: c.id, label: c.name.trim() || configLabel(c) || c.id, detail: configLabel(c) })),
    ...(sshConfigId && !sshConfig ? [{ value: sshConfigId, label: tx`${sshConfigId} (missing)` }] : []),
  ];
  const sshTab = (
    <>
      <span />
      <Checkbox checked={!!ssh.enabled} onChange={(enabled) => setSsh({ enabled })} label="Use SSH tunnel" />
      <span className={styles.formLabel}>
        <T>Configuration:</T>
      </span>
      <Select
        aria-label="SSH configuration"
        disabled={!sshOn}
        value={sshConfigId}
        options={sshConfigOptions}
        onChange={(config) => setSsh({ config })}
      />
      {sshConfigId && (
        <>
          <span />
          <span className={styles.formHint}>
            {sshConfig ? (
              <>{txTemplate(`Connects to ${configLabel(sshConfig) || sshConfig.name}.`)} </>
            ) : (
              <span className={styles.bad}>{txTemplate(`SSH configuration ${sshConfigId} no longer exists.`)} </span>
            )}
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => void executeAction("file.settings", "tools.sshConfigurations")}
            >
              <T>Edit SSH Configurations…</T>
            </button>
          </span>
        </>
      )}
      {!sshConfigId && (
        <>
          <label className={styles.formLabel} htmlFor="db-ssh-host">
            <T>Host:</T>
          </label>
          <div className={styles.formRow}>
            <Input
              id="db-ssh-host"
              className={styles.fill}
              disabled={!sshOn}
              value={ssh.host ?? ""}
              placeholder={ssh.auth === "openSsh" ? "host or ~/.ssh/config alias" : "bastion.example.com"}
              onChange={(e) => setSsh({ host: e.target.value })}
            />
            <label className={styles.formLabel} htmlFor="db-ssh-port">
              <T>Port:</T>
            </label>
            <Input
              id="db-ssh-port"
              className={styles.portInput}
              inputMode="numeric"
              disabled={!sshOn}
              value={ssh.port ?? ""}
              placeholder="22"
              onChange={(e) => setSsh({ port: parsePort(e.target.value) })}
            />
          </div>
          <label className={styles.formLabel} htmlFor="db-ssh-user">
            <T>User:</T>
          </label>
          <Input
            id="db-ssh-user"
            disabled={!sshOn}
            value={ssh.user ?? ""}
            placeholder={ssh.auth === "openSsh" ? "from ~/.ssh/config" : ""}
            onChange={(e) => setSsh({ user: e.target.value })}
          />
          <span className={styles.formLabel}>
            <T>Authentication:</T>
          </span>
          <Select
            aria-label="SSH authentication type"
            disabled={!sshOn}
            value={ssh.auth ?? "openSsh"}
            options={SSH_AUTH}
            onChange={(auth) => setSsh({ auth })}
          />
          {ssh.auth === "keyPair" && (
            <FileField
              id="db-ssh-key"
              label="Private key:"
              value={ssh.keyFile ?? ""}
              placeholder="~/.ssh/id_ed25519"
              disabled={!sshOn}
              title="Private Key File"
              onChange={(keyFile) => setSsh({ keyFile })}
            />
          )}
        </>
      )}
      {sshUsed.auth === "openSsh" && !sshConfigId && (
        <>
          <span />
          <span className={styles.formHint}>
            <T>
              {"Uses HostName, User, Port, IdentityFile and ProxyJump from ~/.ssh/config, and keys of the SSH agent."}
            </T>
          </span>
        </>
      )}
      {sshUsed.auth !== "openSsh" && (
        <>
          <label className={styles.formLabel} htmlFor="db-ssh-secret">
            {tx(sshUsed.auth === "password" ? "Password:" : "Passphrase:")}
          </label>
          <div className={styles.formRow}>
            <Input
              id="db-ssh-secret"
              className={styles.fill}
              type="password"
              disabled={!sshOn}
              value={sshSecret ?? ""}
              placeholder={initial && sshSecret === undefined ? "<unchanged>" : ""}
              onChange={(e) => setSshSecret(e.target.value)}
            />
            {!sshConfigId && (
              <Checkbox
                checked={!!ssh.saveSecret}
                disabled={!sshOn}
                onChange={(saveSecret) => setSsh({ saveSecret })}
                label="Save password"
              />
            )}
          </div>
        </>
      )}
      <Section title="SSL" />
      <span className={styles.formLabel}>
        <T>Mode:</T>
      </span>
      <Select
        aria-label="SSL mode"
        className={styles.narrowSelect}
        value={s.ssl ?? "prefer"}
        options={SSL}
        onChange={(ssl) => set({ ssl })}
      />
      <FileField
        id="db-ssl-ca"
        label="CA file:"
        value={s.sslCaFile ?? ""}
        placeholder={s.ssl === "verifyCa" || s.ssl === "verifyFull" ? "System roots when empty" : ""}
        disabled={!sslOn}
        title="CA Certificate File"
        onChange={(sslCaFile) => set({ sslCaFile })}
      />
      <FileField
        id="db-ssl-cert"
        label="Client certificate file:"
        value={s.sslCertFile ?? ""}
        disabled={!sslOn}
        title="Client Certificate File"
        onChange={(sslCertFile) => set({ sslCertFile })}
      />
      <FileField
        id="db-ssl-key"
        label="Client key file:"
        value={s.sslKeyFile ?? ""}
        disabled={!sslOn}
        title="Client Key File"
        onChange={(sslKeyFile) => set({ sslKeyFile })}
      />
    </>
  );

  const knownDbs = loadedDbs?.status === "ok" ? loadedDbs.value.names : [];
  const knownSchemas = loadedSchemas?.status === "ok" ? loadedSchemas.value : [];
  const schemasTab = (
    <>
      <div className={styles.formWide}>
        {postgres && (
          <NamePicker
            allLabel={tx("All databases")}
            addLabel={tx("Add databases pattern")}
            all={intro.allDatabases !== false}
            chosen={intro.databases ?? []}
            known={knownDbs}
            onAll={(allDatabases) => setIntro({ allDatabases })}
            onChosen={(databases) => setIntro({ databases })}
          />
        )}
        <NamePicker
          allLabel={s.driver === "mysql" ? tx("All schemas (databases)") : tx("All schemas")}
          addLabel={s.driver === "mysql" ? tx("Add schemas (databases) pattern") : tx("Add schemas pattern")}
          all={intro.allSchemas !== false}
          chosen={intro.schemas ?? []}
          known={knownSchemas}
          onAll={(allSchemas) => setIntro({ allSchemas })}
          onChosen={(schemas) => setIntro({ schemas })}
        />
        <div className={styles.formRow}>
          <label className={styles.formLabel} htmlFor="db-object-filter">
            <T>Object filter:</T>
          </label>
          <Input
            id="db-object-filter"
            mono
            value={intro.objectFilter ?? ""}
            placeholder="e.g. order*, customers (tables, views, routines, sequences)"
            onChange={(e) => setIntro({ objectFilter: e.target.value })}
          />
        </div>
        <Checkbox
          checked={!!intro.showSystem}
          onChange={(showSystem) => setIntro({ showSystem })}
          label="Show internal system schemas"
        />
        {postgres && (
          <Checkbox
            checked={!!intro.showTemplates}
            onChange={(showTemplates) => setIntro({ showTemplates })}
            label="Show template databases"
          />
        )}
        <div className={styles.formRow}>
          <Button disabled={!initial?.id || busy} onClick={() => void loadNames()}>
            <T>Load Names from Server</T>
          </Button>
          <span className={styles.formHint}>
            {initial?.id
              ? tx(
                  "The Database tree shows only the checked names and patterns (* and ?); the connected database always shows.",
                )
              : tx("Save the data source to pick from the server's names; patterns (* and ?) work any time.")}
          </span>
        </div>
      </div>
    </>
  );

  const advancedTab = (
    <div className={styles.formWide}>
      <div className={styles.propertyTable} role="table" aria-label={tx("Driver properties")}>
        <div role="row" className={styles.propertyHead}>
          <span role="columnheader">
            <T>Name</T>
          </span>
          <span role="columnheader">
            <T>Value</T>
          </span>
          <span />
        </div>
        {properties.map((p, i) => (
          <div role="row" key={i} className={styles.propertyRow}>
            <Input
              aria-label="Property name"
              list="db-property-names"
              value={p.name ?? ""}
              placeholder="<user defined>"
              onChange={(e) => setProperty(i, { name: e.target.value })}
            />
            <Input
              aria-label="Property value"
              value={p.value ?? ""}
              placeholder="<value>"
              onChange={(e) => setProperty(i, { value: e.target.value })}
            />
            <IconButton
              icon="close"
              size="small"
              aria-label="Remove property"
              title="Remove"
              onClick={() => set({ properties: properties.filter((_, j) => j !== i) })}
            />
          </div>
        ))}
      </div>
      <datalist id="db-property-names">
        {props.names.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <div className={styles.formRow}>
        <Button icon="plus" onClick={() => set({ properties: [...properties, { name: "", value: "" }] })}>
          <T>Add Property</T>
        </Button>
      </div>
      <span className={styles.formHint}>
        <T>{props.hint}</T>
      </span>
    </div>
  );

  const body: Record<Tab, ReactNode> = {
    general,
    options: optionsTab,
    ssh: sshTab,
    schemas: schemasTab,
    advanced: advancedTab,
  };

  return (
    <Dialog
      open
      onClose={closeDialog}
      title={initial ? tx`Data Source: ${initial.name}` : "New Data Source"}
      width={640}
      footerStart={
        <Button onClick={() => void runTest()} disabled={busy || !valid}>
          <T>Test Connection</T>
        </Button>
      }
      buttons={[
        { label: "Cancel", role: "cancel" },
        { label: "OK", role: "default", disabled: busy || !valid, onClick: () => void save() },
      ]}
    >
      <div className={styles.form}>
        <label className={styles.formLabel} htmlFor="db-name">
          <T>Name:</T>
        </label>
        <div className={styles.formRow}>
          <Input
            id="db-name"
            className={styles.fill}
            value={s.name ?? ""}
            placeholder={name}
            onChange={(e) => set({ name: e.target.value })}
          />
          <span className={styles.formLabel}>
            <T>Color:</T>
          </span>
          <Select
            aria-label="Color"
            className={styles.narrowSelect}
            value={s.color ?? "none"}
            options={COLORS}
            onChange={(c) => set({ color: c === "none" ? null : c })}
            renderValue={(o) => (
              <span className={styles.colorValue}>
                {o && o.value !== "none" && (
                  <span className={styles.colorSwatch} style={{ background: colorVar(o.value as DbColor) }} />
                )}
                <T>{o?.label ?? "No color"}</T>
              </span>
            )}
          />
        </div>
        <span />
        {showComment ? (
          <textarea
            className={styles.textArea}
            aria-label={tx("Comment")}
            autoFocus={!s.comment}
            rows={2}
            value={s.comment ?? ""}
            placeholder={tx("Comment")}
            onChange={(e) => set({ comment: e.target.value })}
          />
        ) : (
          <button type="button" className={styles.linkButton} onClick={() => setShowComment(true)}>
            <T>Add comment</T>
          </button>
        )}
      </div>
      <Tabs
        variant="compact"
        className={styles.dialogTabs}
        activeId={current}
        onSelect={(id) => setTab(id as Tab)}
        aria-label="Data source settings"
        panelIdPrefix="db-source"
        items={tabs}
      />
      <div className={styles.form} role="tabpanel" id={`db-source-panel-${current}`}>
        {body[current]}
        <div className={`${styles.testResult} ${test?.ok ? styles.ok : styles.bad}`} role="status">
          {busy && !test ? tx("Connecting…") : test?.text}
          {test?.trust && (
            <>
              {" "}
              <Button size="small" onClick={() => void trustAndRetry()} disabled={busy}>
                <T>Trust Host and Retry</T>
              </Button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
