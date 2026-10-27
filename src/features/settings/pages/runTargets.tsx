/**
 * Build, Execution, Deployment › Run Targets: SSH hosts run configurations can
 * run on (`RunConfig.target`). Consumed by `ide-run` and the run feature.
 */
import { useCallback, useEffect, useId, useState } from "react";
import clsx from "clsx";
import { call, commands, isTauri, type RemoteEntry } from "@/platform/ipc";
import { useTx } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { DEFAULT_RUN_TARGET, newRemoteId, type RunTargetValid } from "@/platform/remoteSettings";
import { Button, Checkbox, Dialog, Icon, IconButton, Input, T } from "@/ui";
import { Row, Section } from "../components/Form";
import { useSetting } from "../components/context";
import { SshConfigSelect, useSshConfigs } from "../components/SshConfigSelect";
import { BUILD_GROUP } from "./execution";
import type { PageSpec } from "./spec";
import styles from "./Workflow.module.css";
import own from "./RunTargets.module.css";

/** Parent of a remote path (`~/a` → `~`, `/a` → `/`); null at the top. */
export function parentPath(path: string): string | null {
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (p === "/" || p === "~" || p === "") return null;
  const i = p.lastIndexOf("/");
  if (i < 0) return null;
  return i === 0 ? "/" : p.slice(0, i);
}

const UNKNOWN_HOST = /^Unknown SSH host key/;
const NEEDS_SECRET = /^SSH (password|key passphrase) required|passphrase required|^cannot decrypt SSH key/;

