/**
 * `.csv` / `.tsv` files with DataGrip's Text / Data tabs under the editor: Data shows the text
 * as a read-only table with the result grid's sort, local filter and search. Large files are
 * parsed in a worker; the table re-reads the text after edits only while it is shown.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import clsx from "clsx";
import { editorsFor } from "@/editor/api";
import { tx } from "@/platform/i18n";
import { Checkbox, Tabs, T } from "@/ui";
import type { CsvTable } from "./csv";
import { useCsvModes, useCsvVersions, type CsvMode } from "./csvModes";
import { DataView, type DataPanel } from "./DataView";
import styles from "./Database.module.css";

const DELIMITER_NAMES: Record<string, string> = { ",": "Comma", ";": "Semicolon", "\t": "Tab", "|": "Pipe" };

function CsvData({ path }: { path: string }) {
  const version = useCsvVersions((s) => s[path] ?? 0);
  const [header, setHeader] = useState<boolean | undefined>();
  const [table, setTable] = useState<CsvTable | null>(null);
  const [failed, setFailed] = useState(false);
  const [panel, setPanel] = useState<DataPanel | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const text = editorsFor(path)[0]?.view.state.doc.toString();
    if (text == null) return;
    const worker = new Worker(new URL("./csv.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<CsvTable>) => {
      worker.terminate();
      setFailed(false);
      setTable(e.data);
    };
    worker.onerror = () => {
      worker.terminate();
      setFailed(true);
    };
    worker.postMessage({ text, path, header });
    return () => worker.terminate();
  }, [path, version, header]);

  const columns = useMemo(() => table?.columns.map((name) => ({ name, type: "" })) ?? [], [table]);
  const value = useMemo(() => {
    const rows = table?.rows ?? [];
    return (r: number, c: number) => rows[r]?.[c] ?? "";
  }, [table]);

  if (!table) return <div className={styles.csvStatus}>{failed ? <T>Cannot read the file as a table</T> : null}</div>;
  const delimiter = tx(DELIMITER_NAMES[table.delimiter] ?? "Comma");
  const count = table.rows.length;
  return (
    <div className={styles.csvData}>
      <div className={styles.toolbar}>
        <Checkbox label="First row is header" checked={table.header} onChange={setHeader} />
        <span className={styles.spacer} />
        <span className={styles.csvSummary}>
          {tx`Delimiter: ${delimiter}`} · {tx`${count} rows`}
        </span>
      </div>
      <div className={styles.fill}>
        <DataView
          columns={columns}
          rowCount={table.rows.length}
          value={value}
          panel={panel}
          onPanelChange={setPanel}
          searchOpen={searchOpen}
          onSearchOpenChange={setSearchOpen}
          aria-label={tx("Table view of the file")}
        />
      </div>
    </div>
  );
}

export function CsvEditor({ path, tabId, children }: { path: string; tabId: string; children: ReactNode }) {
  const mode = useCsvModes((s) => s[tabId] ?? "text");
  return (
    <div className={styles.csvEditor}>
      <div className={clsx(styles.csvSource, mode === "data" && styles.csvHidden)}>{children}</div>
      {mode === "data" && <CsvData path={path} />}
      <Tabs
        variant="compact"
        className={styles.csvTabs}
        items={[
          { id: "text", label: "Text" },
          { id: "data", label: "Data" },
        ]}
        activeId={mode}
        onSelect={(id) => useCsvModes.setState({ [tabId]: id as CsvMode })}
        aria-label={tx("CSV editor view")}
      />
    </div>
  );
}
