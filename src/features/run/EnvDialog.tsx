import { readClipboardPlainText, writeClipboardText } from "@/platform/clipboard";
import { useEffect, useState } from "react";
import clsx from "clsx";
import { commands, isTauri, type RunConfig } from "@/platform/ipc";
import { useTx, useTxTemplate } from "@/platform/i18n";
import { Checkbox, Dialog, IconButton, Input, T } from "@/ui";
import { parseEnv } from "./configs";
import styles from "./Run.module.css";

export interface EnvRow {
  key: string;
  value: string;
}

export const envRows = (env: RunConfig["env"]): EnvRow[] => Object.entries(env).map(([key, value]) => ({ key, value }));

/** Env map from table rows; blank rows are ignored. */
export function envFromRows(rows: readonly EnvRow[]): { env: RunConfig["env"]; error?: string } {
  const env: RunConfig["env"] = {};
  for (const r of rows) {
    const key = r.key.trim();
    if (!key && !r.value) continue;
    if (!key) return { env, error: "Environment variable names can't be empty" };
    if (key in env) return { env, error: `Duplicate environment variable: ${key}` };
    env[key] = r.value;
  }
  return { env };
}

/** Rows as `NAME=value` lines (what Copy puts on the clipboard). */
export const rowsText = (rows: readonly EnvRow[]) => rows.map((r) => `${r.key}=${r.value}`).join("\n");

/** Pasted variables replace rows with the same name and are appended otherwise. */
export function pasteRows(rows: readonly EnvRow[], text: string): EnvRow[] {
  const out = rows.filter((r) => r.key || r.value).map((r) => ({ ...r }));
  for (const p of parseEnv(text)) {
    const existing = out.find((r) => r.key === p.key);
    if (existing) existing.value = p.value;
    else out.push(p);
  }
  return out;
}

async function writeClipboard(text: string) {
  try {
    await writeClipboardText(text);
  } catch {
    /* clipboard unavailable */
  }
}

/** IDEA's Environment Variables dialog: user variables, and the inherited system ones (read-only). */
export function EnvDialog({
  env,
  includeSystemEnv,
  onOk,
  onClose,
}: {
  env: RunConfig["env"];
  includeSystemEnv: boolean;
  onOk: (env: RunConfig["env"], includeSystemEnv: boolean) => void;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<EnvRow[]>(() => envRows(env));
  const [selected, setSelected] = useState<number | null>(null);
  const [include, setInclude] = useState(includeSystemEnv);
  const [system, setSystem] = useState<Array<[string, string]> | null>(() => (isTauri() ? null : []));
  const { error } = envFromRows(rows);
  const tx = useTx();
  const txTemplate = useTxTemplate();

  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    commands
      .runSystemEnv()
      .then((vars) => live && setSystem(Object.entries(vars).sort(([a], [b]) => a.localeCompare(b))))
      .catch(() => live && setSystem([]));
    return () => {
      live = false;
    };
  }, []);

  const set = (i: number, patch: Partial<EnvRow>) =>
    setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const add = () => {
    setRows((r) => [...r, { key: "", value: "" }]);
    setSelected(rows.length);
  };
  const remove = () => {
    if (selected === null) return;
    setRows((r) => r.filter((_, j) => j !== selected));
    setSelected(null);
  };
  const paste = async () => {
    try {
      const text = await readClipboardPlainText();
      setRows((r) => pasteRows(r, text));
    } catch {
      /* clipboard unavailable */
    }
  };
  const overridden = new Set(rows.map((r) => r.key));

  return (
    <Dialog
      open
      title="Environment Variables"
      onClose={onClose}
      width={560}
      footerStart={error && <span className={styles.footerError}>{txTemplate(error)}</span>}
      buttons={[
        {
          label: "OK",
          role: "default",
          disabled: !!error,
          onClick: () => {
            onOk(envFromRows(rows).env, include);
            onClose();
          },
        },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.envDialog}>
        <span className={styles.fieldLabel}>
          <T>User environment variables:</T>
        </span>
        <div className={styles.envPanel}>
          <div className={styles.editToolbar} role="toolbar" aria-label={tx("User environment variables")}>
            <IconButton icon="plus" size="small" iconSize={14} title="Add" onClick={add} />
            <IconButton
              icon="minus"
              size="small"
              iconSize={14}
              title="Remove"
              disabled={selected === null}
              onClick={remove}
            />
            <IconButton
              icon="copy"
              size="small"
              iconSize={13}
              title="Copy"
              disabled={!rows.length}
              onClick={() =>
                void writeClipboard(rowsText(selected === null ? rows : rows.slice(selected, selected + 1)))
              }
            />
            <IconButton icon="paste" size="small" iconSize={13} title="Paste" onClick={() => void paste()} />
          </div>
          <div className={styles.envGrid} role="table" aria-label={tx("User environment variables")}>
            <div className={styles.envHeader} role="row">
              <span role="columnheader">
                <T>Name</T>
              </span>
              <span role="columnheader">
                <T>Value</T>
              </span>
            </div>
            {rows.map((r, i) => (
              <div
                key={i}
                role="row"
                className={clsx(styles.envGridRow, selected === i && styles.editItemSelected)}
                onFocus={() => setSelected(i)}
              >
                <Input
                  mono
                  variant="bare"
                  aria-label={txTemplate(`Variable ${i + 1} name`)}
                  value={r.key}
                  onChange={(e) => set(i, { key: e.target.value })}
                />
                <Input
                  mono
                  variant="bare"
                  aria-label={txTemplate(`Variable ${i + 1} value`)}
                  value={r.value}
                  onChange={(e) => set(i, { value: e.target.value })}
                />
              </div>
            ))}
          </div>
        </div>
        <Checkbox checked={include} onChange={setInclude} label="Include system environment variables" />
        <div className={clsx(styles.envPanel, !include && styles.envDisabled)}>
          <div className={styles.editToolbar} role="toolbar" aria-label={tx("System environment variables")}>
            <IconButton
              icon="copy"
              size="small"
              iconSize={13}
              title="Copy"
              disabled={!system?.length}
              onClick={() => void writeClipboard((system ?? []).map(([k, v]) => `${k}=${v}`).join("\n"))}
            />
          </div>
          <div className={styles.envGrid} role="table" aria-label={tx("System environment variables")}>
            <div className={styles.envHeader} role="row">
              <span role="columnheader">
                <T>Name</T>
              </span>
              <span role="columnheader">
                <T>Value</T>
              </span>
            </div>
            {system === null && (
              <div className={styles.chooserMuted}>
                <T>Loading…</T>
              </div>
            )}
            {system?.map(([k, v]) => (
              <div
                key={k}
                role="row"
                className={clsx(styles.envGridRow, styles.envSystemRow, overridden.has(k) && styles.envOverridden)}
                title={`${k}=${v}`}
              >
                <span className={styles.envCell}>{k}</span>
                <span className={styles.envCell}>{v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
