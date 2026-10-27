/** Query History (browse / paste / delete) and Import Data from File dialogs. */
import { useEffect, useMemo, useState } from "react";
import { call, commands, type DbHistoryEntry } from "@/platform/ipc";
import { editorsFor } from "@/editor/api";
import { Checkbox, Dialog, EmptyState, IconButton, Input, List, Select, T } from "@/ui";
import { notifications } from "@/workbench/contributions";
import { CodePreview } from "./CodePreview";
import { guessSeparator, importEdits, parseDelimited } from "./model";
import { closeDialog, detailsKey, loadDetails, openConsoleWith, targetLabel, useDatabase } from "./store";
import styles from "./Database.module.css";

function when(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Pastes `text` over the selection of console `path` when it is open, else appends it to the data source's console. */
async function paste(id: string, path: string | null, text: string) {
  const view = path ? editorsFor(path)[0]?.view : undefined;
  if (!view) {
    await openConsoleWith(id, text);
    return;
  }
  const sel = view.state.selection.main;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: { anchor: sel.from, head: sel.from + text.length },
    scrollIntoView: true,
  });
  view.focus();
}

/** IDEA's `<data source> Query History`: statements newest first, a preview, Paste into the console. */
export function HistoryDialog({ id, path }: { id: string; path: string | null }) {
  const [entries, setEntries] = useState<DbHistoryEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  useEffect(() => {
    void call(commands.dbHistory(id))
      .then(setEntries)
      .catch(() => setEntries([]));
  }, [id]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (entries ?? []).filter((e) => !q || e.text.toLowerCase().includes(q));
  }, [entries, query]);
  const current = shown[Math.min(active, shown.length - 1)];

  const remove = async (texts: string[] | null) => {
    await call(commands.dbRemoveHistory(id, texts));
    setEntries((e) => (texts ? (e ?? []).filter((x) => !texts.includes(x.text)) : []));
  };
  const done = (text: string | undefined) => {
    closeDialog();
    if (text) void paste(id, path, text);
  };

  return (
    <Dialog
      open
      onClose={closeDialog}
      title={`${targetLabel(id)} Query History`}
      width={820}
      footerStart={
        <IconButton icon="trash" title="Clear History" disabled={!entries?.length} onClick={() => void remove(null)} />
      }
      buttons={[
        { label: "Close", role: "cancel" },
        { label: "Paste", role: "default", disabled: !current, onClick: () => done(current?.text) },
      ]}
    >
      <div className={styles.historyDialog}>
        <div className={styles.historyList}>
          <div className={styles.formRow}>
            <Input
              autoFocus
              aria-label="Search history"
              placeholder="Search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((a) => Math.max(0, Math.min(shown.length - 1, a + (e.key === "ArrowDown" ? 1 : -1))));
                } else if (e.key === "Enter") done(current?.text);
              }}
            />
            <IconButton
              icon="minus"
              title="Delete"
              disabled={!current}
              onClick={() => current && void remove([current.text])}
            />
          </div>
          <List
            className={styles.fill}
            aria-label="Statements"
            items={shown}
            getKey={(e) => e.text}
            activeIndex={Math.min(active, shown.length - 1)}
            onActiveChange={setActive}
            onActivate={(e) => done(e.text)}
            renderItem={(e) => (
              <span className={styles.historyItem} title={when(e.time ?? 0)}>
                <span className={styles.historyText}>{e.text.replace(/\s+/g, " ")}</span>
              </span>
            )}
            empty={<EmptyState title={entries === null ? "Loading…" : "No statements"} />}
          />
        </div>
        <CodePreview sql className={styles.historyPreview} aria-label="Statement" text={current?.text ?? ""} />
      </div>
    </Dialog>
  );
}

const SEPARATORS = [
  { value: ",", label: "Comma" },
  { value: "\t", label: "Tab" },
  { value: ";", label: "Semicolon" },
  { value: "|", label: "Pipe" },
];

/** Import Data from File: a CSV / TSV file inserted into a table in one transaction. */
export function ImportDialog({ id, schema, table }: { id: string; schema: string; table: string }) {
  const [file, setFile] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sep, setSep] = useState(",");
  const [header, setHeader] = useState(true);
  const [emptyAsNull, setEmptyAsNull] = useState(true);
  const [busy, setBusy] = useState(false);
  const details = useDatabase((s) => s.details[detailsKey(id, schema, table)]);
  useEffect(() => {
    if (details?.status !== "ok") void loadDetails(id, schema, table);
    // Once per table.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, schema, table]);
  const columns = useMemo(() => (details?.status === "ok" ? details.value.columns.map((c) => c.name) : []), [details]);
  const rows = useMemo(() => (text ? parseDelimited(text, sep) : []), [text, sep]);
  const { edits, mapped } = useMemo(
    () => importEdits(rows, columns, header, emptyAsNull),
    [rows, columns, header, emptyAsNull],
  );

  const choose = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const f = await open({
        multiple: false,
        directory: false,
        title: "Import Data from File",
        filters: [{ name: "CSV / TSV", extensions: ["csv", "tsv", "txt"] }],
      });
      if (typeof f !== "string") return;
      const content = await call(commands.fsReadText(f));
      setFile(f);
      setText(content);
      setSep(guessSeparator(content));
    } catch (e) {
      notifications().notify({
        level: "error",
        title: "Cannot read the file",
        body: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const run = async () => {
    setBusy(true);
    try {
      const n = await call(commands.dbApplyEdits(id, schema, table, edits));
      notifications().notify({ level: "info", title: `${table}: ${n} row(s) imported`, key: "db-import" });
      closeDialog();
    } catch (e) {
      notifications().notify({
        level: "error",
        title: "Nothing was imported",
        body: e instanceof Error ? e.message : String(e),
        key: "db-import",
      });
    } finally {
      setBusy(false);
    }
  };

  const preview = rows.slice(0, 8);
  return (
    <Dialog
      open
      onClose={closeDialog}
      title={`Import Data into ${schema}.${table}`}
      width={720}
      buttons={[
        { label: "Cancel", role: "cancel" },
        {
          label: `Import ${edits.length} Rows`,
          role: "default",
          disabled: !edits.length || !mapped.length || busy,
          onClick: () => void run(),
        },
      ]}
    >
      <div className={styles.form}>
        <span className={styles.formLabel}>
          <T>File:</T>
        </span>
        <div className={styles.formRow}>
          <Input readOnly aria-label="File" value={file ?? ""} placeholder="Choose a CSV or TSV file" />
          <IconButton icon="folder" title="Choose File…" onClick={() => void choose()} />
        </div>
        <span className={styles.formLabel}>
          <T>Separator:</T>
        </span>
        <Select aria-label="Separator" value={sep} options={SEPARATORS} onChange={setSep} />
        <span />
        <Checkbox checked={header} onChange={setHeader} label="First row is header (columns matched by name)" />
        <span />
        <Checkbox checked={emptyAsNull} onChange={setEmptyAsNull} label="Treat empty values as NULL" />
        <span className={styles.formLabel}>
          <T>Columns:</T>
        </span>
        <span className={styles.formHint}>
          {mapped.length ? mapped.join(", ") : "No column of the file matches the table"}
        </span>
      </div>
      {preview.length > 0 && (
        <div className={styles.importPreview}>
          <table>
            <tbody>
              {preview.map((r, i) => (
                <tr key={i} className={header && i === 0 ? styles.importHeader : undefined}>
                  {r.map((v, j) => (
                    <td key={j}>{v}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Dialog>
  );
}
