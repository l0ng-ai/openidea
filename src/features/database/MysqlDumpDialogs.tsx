/** DataGrip's Export with 'mysqldump' and Restore with 'mysql' dialogs. */
import { useEffect, useState } from "react";
import clsx from "clsx";
import { call, commands, type DbToolJob } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { Checkbox, Dialog, IconButton, Input, T, type DialogButton } from "@/ui";
import {
  DEFAULT_MYSQLDUMP,
  dumpMismatch,
  restoreTargetProblem,
  mysqldumpOptions,
  nameList,
  outputPath,
  type MysqldumpForm,
} from "./dumpTools";
import {
  DatabaseField,
  ExecutableField,
  NamesField,
  Preview,
  RunOutput,
  joinPath,
  mismatchText,
  pathKey,
  runButtons,
  TargetHint,
  useDatabaseNames,
  useDumpInfo,
  useHome,
  useTableNames,
  useToolPreview,
} from "./DumpDialogs";
import { splitTarget } from "./model";
import { closeDialog, refresh, sourceById } from "./store";
import { startToolRun, useToolRuns } from "./toolRuns";
import styles from "./Database.module.css";

/** Whether the executable at `path` lists `option` in its `--help` (`false` while unknown). */
function useKnowsOption(path: string, option: string): boolean {
  const [known, setKnown] = useState<{
    path: string;
    options: string[];
  } | null>(null);
  useEffect(() => {
    const p = path.trim();
    if (!p) return;
    let live = true;
    const timer = setTimeout(() => {
      call(commands.dbToolOptions(p))
        .then((options) => live && setKnown({ path: p, options }))
        .catch(() => live && setKnown({ path: p, options: [] }));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [path]);
  return known?.path === path.trim() && known.options.includes(option);
}

type Switch = {
  [K in keyof MysqldumpForm]: MysqldumpForm[K] extends boolean ? K : never;
}[keyof MysqldumpForm];

const CHECKS: readonly [Switch, string][] = [
  ["addDropTable", "Add DROP TABLE before CREATE TABLE"],
  ["completeInsert", "Include column names in each INSERT"],
  ["disableKeys", "Add DISABLE KEYS before each INSERT block"],
  ["createOptions", "Include all table options in CREATE TABLE"],
  ["addLocks", "Add LOCK TABLES around each table"],
  ["routines", "Include stored routines"],
  ["addDropTrigger", "Add DROP TRIGGER before CREATE TRIGGER"],
  ["events", "Include scheduled events"],
  ["noData", "Export schema without data"],
];

export function MysqlDumpDialog({ target, database, tables }: { target: string; database: string; tables?: string }) {
  const source = sourceById(target);
  const home = useHome();
  const [executable, setExecutable] = useState("");
  const [form, setForm] = useState<MysqldumpForm>({
    ...DEFAULT_MYSQLDUMP,
    databases: database,
    tables: tables ?? "",
  });
  const [edited, setOutput] = useState<string | null>(null);
  const output = edited ?? (home ? joinPath(home, "{data_source}-{database}-{timestamp}.sql") : "");
  const [runKey, setRunKey] = useState<number | null>(null);
  const running = useToolRuns((s) => (runKey !== null ? s.runs[runKey]?.status === "running" : false));
  const knowsMasking = useKnowsOption(executable, "masking-policies");
  const chosenDatabases = nameList(form.databases);
  const oneDatabase = chosenDatabases.length === 1;
  const databases = useDatabaseNames(target);
  const tableNames =
    useTableNames(splitTarget(target).id, oneDatabase ? chosenDatabases : null)?.map((t) => t.name) ?? null;
  const set =
    <K extends keyof MysqldumpForm>(k: K) =>
    (v: MysqldumpForm[K]) =>
      setForm((f) => ({ ...f, [k]: v }));
  const jobFor = (file: string): DbToolJob => ({
    tool: "mysqldump",
    file,
    options: mysqldumpOptions(form, knowsMasking),
  });
  const preview = useToolPreview(target, executable || "mysqldump", jobFor(output));

  const browse = async () => {
    try {
      const { save } = await import("@/platform/dialog");
      const path = await save({ defaultPath: output });
      if (path) setOutput(path);
    } catch {
      // No dialog (tests): keep typing the path.
    }
  };

  const run = async () => {
    const databases = nameList(form.databases);
    const file = outputPath(output, {
      dataSource: source?.name ?? "",
      database: databases.join("_"),
      now: new Date(),
    });
    const job = jobFor(file);
    localStorage.setItem(pathKey("mysqldump"), executable);
    const commandLine = await call(commands.dbToolPreview(target, executable, job)).catch(() => "");
    setRunKey(
      startToolRun({
        target,
        executable,
        job,
        commandLine,
        output: file,
        from: databases.join(", ") || tx("all databases"),
        to: file,
      }),
    );
  };

  const buttons: DialogButton[] =
    runKey !== null
      ? runButtons(runKey, running, () => setRunKey(null))
      : [
          { label: "Cancel", role: "cancel" },
          {
            label: "Run",
            role: "default",
            disabled: !executable.trim() || !output.trim(),
            onClick: () => void run(),
          },
        ];

  return (
    <Dialog
      open
      onClose={closeDialog}
      title={tx`Export with 'mysqldump' (${source?.name ?? target})`}
      width={760}
      buttons={buttons}
    >
      {runKey !== null ? (
        <RunOutput runKey={runKey} />
      ) : (
        <div className={styles.form}>
          <ExecutableField tool="mysqldump" value={executable} onChange={setExecutable} serverMajor={null} />
          <span className={styles.formLabel}>
            <T>Output result to:</T>
          </span>
          <div className={styles.formRow}>
            <Input
              mono
              className={styles.dumpPath}
              aria-label="Output result to"
              value={output}
              onChange={(e) => setOutput(e.target.value)}
            />
            <IconButton icon="folder" title="Browse…" onClick={() => void browse()} />
          </div>
          <span />
          <span className={styles.formHint}>
            <T>Allowed substitution patterns:</T> {"{timestamp}, {data_source}, {database}"}
          </span>
          <span className={styles.formLabel}>
            <T>Databases to dump:</T>
          </span>
          <NamesField
            label="Databases to dump"
            placeholder={tx("All databases")}
            value={form.databases}
            onChange={set("databases")}
            names={databases?.names ?? null}
          />
          <span className={styles.formLabel}>
            <T>Tables to dump:</T>
          </span>
          <NamesField
            label="Tables to dump"
            placeholder="All"
            disabled={!oneDatabase}
            title={oneDatabase ? undefined : tx("Tables can be chosen when one database is dumped")}
            value={oneDatabase ? form.tables : ""}
            onChange={set("tables")}
            names={tableNames}
          />
          <span />
          <div className={styles.dumpChecks}>
            {CHECKS.map(([k, label]) => (
              <Checkbox key={k} checked={form[k]} onChange={set(k)} label={label} />
            ))}
            <Checkbox
              checked={form.singleTransaction && !form.lockAllTables}
              disabled={form.lockAllTables}
              onChange={set("singleTransaction")}
              label="Consistent snapshot (--single-transaction)"
            />
            <Checkbox
              checked={form.lockAllTables}
              onChange={set("lockAllTables")}
              label="Lock all tables for the whole export (needs RELOAD)"
            />
            {knowsMasking && (
              <Checkbox
                checked={form.maskingPolicies}
                onChange={set("maskingPolicies")}
                label="Include masking policies"
              />
            )}
          </div>
          <Preview text={preview} />
        </div>
      )}
    </Dialog>
  );
}

export function MysqlRestoreDialog({ target, database: initialDatabase }: { target: string; database: string }) {
  const source = sourceById(target);
  const [executable, setExecutable] = useState("");
  const [database, setDatabase] = useState(initialDatabase);
  const [file, setFile] = useState("");
  const [force, setForce] = useState(false);
  const [runKey, setRunKey] = useState<number | null>(null);
  const running = useToolRuns((s) => (runKey !== null ? s.runs[runKey]?.status === "running" : false));
  const readOnly = !!source?.readOnly;
  const info = useDumpInfo(file);
  const mismatch = dumpMismatch("mysql", info?.kind ?? null);
  const databases = useDatabaseNames(target);
  const creates = !!info?.createsDatabase;
  // Until the dump is read, an empty choice is not yet wrong.
  const problem = restoreTargetProblem(database, databases?.names ?? null, true, creates || !info);
  const job: DbToolJob = { tool: "mysql", file, options: { database, force } };
  const preview = useToolPreview(target, executable || "mysql", job);

  const browse = async () => {
    try {
      const { open } = await import("@/platform/dialog");
      const path = await open({
        multiple: false,
        directory: false,
        title: tx("Path to dump"),
      });
      if (typeof path === "string") setFile(path);
    } catch {
      // No dialog (tests): keep typing the path.
    }
  };

  const run = async () => {
    localStorage.setItem(pathKey("mysql"), executable);
    const commandLine = await call(commands.dbToolPreview(target, executable, job)).catch(() => preview);
    setRunKey(
      startToolRun({
        target,
        executable,
        job,
        commandLine,
        from: file,
        to: database || (source?.name ?? target),
        onSuccess: () => void refresh(target),
      }),
    );
  };

  const buttons: DialogButton[] =
    runKey !== null
      ? runButtons(runKey, running, () => setRunKey(null))
      : [
          { label: "Cancel", role: "cancel" },
          {
            label: "Run",
            role: "default",
            disabled: readOnly || !!mismatch || !!problem || !info || !executable.trim() || !file.trim(),
            title: readOnly ? tx`The data source is read-only` : undefined,
            onClick: () => void run(),
          },
        ];

  return (
    <Dialog
      open
      onClose={closeDialog}
      title={tx`Restore with 'mysql' (${source?.name ?? target})`}
      width={720}
      buttons={buttons}
    >
      {runKey !== null ? (
        <RunOutput runKey={runKey} />
      ) : (
        <div className={styles.form}>
          <ExecutableField tool="mysql" value={executable} onChange={setExecutable} serverMajor={null} />
          <span className={styles.formLabel}>
            <T>Database:</T>
          </span>
          <DatabaseField
            value={database}
            onChange={setDatabase}
            names={databases?.names ?? null}
            empty="As named in the dump"
          />
          <TargetHint
            problem={problem}
            database={database}
            note={creates ? tx("The dump creates the databases it names.") : undefined}
          />
          <span className={styles.formLabel}>
            <T>Path to dump:</T>
          </span>
          <div className={styles.formRow}>
            <Input
              mono
              className={styles.dumpPath}
              aria-label="Path to dump"
              value={file}
              onChange={(e) => setFile(e.target.value)}
            />
            <IconButton icon="folder" title="Browse…" onClick={() => void browse()} />
          </div>
          <span />
          <span className={clsx(styles.formHint, mismatch && styles.dumpError)}>
            {mismatch ? mismatchText(mismatch) : <T>mysql runs the SQL dump that mysqldump wrote.</T>}
          </span>
          <span />
          <Checkbox checked={force} onChange={setForce} label="Continue after errors (--force)" />
          {readOnly && (
            <>
              <span />
              <span className={clsx(styles.formHint, styles.dumpError)}>
                <T>The data source is read-only.</T>
              </span>
            </>
          )}
          <Preview text={preview} />
        </div>
      )}
    </Dialog>
  );
}
