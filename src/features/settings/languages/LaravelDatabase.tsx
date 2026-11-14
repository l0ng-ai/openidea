/**
 * Settings › PHP › Laravel › Database: the data source (Database tool window) whose live
 * schema the native PHP engine uses for model columns, validation rules and
 * `DB::table('…')` along with the migrations, and a button reading it again
 * (`php_laravel_refresh_schema`). The engine also reads it when the setting changes and
 * when the Database tool changes the schema.
 */
import { useEffect, useMemo, useState } from "react";
import { tx } from "@/platform/i18n";
import { call, commands, isTauri, type DataSource } from "@/platform/ipc";
import { Button, type SelectOption } from "@/ui";
import { Row, Select } from "../components/Form";
import { useSetting } from "../components/context";
import styles from "./Sdk.module.css";

/** The data sources of the project's Database tool window (none outside the app). */
async function dataSources(): Promise<DataSource[]> {
  if (!isTauri()) return [];
  return call(commands.dbSources());
}

/** What reading the schema again found, for the status line. */
export async function refreshLaravelSchema(): Promise<string> {
  try {
    const status = await call(commands.phpLaravelRefreshSchema());
    if (!status) return tx("No data source is chosen: the migrations alone are used");
    const { source, tables } = status;
    return tx`Schema of ${source} read (tables: ${tables})`;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return tx`Could not read the schema: ${message}`;
  }
}

export function LaravelDatabaseRow() {
  const [database, setDatabase] = useSetting<string>("languages.php.laravel.database");
  const [sources, setSources] = useState<DataSource[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    dataSources()
      .then((list) => live && setSources(list))
      .catch(() => live && setSources([]));
    return () => {
      live = false;
    };
  }, []);
  const value = database ?? "";
  const options = useMemo<SelectOption[]>(() => {
    const out: SelectOption[] = [{ value: "", label: "None", detail: "migrations only" }];
    for (const s of sources) {
      if (s.id) out.push({ value: s.id, label: s.name?.trim() || s.id, detail: s.driver });
    }
    const name = value;
    if (name && !sources.some((s) => s.id === name)) out.push({ value: name, label: tx`${name} (missing)` });
    return out;
  }, [sources, value]);
  return (
    <Row
      label="Database"
      hint="A data source of the Database tool window whose tables and columns are used for model attributes, validation rules and DB::table() queries, along with the migrations. Where they differ, the database wins; hover shows where a column comes from. The schema is read again when the Database tool changes it."
    >
      <span className={styles.pathRow}>
        <Select value={value} options={options} onChange={setDatabase} aria-label="Laravel database" />
        <Button
          size="small"
          disabled={busy || !value}
          onClick={async () => {
            setBusy(true);
            setStatus(await refreshLaravelSchema());
            setBusy(false);
          }}
        >
          Refresh Schema
        </Button>
      </span>
      {status && (
        <span role="status" className={styles.status}>
          {status}
        </span>
      )}
    </Row>
  );
}