function RemoteFolderDialog({
  sshConfig,
  initial,
  onClose,
  onChoose,
}: {
  sshConfig: string;
  initial: string;
  onClose: () => void;
  onChoose: (path: string) => void;
}) {
  const tx = useTx();
  const [path, setPath] = useState(initial || "~");
  const [pathText, setPathText] = useState(initial || "~");
  const [entries, setEntries] = useState<RemoteEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  // The listed folder; `path` may then switch to its absolute form without listing again.
  const [request, setRequest] = useState(() => ({ path: initial || "~" }));

  useEffect(() => {
    let live = true;
    call(commands.remoteList(sshConfig, request.path)).then(
      (list) => {
        if (!live) return;
        setEntries(list.filter((e) => e.isDir).sort((a, b) => a.name.localeCompare(b.name)));
        // `~` and relative paths become absolute once an entry tells where they are.
        const absolute = list[0] ? parentPath(list[0].path) : null;
        if (absolute && absolute !== request.path) {
          setPath(absolute);
          setPathText(absolute);
        }
      },
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [sshConfig, request]);

  const go = useCallback((next: string) => {
    setEntries(null);
    setError(null);
    setSelected(null);
    setPath(next);
    setPathText(next);
    setRequest({ path: next });
  }, []);
  const retry = () => go(path);
  const trust = async () => {
    try {
      await call(commands.sshTrustHost(sshConfig));
      retry();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const sendSecret = async () => {
    await commands.sshSetSecret(sshConfig, secret, false);
    setSecret("");
    retry();
  };
  const parent = parentPath(path);
  const chosen = selected ?? path;

  return (
    <Dialog
      open
      title="Select Folder on Target"
      onClose={onClose}
      width={520}
      buttons={[
        { label: "OK", role: "default", disabled: !!error, onClick: () => onChoose(chosen) },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={own.browser}>
        <div className={own.browserPath}>
          <IconButton
            icon="arrow-up"
            size="small"
            title="Parent Folder"
            disabled={!parent}
            onClick={() => parent && go(parent)}
          />
          <Input
            mono
            className={own.pathInput}
            aria-label="Remote path"
            value={pathText}
            onChange={(e) => setPathText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && pathText.trim()) {
                e.preventDefault();
                go(pathText.trim());
              }
            }}
          />
          <IconButton icon="refresh" size="small" title="Refresh" onClick={retry} />
        </div>
        <div className={own.browserList} role="listbox" aria-label={tx("Remote folders")}>
          {error ? (
            <div className={own.browserError} role="alert">
              <span>{error}</span>
              {UNKNOWN_HOST.test(error) && (
                <span>
                  <Button size="small" onClick={() => void trust()}>
                    Trust Host
                  </Button>
                </span>
              )}
              {NEEDS_SECRET.test(error) && (
                <span className={own.browserAuth}>
                  <Input
                    type="password"
                    aria-label="Password or passphrase"
                    placeholder={tx("Password or passphrase")}
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void sendSecret()}
                  />
                  <Button size="small" onClick={() => void sendSecret()}>
                    Connect
                  </Button>
                </span>
              )}
            </div>
          ) : entries === null ? (
            <div className={own.browserStatus}>
              <T>Loading…</T>
            </div>
          ) : entries.length === 0 ? (
            <div className={own.browserStatus}>
              <T>No subfolders</T>
            </div>
          ) : (
            entries.map((e) => (
              <button
                key={e.path}
                type="button"
                role="option"
                aria-selected={selected === e.path}
                className={clsx(own.browserRow, selected === e.path && own.browserRowSelected)}
                onClick={() => setSelected(e.path)}
                onDoubleClick={() => go(e.path)}
              >
                <Icon name="folder" size={14} />
                <span>{e.name}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </Dialog>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <Row label={label} htmlFor={id} className={styles.alignedRow}>
      <Input
        id={id}
        mono
        className={styles.wide}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </Row>
  );
}

function ProjectFolderField({ target, onChange }: { target: RunTargetValid; onChange: (v: string) => void }) {
  const projectName = useProject((s) => s.project?.name ?? "project");
  const [browsing, setBrowsing] = useState(false);
  const id = useId();
  return (
    <Row
      label="Project folder on target"
      htmlFor={id}
      className={styles.alignedRow}
      hint="Files are uploaded here and the working directory is mapped into it."
    >
      <span className={own.pathField}>
        <Input
          id={id}
          mono
          className={styles.wide}
          value={target.projectRoot}
          placeholder={`~/${projectName}`}
          onChange={(e) => onChange(e.target.value)}
        />
        <Button size="small" disabled={!target.sshConfig || !isTauri()} onClick={() => setBrowsing(true)}>
          Browse…
        </Button>
      </span>
      {browsing && (
        <RemoteFolderDialog
          sshConfig={target.sshConfig}
          initial={target.projectRoot || "~"}
          onClose={() => setBrowsing(false)}
          onChoose={(path) => {
            setBrowsing(false);
            onChange(path);
          }}
        />
      )}
    </Row>
  );
}

function RunTargetsEditor() {
  const [raw, setTargets] = useSetting<RunTargetValid[] | undefined>("runTargets");
  const targets = raw ?? [];
  const sshConfigs = useSshConfigs();
  const [selected, setSelected] = useState<string | null>(targets[0]?.id ?? null);
  const current = targets.find((t) => t.id === selected) ?? null;
  const index = current ? targets.indexOf(current) : -1;
  const sshName = (id: string) => {
    const c = sshConfigs.find((x) => x.id === id);
    return c ? c.name || c.host : id;
  };

  const update = (patch: Partial<RunTargetValid>) => {
    if (!current) return;
    setTargets(targets.map((t) => (t.id === current.id ? { ...t, ...patch } : t)));
  };
  const add = (base?: RunTargetValid) => {
    const target: RunTargetValid = base
      ? { ...base, id: newRemoteId("target"), name: `${base.name} (copy)` }
      : {
          ...DEFAULT_RUN_TARGET,
          id: newRemoteId("target"),
          name: `Target ${targets.length + 1}`,
          sshConfig: sshConfigs[0]?.id ?? "",
        };
    setTargets([...targets, target]);
    setSelected(target.id);
  };
  const remove = () => {
    if (!current) return;
    const rest = targets.filter((t) => t.id !== current.id);
    setTargets(rest);
    setSelected(rest[Math.min(index, rest.length - 1)]?.id ?? null);
  };
  const move = (d: -1 | 1) => {
    const j = index + d;
    if (index < 0 || j < 0 || j >= targets.length) return;
    const next = [...targets];
    [next[index], next[j]] = [next[j]!, next[index]!];
    setTargets(next);
  };

  return (
    <div className={styles.toolsLayout}>
      <div className={styles.tableBox}>
        <div className={styles.toolbar} role="toolbar" aria-label="Run targets actions">
          <IconButton icon="plus" title="Add" size="small" onClick={() => add()} />
          <IconButton icon="minus" title="Remove" size="small" disabled={!current} onClick={remove} />
          <IconButton
            icon="copy"
            title="Copy"
            size="small"
            disabled={!current}
            onClick={() => current && add(current)}
          />
          <IconButton icon="arrow-up" title="Move Up" size="small" disabled={index <= 0} onClick={() => move(-1)} />
          <IconButton
            icon="arrow-down"
            title="Move Down"
            size="small"
            disabled={index < 0 || index >= targets.length - 1}
            onClick={() => move(1)}
          />
        </div>
        <div className={styles.toolList} role="listbox" aria-label="Run targets">
          {targets.length === 0 && (
            <div className={clsx(styles.toolRow, styles.empty)}>
              <T>No run targets. Click + to add one.</T>
            </div>
          )}
          {targets.map((t) => (
            <div
              key={t.id}
              role="option"
              aria-selected={t.id === selected}
              className={clsx(styles.toolRow, t.id === selected && styles.toolRowSelected)}
              onMouseDown={() => setSelected(t.id)}
            >
              <span>{t.name || t.id}</span>
              <span className={styles.toolGroup}>{t.sshConfig ? sshName(t.sshConfig) : ""}</span>
            </div>
          ))}
        </div>
      </div>
      {current && (
        <Section title="Target Settings">
          <TextField label="Name" value={current.name} onChange={(name) => update({ name })} />
          <Row label="SSH configuration" className={styles.alignedRow}>
            <SshConfigSelect value={current.sshConfig} onChange={(sshConfig) => update({ sshConfig })} />
          </Row>
          <ProjectFolderField target={current} onChange={(projectRoot) => update({ projectRoot })} />
          <Checkbox
            checked={current.syncBeforeRun}
            onChange={(syncBeforeRun) => update({ syncBeforeRun })}
            label="Upload changed project files before each run"
          />
          <TextField
            label="Python interpreter"
            value={current.python}
            onChange={(python) => update({ python })}
            placeholder="python3"
          />
          <TextField
            label="Node.js interpreter"
            value={current.node}
            onChange={(node) => update({ node })}
            placeholder="node"
          />
          <TextField
            label="Java executable"
            value={current.java}
            onChange={(java) => update({ java })}
            placeholder="java"
          />
        </Section>
      )}
      <div className={styles.note}>
        <T>
          {
            "Choose a target under “Run on” in a run configuration. Interpreters left empty are looked up on the target's PATH. SSH configurations are managed in Tools › SSH Configurations."
          }
        </T>
      </div>
    </div>
  );
}

export const RUN_TARGET_PAGES: PageSpec[] = [
  {
    id: "build.runTargets",
    title: "Run Targets",
    group: BUILD_GROUP,
    order: 364,
    projectScope: true,
    keywords: ["ssh", "remote", "target", "run on", "interpreter", "upload", "sync"],
    sections: [
      {
        options: [
          {
            kind: "custom",
            label: "Run Targets",
            keywords: [
              "SSH configuration",
              "Project folder on target",
              "Upload changed project files before each run",
              "Python interpreter",
              "Node.js interpreter",
              "Java executable",
            ],
            component: RunTargetsEditor,
          },
        ],
      },
    ],
  },
];
