/**
 * Build, Execution, Deployment › Deployment: SFTP servers (connection, path
 * mappings, excluded remote paths) and the transfer options. Consumed by the
 * deployment feature and `ide-remote` (automatic upload, remote delete).
 */
import { useEffect, useId, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { call, commands, IpcError, type RemoteEntry } from "@/platform/ipc";
import { useTx } from "@/platform/i18n";
import type { DeploymentServerValid } from "@/platform/remoteSettings";
import { Badge, Button, Checkbox, Dialog, Icon, IconButton, Input, Spinner, T, Tabs } from "@/ui";
import { GlobListEditor, Row } from "../components/Form";
import { SshConfigSelect, useSshConfigs } from "../components/SshConfigSelect";
import { useSetting } from "../components/context";
import {
  addMapping,
  fixDefaultServer,
  formatExcludes,
  newServer,
  parseExcludes,
  remoteParent,
  removeMapping,
  updateMapping,
} from "./deploymentModel";
import { BUILD_GROUP } from "./execution";
import type { PageSpec } from "./spec";
import { sshTestRemedy } from "./sshConnection";
import { PageLink } from "./workflowControls";
import workflow from "./Workflow.module.css";
import styles from "./Deployment.module.css";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------------------
// Connection problems: trust an unknown host key or enter the password.

function ConnectionProblem({ ssh, error, onRetry }: { ssh: string; error: unknown; onRetry: () => void }) {
  const auth = useSshConfigs().find((c) => c.id === ssh)?.auth ?? "openSsh";
  const message = errorText(error);
  const remedy = sshTestRemedy(error instanceof IpcError ? error.kind : undefined, message, auth);
  const [secret, setSecret] = useState("");
  const [save, setSave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const run = async (step: () => Promise<unknown>) => {
    setBusy(true);
    setFailure(null);
    try {
      await step();
      onRetry();
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.problem}>
      <span className={styles.error}>{message}</span>
      {remedy === "trustHostKey" && (
        <span>
          <Button size="small" disabled={busy} onClick={() => void run(() => call(commands.sshTrustHost(ssh)))}>
            <T>Trust Host Key and Retry</T>
          </Button>
        </span>
      )}
      {remedy === "secret" && (
        <form
          className={styles.secretRow}
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => commands.sshSetSecret(ssh, secret, save));
          }}
        >
          <Input
            type="password"
            autoFocus
            className={workflow.medium}
            value={secret}
            aria-label="Password or passphrase"
            placeholder="Password or passphrase"
            onChange={(e) => setSecret(e.target.value)}
          />
          <Checkbox checked={save} onChange={setSave} label="Save" />
          <Button size="small" type="submit" disabled={busy || !secret}>
            <T>Connect</T>
          </Button>
        </form>
      )}
      {failure && <span className={styles.error}>{failure}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Remote folder chooser (Root path › Browse…)

function RemoteFolderDialog({
  ssh,
  initial,
  onChoose,
  onClose,
}: {
  ssh: string;
  initial: string;
  onChoose: (path: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState(initial.trim() || "~");
  const [draft, setDraft] = useState(path);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; folders?: RemoteEntry[]; error?: unknown } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const key = `${path}\n${attempt}`;
  const current = result?.key === key ? result : null;
  const folders = current ? (current.folders ?? []) : null;
  const error = current?.error ?? null;

  useEffect(() => {
    let live = true;
    call(commands.remoteList(ssh, path)).then(
      (entries) => {
        if (!live) return;
        // `~` lists the login folder: name it by the absolute path the entries report.
        const first = entries[0];
        if ((path === "~" || path === "") && first) {
          const abs = remoteParent(first.path);
          setPath(abs);
          setDraft(abs);
        }
        const dirs = entries.filter((e) => e.isDir).sort((a, b) => a.name.localeCompare(b.name));
        setResult({ key, folders: dirs });
      },
      (e: unknown) => live && setResult({ key, error: e ?? "error" }),
    );
    return () => {
      live = false;
    };
  }, [ssh, path, key]);

  const go = (next: string) => {
    setDraft(next);
    setPath(next);
    setSelected(null);
  };
  const reload = () => {
    setAttempt((n) => n + 1);
    setSelected(null);
  };
  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (!folders?.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const d = e.key === "ArrowDown" ? 1 : -1;
      setSelected((s) => (s === null ? 0 : Math.max(0, Math.min(folders.length - 1, s + d))));
    } else if (e.key === "Enter" && selected !== null) {
      e.preventDefault();
      go(folders[selected]!.path);
    } else if (e.key === "Backspace") {
      e.preventDefault();
      go(remoteParent(path));
    }
  };
  const chosen = selected !== null && folders?.[selected] ? folders[selected]!.path : path;

  return (
    <Dialog
      open
      title="Choose Remote Folder"
      onClose={onClose}
      width={520}
      buttons={[
        { label: "Cancel", role: "cancel" },
        { label: "OK", role: "default", disabled: !!error || chosen === "~", onClick: () => onChoose(chosen) },
      ]}
    >
      <div className={styles.chooser}>
        <form
          className={styles.chooserPath}
          onSubmit={(e) => {
            e.preventDefault();
            go(draft.trim() || "~");
          }}
        >
          <IconButton
            icon="arrow-up"
            size="small"
            title="Parent Folder"
            disabled={path === "/" || path === "~"}
            onClick={() => go(remoteParent(path))}
          />
          <Input mono value={draft} aria-label="Remote path" onChange={(e) => setDraft(e.target.value)} />
          <IconButton icon="refresh" size="small" title="Refresh" onClick={reload} />
        </form>
        {error ? (
          <ConnectionProblem ssh={ssh} error={error} onRetry={reload} />
        ) : (
          <ul
            className={styles.folderList}
            role="listbox"
            aria-label="Remote folders"
            tabIndex={0}
            onKeyDown={onListKey}
          >
            {!current && (
              <li className={styles.center}>
                <Spinner /> <T>Loading…</T>
              </li>
            )}
            {folders?.length === 0 && (
              <li className={styles.center}>
                <T>No subfolders</T>
              </li>
            )}
            {folders?.map((f, i) => (
              <li
                key={f.path}
                role="option"
                aria-selected={selected === i}
                className={clsx(styles.folderRow, selected === i && styles.folderSelected)}
                onMouseDown={() => setSelected(i)}
                onDoubleClick={() => go(f.path)}
              >
                <Icon name="folder" />
                <span>{f.name}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Server editor

function TextField({
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
  return (
    <Row label={label} htmlFor={id}>
      <Input
        id={id}
        mono={mono}
        className={styles.wide}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </Row>
  );
}

type TestState =
  | { ssh: string; kind: "busy" }
  | { ssh: string; kind: "ok"; count: number }
  | { ssh: string; kind: "error"; error: unknown };

function ConnectionTab({
  server,
  update,
}: {
  server: DeploymentServerValid;
  update: (patch: Partial<DeploymentServerValid>) => void;
}) {
  const [browsing, setBrowsing] = useState(false);
  const [result, setTest] = useState<TestState | null>(null);
  const test = result?.ssh === server.sshConfig ? result : null;
  const rootId = useId();

  const runTest = async () => {
    const ssh = server.sshConfig;
    setTest({ ssh, kind: "busy" });
    try {
      const entries = await call(commands.remoteList(ssh, server.rootPath.trim() || "~"));
      setTest({ ssh, kind: "ok", count: entries.length });
    } catch (e) {
      setTest({ ssh, kind: "error", error: e });
    }
  };

  return (
    <div className={styles.panel}>
      <TextField label="Name" value={server.name} onChange={(name) => update({ name })} />
      <Row label="SSH configuration">
        <SshConfigSelect value={server.sshConfig} onChange={(sshConfig) => update({ sshConfig })} />
        <PageLink page="tools.sshConfigurations">
          <T>Configure…</T>
        </PageLink>
      </Row>
      <Row label="Root path" htmlFor={rootId} hint="Mappings' deployment paths are relative to this folder.">
        <span className={styles.field}>
          <Input
            id={rootId}
            mono
            className={styles.wide}
            value={server.rootPath}
            placeholder="Login folder"
            onChange={(e) => update({ rootPath: e.target.value })}
          />
          <Button size="small" disabled={!server.sshConfig} onClick={() => setBrowsing(true)}>
            <T>Browse…</T>
          </Button>
        </span>
      </Row>
      <TextField
        label="Web server URL"
        value={server.webUrl}
        onChange={(webUrl) => update({ webUrl })}
        placeholder="http://example.com"
      />
      <div className={styles.testRow}>
        <Button size="small" disabled={!server.sshConfig || test?.kind === "busy"} onClick={() => void runTest()}>
          <T>Test Connection</T>
        </Button>
        {test?.kind === "busy" && <Spinner />}
        {test?.kind === "ok" && (
          <span className={styles.ok}>
            <T>Connected successfully</T>
          </span>
        )}
      </div>
      {test?.kind === "error" && (
        <ConnectionProblem ssh={server.sshConfig} error={test.error} onRetry={() => void runTest()} />
      )}
      {browsing && (
        <RemoteFolderDialog
          ssh={server.sshConfig}
          initial={server.rootPath}
          onClose={() => setBrowsing(false)}
          onChoose={(rootPath) => {
            update({ rootPath });
            setBrowsing(false);
          }}
        />
      )}
    </div>
  );
}

const MAPPING_COLUMNS = [
  { key: "local", title: "Local path", placeholder: "Project root" },
  { key: "deployment", title: "Deployment path", placeholder: "Root path" },
  { key: "web", title: "Web path", placeholder: "/" },
] as const;

function MappingsTab({
  server,
  update,
}: {
  server: DeploymentServerValid;
  update: (patch: Partial<DeploymentServerValid>) => void;
}) {
  const tx = useTx();
  const [selected, setSelected] = useState<number | null>(null);
  const mappings = server.mappings;
  return (
    <div className={styles.panel}>
      <div className={workflow.tableBox}>
        <div className={workflow.toolbar} role="toolbar" aria-label="Mappings actions">
          <IconButton
            icon="plus"
            title="Add"
            size="small"
            onClick={() => {
              update({ mappings: addMapping(mappings) });
              setSelected(mappings.length);
            }}
          />
          <IconButton
            icon="minus"
            title="Remove"
            size="small"
            disabled={selected === null}
            onClick={() => {
              if (selected === null) return;
              update({ mappings: removeMapping(mappings, selected) });
              setSelected(null);
            }}
          />
        </div>
        <table className={styles.mappingTable} aria-label="Mappings">
          <thead>
            <tr>
              {MAPPING_COLUMNS.map((c) => (
                <th key={c.key}>{tx(c.title)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {mappings.length === 0 && (
              <tr>
                <td colSpan={3} className={workflow.empty}>
                  <T>No mappings: nothing is deployed</T>
                </td>
              </tr>
            )}
            {mappings.map((m, i) => (
              <tr
                key={i}
                aria-selected={selected === i}
                className={clsx(selected === i && styles.selectedRow)}
                onFocus={() => setSelected(i)}
                onMouseDown={() => setSelected(i)}
              >
                {MAPPING_COLUMNS.map((c) => (
                  <td key={c.key}>
                    <Input
                      mono
                      variant="bare"
                      className={styles.cellInput}
                      value={m[c.key]}
                      placeholder={tx(c.placeholder)}
                      aria-label={`${tx(c.title)} ${i + 1}`}
                      onChange={(e) => update({ mappings: updateMapping(mappings, i, { [c.key]: e.target.value }) })}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={styles.note}>
        <T>
          {
            "Local paths are relative to the project root (empty: the whole project); deployment paths are relative to the server's root path."
          }
        </T>
      </div>
    </div>
  );
}

function ExcludedPathsTab({
  server,
  update,
}: {
  server: DeploymentServerValid;
  update: (patch: Partial<DeploymentServerValid>) => void;
}) {
  return (
    <div className={styles.panel}>
      <GlobListEditor
        value={server.excludedPaths}
        onChange={(excludedPaths) => update({ excludedPaths })}
        placeholder="/var/www/app/cache"
        emptyText="No excluded paths"
        itemLabel="Remote path"
        aria-label="Excluded remote paths"
      />
      <div className={styles.note}>
        <T>Remote paths that are never uploaded to, downloaded from or deleted.</T>
      </div>
    </div>
  );
}

type ServerTab = "connection" | "mappings" | "excluded";

function DeploymentServersEditor() {
  const tx = useTx();
  const [servers, setServers] = useSetting<DeploymentServerValid[]>("deployment.servers");
  const [defaultServer, setDefaultServer] = useSetting<string>("deployment.defaultServer");
  const list = servers ?? [];
  const [selected, setSelected] = useState<string | null>(list[0]?.id ?? null);
  const [tab, setTab] = useState<ServerTab>("connection");
  const current = list.find((s) => s.id === selected) ?? null;
  const effectiveDefault = fixDefaultServer(list, defaultServer ?? "");

  const commit = (next: DeploymentServerValid[]) => {
    setServers(next);
    const d = fixDefaultServer(next, defaultServer ?? "");
    if (d !== (defaultServer ?? "")) setDefaultServer(d);
  };
  const update = (patch: Partial<DeploymentServerValid>) => {
    if (current) commit(list.map((s) => (s.id === current.id ? { ...s, ...patch } : s)));
  };
  const add = (base?: DeploymentServerValid) => {
    const server = newServer(list, base);
    commit([...list, server]);
    setSelected(server.id);
    setTab("connection");
  };
  const remove = () => {
    if (!current) return;
    const index = list.indexOf(current);
    const rest = list.filter((s) => s.id !== current.id);
    commit(rest);
    setSelected(rest[Math.min(index, rest.length - 1)]?.id ?? null);
  };

  return (
    <div className={styles.layout}>
      <div className={workflow.tableBox}>
        <div className={workflow.toolbar} role="toolbar" aria-label="Deployment servers actions">
          <IconButton icon="plus" title="Add" size="small" onClick={() => add()} />
          <IconButton icon="minus" title="Remove" size="small" disabled={!current} onClick={remove} />
          <IconButton
            icon="copy"
            title="Copy"
            size="small"
            disabled={!current}
            onClick={() => current && add(current)}
          />
          <IconButton
            icon="check"
            title="Use as Default"
            size="small"
            disabled={!current || current.id === effectiveDefault}
            onClick={() => current && setDefaultServer(current.id)}
          />
        </div>
        <div className={styles.serverList} role="listbox" aria-label="Deployment servers">
          {list.length === 0 && (
            <div className={styles.empty}>
              <T>No servers. Click + to add one.</T>
            </div>
          )}
          {list.map((s) => (
            <div
              key={s.id}
              role="option"
              aria-selected={s.id === selected}
              className={clsx(styles.serverRow, s.id === selected && styles.serverSelected)}
              onMouseDown={() => setSelected(s.id)}
            >
              <Icon name="web" />
              <span className={clsx(styles.serverName, s.id === effectiveDefault && styles.default)}>
                {s.name || s.id}
              </span>
              {s.id === effectiveDefault && <Badge tone="accent">{tx("default")}</Badge>}
            </div>
          ))}
        </div>
      </div>
      {current ? (
        <div className={styles.detail}>
          <Tabs
            variant="compact"
            aria-label="Server settings"
            activeId={tab}
            onSelect={(id) => setTab(id as ServerTab)}
            items={[
              { id: "connection", label: tx("Connection") },
              { id: "mappings", label: tx("Mappings") },
              { id: "excluded", label: tx("Excluded Paths") },
            ]}
          />
          {tab === "connection" && <ConnectionTab key={current.id} server={current} update={update} />}
          {tab === "mappings" && <MappingsTab key={current.id} server={current} update={update} />}
          {tab === "excluded" && <ExcludedPathsTab server={current} update={update} />}
        </div>
      ) : (
        <div className={styles.note}>
          <T>Add an SFTP server to upload, download and synchronize project files.</T>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Options

function ExcludeNamesRow() {
  const [names, setNames] = useSetting<string[]>("deployment.exclude");
  const [draft, setDraft] = useState<string | null>(null);
  const id = useId();
  return (
    <Row
      label="Exclude items by name"
      htmlFor={id}
      hint="Names or wildcards separated by “;”, e.g. .git;*.pyc. Matching files and folders are never transferred."
    >
      <Input
        id={id}
        mono
        className={workflow.wide}
        value={draft ?? formatExcludes(names ?? [])}
        onChange={(e) => {
          setDraft(e.target.value);
          setNames(parseExcludes(e.target.value));
        }}
        onBlur={() => setDraft(null)}
      />
    </Row>
  );
}

export const DEPLOYMENT_PAGES: PageSpec[] = [
  {
    id: "build.deployment",
    title: "Deployment",
    group: BUILD_GROUP,
    order: 365,
    projectScope: true,
    defaultScope: "project",
    keywords: ["sftp", "ssh", "server", "upload", "remote host", "mappings", "web server", "deploy"],
    sections: [
      {
        options: [
          {
            kind: "custom",
            label: "Deployment servers",
            keywords: [
              "Connection",
              "Mappings",
              "Excluded Paths",
              "Root path",
              "Web server URL",
              "SSH configuration",
              "Test Connection",
              "Use as Default",
              "Local path",
              "Deployment path",
              "Web path",
            ],
            component: DeploymentServersEditor,
          },
        ],
      },
    ],
  },
  {
    id: "build.deployment.options",
    title: "Options",
    order: 0,
    projectScope: true,
    defaultScope: "project",
    keywords: ["deployment", "upload", "exclude", "timestamps", "automatic upload", "sftp"],
    sections: [
      {
        options: [
          {
            kind: "custom",
            label: "Exclude items by name",
            keywords: ["exclude"],
            component: ExcludeNamesRow,
          },
          {
            kind: "select",
            key: "deployment.autoUpload",
            label: "Upload changed files automatically to the default server",
            options: [
              { value: "never", label: "Never" },
              { value: "onExplicitSave", label: "On explicit save action" },
              { value: "always", label: "Always" },
            ],
          },
          { kind: "toggle", key: "deployment.deleteRemote", label: "Delete remote files when local are deleted" },
          { kind: "toggle", key: "deployment.preserveTimestamps", label: "Preserve files timestamps" },
        ],
      },
    ],
  },
];
