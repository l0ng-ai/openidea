/** DataGrip's Export with 'pg_dump' and Restore with 'pg_restore' / 'psql' dialogs. */
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import clsx from "clsx";
import {
  call,
  commands,
  type DbDumpContent,
  type DbDumpFormat,
  type DbDumpInfo,
  type DbDumpStatements,
  type DbPsqlOptions,
  type DbTool,
  type DbToolInstall,
  type DbToolJob,
} from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import {
  Checkbox,
  Dialog,
  IconButton,
  Input,
  Select,
  T,
  Tabs,
  copyText,
  selectableText,
  showContextMenu,
  type DialogButton,
} from "@/ui";
import {
  DEFAULT_DUMP,
  DEFAULT_PSQL,
  DEFAULT_RESTORE,
  DUMP_FORMATS,
  dumpMismatch,
  dumpOptions,
  formatElapsed,
  majorOf,
  outputPath,
  pickInstall,
  restoreOptions,
  nameList,
  patternName,
  restoreTargetProblem,
  restoreToolFor,
  toggleName,
  unquoteName,
  versionFit,
  withExtension,
  type DumpForm,
  type DumpMismatch,
  type RestoreForm,
  type TargetProblem,
} from "./dumpTools";
import { splitTarget } from "./model";
import {
  closeDialog,
  loadDatabases,
  loadSchemas,
  loadTables,
  refresh,
  sourceById,
  tablesKey,
  useDatabase,
} from "./store";
import { TOOL_PROGRAMS, startToolRun, stopToolRun, useToolRuns } from "./toolRuns";
import { copySelectionOnKeyDown } from "@/ui/selectableText";
import styles from "./Database.module.css";

const PROGRAM = TOOL_PROGRAMS;
export const pathKey = (tool: DbTool) => `openidea.db.toolPath.${tool}`;

const CONTENT_OPTIONS: { value: DbDumpContent; label: string }[] = [
  { value: "all", label: "Schema and data" },
  { value: "schemaOnly", label: "Schema only" },
  { value: "dataOnly", label: "Data only" },
];

/** The connection target of `database` on the data source of `target`. */
function targetOf(target: string, database: string): string {
  const { id } = splitTarget(target);
  return database.trim() ? `${id}:${database.trim()}` : id;
}

/** `150013` → 15. */
const majorOfServer = (num: number | null) => (num ? Math.floor(num / 10000) : null);

export function joinPath(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, "")}/${name}`;
}

/** What the hint under the executable says about its version next to the server's. */
function versionHint(tool: DbTool, version: string, serverMajor: number | null): { text: string; warn: boolean } {
  const toolMajor = majorOf(version);
  const fit = versionFit(tool, toolMajor, serverMajor);
  const server = String(serverMajor);
  if (fit === "tooOld")
    return {
      text: tx`${version}: older than the server (PostgreSQL ${server}), which pg_dump refuses. Choose version ${server} or newer.`,
      warn: true,
    };
  if (fit === "newer")
    return {
      text: tx`${version}: newer than the server (PostgreSQL ${server}). What it writes may not load into PostgreSQL ${server}. Install the PostgreSQL ${server} client tools to restore into this server.`,
      warn: true,
    };
  return { text: version, warn: false };
}

/** The executable of `tool`: preselected by the server's version, shows its own and what is wrong. */
export function ExecutableField({
  tool,
  value,
  onChange,
  serverMajor,
}: {
  tool: DbTool;
  value: string;
  onChange: (v: string) => void;
  serverMajor: number | null;
}) {
  const [installs, setInstalls] = useState<DbToolInstall[] | null>(null);
  const [check, setCheck] = useState<{ path: string; version?: string; error?: string } | null>(null);
  const program = PROGRAM[tool];

  useEffect(() => {
    let live = true;
    void call(commands.dbToolInstalls(tool))
      .catch(() => [])
      .then((found) => {
        if (!live) return;
        setInstalls(found);
        if (!value) onChange(pickInstall(found, serverMajor, localStorage.getItem(pathKey(tool))));
      });
    return () => {
      live = false;
    };
    // Only when the tool changes: `value` seeds the field once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  useEffect(() => {
    const path = value.trim();
    if (!path) return;
    let live = true;
    const timer = setTimeout(() => {
      call(commands.dbToolVersion(path))
        .then((version) => live && setCheck({ path, version }))
        .catch((e) => live && setCheck({ path, error: e instanceof Error ? e.message : String(e) }));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [value]);

  const browse = async () => {
    try {
      const { open } = await import("@/platform/dialog");
      const file = await open({ multiple: false, directory: false, title: tx`Path to ${program}` });
      if (typeof file === "string") onChange(file);
    } catch {
      // No dialog (tests): keep typing the path.
    }
  };

  const found = installs ?? [];
  const options = found.map((i) => ({ value: i.path, label: i.path, detail: i.version, verbatim: true }));
  if (value && !found.some((i) => i.path === value)) options.push({ value, label: value, detail: "", verbatim: true });
  const current = check?.path === value.trim() ? check : null;
  const hint = current?.version ? versionHint(tool, current.version, serverMajor) : null;
  return (
    <>
      <span className={styles.formLabel}>
        <T>Path to executable:</T>
      </span>
      <div className={styles.formRow}>
        {found.length > 0 ? (
          <Select aria-label="Path to executable" value={value || null} options={options} onChange={onChange} />
        ) : (
          <Input
            mono
            className={styles.dumpPath}
            aria-label="Path to executable"
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
        <IconButton icon="folder" title="Browse…" onClick={() => void browse()} />
      </div>
      <span />
      <span className={clsx(styles.formHint, (current?.error || hint?.warn) && styles.dumpError)}>
        {installs && !value.trim()
          ? tool === "mysqldump" || tool === "mysql"
            ? tx`${program} was not found. Install the MySQL or MariaDB client tools or choose the executable.`
            : tx`${program} was not found. Install the PostgreSQL client tools or choose the executable.`
          : (hint?.text ?? current?.error ?? "\u00a0")}
      </span>
    </>
  );
}

/** What made the dump at `path` and whether it creates its database, from its header (`null` while unknown). */
export function useDumpInfo(path: string): DbDumpInfo | null {
  const [known, setKnown] = useState<{ path: string; info: DbDumpInfo } | null>(null);
  useEffect(() => {
    const p = path.trim();
    if (!p) return;
    let live = true;
    const timer = setTimeout(() => {
      call(commands.dbDumpInfo(p))
        .then((info) => live && setKnown({ path: p, info }))
        .catch(() => live && setKnown({ path: p, info: { kind: "unknown", createsDatabase: false } }));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [path]);
  return known?.path === path.trim() ? known.info : null;
}

/** The databases of the data source of `target` (MySQL: its schemas); `null` while unknown. */
export function useDatabaseNames(target: string): { names: string[]; current: string } | null {
  const { id } = splitTarget(target);
  const mysql = sourceById(id)?.driver === "mysql";
  const databases = useDatabase((s) => s.databases[id]);
  const schemas = useDatabase((s) => s.schemas[id]);
  const loaded = mysql ? schemas : databases;
  useEffect(() => {
    if (!loaded) void (mysql ? loadSchemas(id) : loadDatabases(id));
  }, [id, mysql, loaded]);
  if (mysql) return schemas?.status === "ok" ? { names: schemas.value, current: "" } : null;
  return databases?.status === "ok" ? databases.value : null;
}

/** The schemas on connection target `target` (`null` while unknown). */
function useSchemaNames(target: string): string[] | null {
  const loaded = useDatabase((s) => s.schemas[target]);
  useEffect(() => {
    if (!loaded) void loadSchemas(target);
  }, [target, loaded]);
  return loaded?.status === "ok" ? loaded.value : null;
}

/** The tables of `schemas` on connection target `id` (`null` while one of them is unknown, or without schemas). */
export function useTableNames(
  id: string,
  schemas: readonly string[] | null,
): { schema: string; name: string }[] | null {
  const all = useDatabase((s) => s.tables);
  const keys = (schemas ?? []).join("\u0000");
  useEffect(() => {
    for (const schema of schemas ?? []) if (!all[tablesKey(id, schema)]) void loadTables(id, schema);
    // `keys` stands for `schemas`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, keys, all]);
  if (!schemas?.length) return null;
  const out: { schema: string; name: string }[] = [];
  for (const schema of schemas) {
    const loaded = all[tablesKey(id, schema)];
    if (loaded?.status !== "ok") return null;
    for (const t of loaded.value) if (t.kind === "table") out.push({ schema, name: t.name });
  }
  return out;
}

/** A typed name list with a button that ticks names off a list of the server's. */
export function NamesField({
  label,
  value,
  onChange,
  names,
  placeholder,
  disabled,
  title,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  names: string[] | null;
  placeholder: string;
  disabled?: boolean;
  title?: string;
}) {
  const chosen = nameList(value);
  return (
    <div className={styles.formRow}>
      <Input
        mono
        className={styles.dumpPath}
        aria-label={label}
        placeholder={placeholder}
        disabled={disabled}
        title={title}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <IconButton
        icon="list"
        title="Choose from the server…"
        disabled={disabled || !names?.length}
        onClick={(e) =>
          showContextMenu(
            e,
            (names ?? []).map((n) => ({
              label: n,
              verbatim: true,
              checked: chosen.includes(n),
              run: () => onChange(toggleName(value, n)),
            })),
          )
        }
      />
    </div>
  );
}

/**
 * The database a restore runs in: the data source's databases to pick from, or a text field
 * while they are unknown. `empty` labels a choice of no database.
 */
export function DatabaseField({
  value,
  onChange,
  names,
  empty,
}: {
  value: string;
  onChange: (v: string) => void;
  names: string[] | null;
  empty?: string;
}) {
  if (!names) return <Input aria-label="Database" value={value} onChange={(e) => onChange(e.target.value)} />;
  const options = [
    ...(empty !== undefined ? [{ value: "", label: empty }] : []),
    ...names.map((n) => ({ value: n, label: n, verbatim: true })),
  ];
  if (value && !names.includes(value)) options.push({ value, label: value, verbatim: true });
  return <Select aria-label="Database" searchable value={value} options={options} onChange={onChange} />;
}

/** The hint under a restore's database: what is wrong with it, else what happens there. */
export function TargetHint({
  problem,
  database,
  note,
}: {
  problem: TargetProblem | null;
  database: string;
  note?: string;
}) {
  const text =
    problem === "missing"
      ? tx`Database ${database} does not exist.`
      : problem === "noDatabase"
        ? tx("This dump does not create its database. Choose the database to restore into.")
        : note;
  return (
    <>
      <span />
      <span className={clsx(styles.formHint, problem && styles.dumpError)}>{text ?? "\u00a0"}</span>
    </>
  );
}

/** Why the chosen tool cannot restore the chosen dump, as a hint under the path. */
export function mismatchText(m: DumpMismatch): string {
  switch (m) {
    case "postgresIntoMysql":
      return tx("This is a PostgreSQL dump: restore it into a PostgreSQL data source.");
    case "mysqlIntoPostgres":
      return tx("This is a MySQL dump: restore it into a MySQL data source.");
    case "archiveIntoPsql":
      return tx("This is a pg_dump archive: restore it with pg_restore.");
    case "sqlIntoPgRestore":
      return tx("This is a plain SQL dump: restore it with psql.");
  }
}

/** The command line the backend would run for `job` on target `id`; the previous one while the next loads. */
export function useToolPreview(id: string, executable: string, job: DbToolJob): string {
  const key = JSON.stringify([id, executable, job]);
  const [shown, setShown] = useState<{ key: string; line: string } | null>(null);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      call(commands.dbToolPreview(id, executable, job))
        .then((line) => live && setShown({ key, line }))
        .catch(() => live && setShown({ key, line: "" }));
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `key` stands for the three inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return shown?.line ?? "";
}

export function Preview({ text }: { text: string }) {
  return (
    <div className={clsx(styles.dumpPreview, selectableText)} onKeyDown={(e) => void copySelectionOnKeyDown(e)}>
      <code aria-label="Command line">{text || "\u00a0"}</code>
    </div>
  );
}

/** The current time, ticking each second while `live`. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return now;
}

/** Live output of a run, followed while scrolled to the bottom. */
export function RunOutput({ runKey }: { runKey: number }) {
  const run = useToolRuns((s) => s.runs[runKey]);
  const now = useNow(run?.status === "running");
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [run?.lines]);
  if (!run) return null;
  const took = formatElapsed((run.endedAt ?? now) - run.startedAt);
  const status =
    run.status === "running"
      ? tx`Running ${PROGRAM[run.tool]}… ${took}`
      : run.status === "done"
        ? tx`Finished in ${took}`
        : run.status === "cancelled"
          ? tx`Stopped after ${took}`
          : (run.error ?? tx`Failed with exit code ${String(run.exit ?? "?")} after ${took}`);
  return (
    <div className={styles.dumpRun}>
      <div className={styles.formRow}>
        <span
          className={clsx(styles.formHint, styles.dumpStatus, run.status === "failed" && styles.dumpError)}
          role="status"
        >
          {status}
          <span className={styles.dumpRoute}>{run.route}</span>
        </span>
        <IconButton
          icon="copy"
          title="Copy Output"
          disabled={!run.lines.length}
          onClick={() => void copyText(run.lines.map((l) => l.text).join("\n"))}
        />
      </div>
      <div
        ref={scroller}
        className={clsx(styles.dumpLog, selectableText)}
        tabIndex={0}
        onKeyDown={(e) => void copySelectionOnKeyDown(e)}
        role="log"
        aria-label={tx`${PROGRAM[run.tool]} output`}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
        }}
      >
        {run.lines.map((l, i) => (
          <div key={i} className={clsx(l.stderr && /error|fatal/i.test(l.text) && styles.dumpError)}>
            {l.text || " "}
          </div>
        ))}
        {run.status === "done" && !run.lines.length && (
          <div className={styles.formHint}>{tx`${PROGRAM[run.tool]} printed no output.`}</div>
        )}
      </div>
    </div>
  );
}

/** Footer buttons while a run is shown: Stop while it runs, then Back to change the options. */
export function runButtons(runKey: number, running: boolean, back: () => void): DialogButton[] {
  return running
    ? [
        { label: "Close", role: "cancel" },
        { label: "Stop", role: "default", onClick: () => stopToolRun(runKey) },
      ]
    : [
        { label: "Back", role: "extra", onClick: back },
        { label: "Close", role: "default", onClick: closeDialog },
      ];
}

export function useHome(): string | null {
  const [home, setHome] = useState<string | null>(null);
  useEffect(() => {
    void import("@tauri-apps/api/path")
      .then((p) => p.homeDir())
      .then(setHome)
      .catch(() => {});
  }, []);
  return home;
}

export function DumpDialog({
  target,
  database: initialDatabase,
  schemas,
  tables,
  serverVersion,
}: {
  target: string;
  database: string;
  schemas?: string;
  tables?: string;
  serverVersion: number | null;
}) {
  const source = sourceById(target);
  const home = useHome();
  const [executable, setExecutable] = useState("");
  const [database, setDatabase] = useState(initialDatabase);
  const [options, setOptions] = useState<DumpForm>({
    ...DEFAULT_DUMP,
    schemas: schemas ?? "",
    tables: tables ?? "",
  });
  const [edited, setOutput] = useState<string | null>(null);
  const output = edited ?? (home ? joinPath(home, "{data_source}-{database}-{timestamp}.sql") : "");
  const [runKey, setRunKey] = useState<number | null>(null);
  const running = useToolRuns((s) => (runKey !== null ? s.runs[runKey]?.status === "running" : false));

  const set =
    <K extends keyof DumpForm>(k: K) =>
    (v: DumpForm[K]) =>
      setOptions((o) => ({ ...o, [k]: v }));
  const plain = options.format === "plain";
  const runTarget = targetOf(target, database);
  const databases = useDatabaseNames(target);
  const shown = database || (databases?.current ?? "");
  const schemaNames = useSchemaNames(runTarget);
  const typedSchemas = nameList(options.schemas)
    .map(unquoteName)
    .filter((n) => schemaNames?.includes(n));
  const tableNames =
    useTableNames(runTarget, typedSchemas.length ? typedSchemas : schemaNames)?.map(
      (t) => `${patternName(t.schema)}.${patternName(t.name)}`,
    ) ?? null;
  const jobFor = (file: string): DbToolJob => ({ tool: "pgDump", file, options: dumpOptions(options) });
  const preview = useToolPreview(runTarget, executable || "pg_dump", jobFor(output));

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
    const file = outputPath(output, { dataSource: source?.name ?? "", database: shown, now: new Date() });
    const job = jobFor(file);
    localStorage.setItem(pathKey("pgDump"), executable);
    const commandLine = await call(commands.dbToolPreview(runTarget, executable, job)).catch(() => "");
    setRunKey(
      startToolRun({
        target: runTarget,
        executable,
        job,
        commandLine,
        output: file,
        from: shown || (source?.name ?? target),
        to: file,
      }),
    );
  };

  const buttons: DialogButton[] =
    runKey !== null
      ? runButtons(runKey, running, () => setRunKey(null))
      : [
          { label: "Cancel", role: "cancel" },
          { label: "Run", role: "default", disabled: !executable.trim() || !output.trim(), onClick: () => void run() },
        ];

  return (
    <Dialog
      open
      onClose={closeDialog}
      title={tx`Export with 'pg_dump' (${source?.name ?? target})`}
      width={720}
      buttons={buttons}
    >
      {runKey !== null ? (
        <RunOutput runKey={runKey} />
      ) : (
        <div className={styles.form}>
          <ExecutableField
            tool="pgDump"
            value={executable}
            onChange={setExecutable}
            serverMajor={majorOfServer(serverVersion)}
          />
          <span className={styles.formLabel}>
            <T>Database:</T>
          </span>
          <DatabaseField value={shown} onChange={setDatabase} names={databases?.names ?? null} />
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
            <T>Format:</T>
          </span>
          <Select
            aria-label="Format"
            value={options.format}
            options={DUMP_FORMATS.map((f) => ({ value: f.id, label: f.label }))}
            onChange={(f: DbDumpFormat) => {
              set("format")(f);
              setOutput(withExtension(output, f));
            }}
          />
          <span className={styles.formLabel}>
            <T>Statements:</T>
          </span>
          <Select
            aria-label="Statements"
            value={options.statements}
            options={[
              { value: "copy", label: "COPY" },
              { value: "inserts", label: "INSERT" },
              { value: "columnInserts", label: "INSERT with column names" },
            ]}
            onChange={(v: DbDumpStatements) => set("statements")(v)}
          />
          <span className={styles.formLabel}>
            <T>Content:</T>
          </span>
          <Select aria-label="Content" value={options.content} options={CONTENT_OPTIONS} onChange={set("content")} />
          {(
            [
              ["schemas", "Schemas:", schemaNames?.map(patternName) ?? null],
              ["tables", "Tables:", tableNames],
              ["excludeTables", "Exclude tables:", tableNames],
            ] as const
          ).map(([k, label, names]) => (
            <Fragment key={k}>
              <span className={styles.formLabel}>{tx(label)}</span>
              <NamesField label={tx(label)} placeholder="All" value={options[k]} onChange={set(k)} names={names} />
            </Fragment>
          ))}
          {options.format === "directory" && (
            <>
              <span className={styles.formLabel}>
                <T>Parallel jobs:</T>
              </span>
              <Input
                aria-label="Parallel jobs"
                type="number"
                min={1}
                value={String(options.jobs)}
                onChange={(e) => set("jobs")(Math.max(1, Number(e.target.value) || 1))}
              />
            </>
          )}
          <span />
          <div className={styles.dumpChecks}>
            <Checkbox
              checked={plain && options.clean}
              disabled={!plain}
              onChange={set("clean")}
              label="Add DROP before CREATE"
            />
            <Checkbox
              checked={plain && options.clean && options.ifExists}
              disabled={!plain || !options.clean}
              onChange={set("ifExists")}
              label="Use DROP … IF EXISTS"
            />
            <Checkbox
              checked={plain && options.create}
              disabled={!plain}
              onChange={set("create")}
              label="Add CREATE DATABASE"
            />
            <Checkbox checked={options.noOwner} onChange={set("noOwner")} label="Skip ownership (--no-owner)" />
            <Checkbox
              checked={options.noPrivileges}
              onChange={set("noPrivileges")}
              label="Skip privileges (--no-privileges)"
            />
          </div>
          <Preview text={preview} />
        </div>
      )}
    </Dialog>
  );
}

export function RestoreDialog({
  target,
  database: initialDatabase,
  serverVersion,
}: {
  target: string;
  database: string;
  serverVersion: number | null;
}) {
  const source = sourceById(target);
  const [picked, setPicked] = useState<"pgRestore" | "psql" | null>(null);
  const [executables, setExecutables] = useState<Record<"pgRestore" | "psql", string>>({ pgRestore: "", psql: "" });
  const [database, setDatabase] = useState(initialDatabase);
  const [file, setFile] = useState("");
  const [restore, setRestore] = useState<RestoreForm>(DEFAULT_RESTORE);
  const [psql, setPsql] = useState<DbPsqlOptions>(DEFAULT_PSQL);
  const [runKey, setRunKey] = useState<number | null>(null);
  const running = useToolRuns((s) => (runKey !== null ? s.runs[runKey]?.status === "running" : false));
  const info = useDumpInfo(file);
  const tool = picked ?? restoreToolFor(file, info?.kind ?? null);
  const mismatch = dumpMismatch(tool, info?.kind ?? null);
  const executable = executables[tool];
  const readOnly = !!source?.readOnly;
  const databases = useDatabaseNames(target);
  const shown = database || (databases?.current ?? "");
  const problem = restoreTargetProblem(shown, databases?.names ?? null, false, false);
  const creates = tool === "pgRestore" ? restore.create : !!info?.createsDatabase;

  const changeFile = setFile;
  const browse = async (directory: boolean) => {
    try {
      const { open } = await import("@/platform/dialog");
      const path = await open({ multiple: false, directory, title: tx("Path to dump") });
      if (typeof path === "string") changeFile(path);
    } catch {
      // No dialog (tests): keep typing the path.
    }
  };

  const runTarget = targetOf(target, database);
  const job: DbToolJob =
    tool === "psql" ? { tool, file, options: psql } : { tool, file, options: restoreOptions(restore) };
  const preview = useToolPreview(runTarget, executable || PROGRAM[tool], job);
  const setR =
    <K extends keyof RestoreForm>(k: K) =>
    (v: RestoreForm[K]) =>
      setRestore((o) => ({ ...o, [k]: v }));
  const setP =
    <K extends keyof DbPsqlOptions>(k: K) =>
    (v: DbPsqlOptions[K]) =>
      setPsql((o) => ({ ...o, [k]: v }));

  const run = async () => {
    localStorage.setItem(pathKey(tool), executable);
    const commandLine = await call(commands.dbToolPreview(runTarget, executable, job)).catch(() => preview);
    setRunKey(
      startToolRun({
        target: runTarget,
        executable,
        job,
        commandLine,
        from: file,
        to: shown || (source?.name ?? target),
        onSuccess: () => {
          void refresh(runTarget);
          if (creates) void refresh(splitTarget(target).id);
        },
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
            disabled: readOnly || !!mismatch || !!problem || !executable.trim() || !file.trim(),
            title: readOnly ? tx`The data source is read-only` : undefined,
            onClick: () => void run(),
          },
        ];

  return (
    <Dialog
      open
      onClose={closeDialog}
      title={tx`Restore with 'pg_restore'/'psql' (${source?.name ?? target})`}
      width={720}
      buttons={buttons}
    >
      {runKey !== null ? (
        <RunOutput runKey={runKey} />
      ) : (
        <>
          <Tabs
            variant="compact"
            aria-label="Restore tool"
            items={[
              { id: "pgRestore", label: "pg_restore" },
              { id: "psql", label: "psql" },
            ]}
            activeId={tool}
            onSelect={(id) => setPicked(id as "pgRestore" | "psql")}
          />
          <div className={styles.form}>
            <ExecutableField
              key={tool}
              tool={tool}
              value={executable}
              onChange={(v) => setExecutables((e) => ({ ...e, [tool]: v }))}
              serverMajor={majorOfServer(serverVersion)}
            />
            <span className={styles.formLabel}>
              <T>Database:</T>
            </span>
            <DatabaseField value={shown} onChange={setDatabase} names={databases?.names ?? null} />
            <TargetHint
              problem={problem}
              database={shown}
              note={
                !creates
                  ? undefined
                  : tool === "pgRestore"
                    ? tx`pg_restore connects to ${shown} and creates the database the archive names.`
                    : tx`The dump creates its own database. psql connects to ${shown} first.`
              }
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
                onChange={(e) => changeFile(e.target.value)}
              />
              <IconButton
                icon="folder"
                title="Browse…"
                onClick={(e) =>
                  tool === "pgRestore"
                    ? showContextMenu(e, [
                        { label: "Choose File…", run: () => void browse(false) },
                        { label: "Choose Directory Archive…", run: () => void browse(true) },
                      ])
                    : void browse(false)
                }
              />
            </div>
            <span />
            <span className={clsx(styles.formHint, mismatch && styles.dumpError)}>
              {mismatch ? (
                mismatchText(mismatch)
              ) : tool === "psql" ? (
                <T>psql runs a plain SQL dump (.sql).</T>
              ) : (
                <T>pg_restore reads custom, directory and tar archives.</T>
              )}
            </span>
            {tool === "pgRestore" ? (
              <>
                <span className={styles.formLabel}>
                  <T>Content:</T>
                </span>
                <Select
                  aria-label="Content"
                  value={restore.content}
                  options={CONTENT_OPTIONS}
                  onChange={setR("content")}
                />
                <span className={styles.formLabel}>
                  <T>Schemas:</T>
                </span>
                <Input
                  mono
                  aria-label="Schemas"
                  placeholder="All"
                  value={restore.schemas}
                  onChange={(e) => setR("schemas")(e.target.value)}
                />
                <span className={styles.formLabel}>
                  <T>Parallel jobs:</T>
                </span>
                <Input
                  aria-label="Parallel jobs"
                  type="number"
                  min={1}
                  disabled={restore.singleTransaction}
                  value={String(restore.jobs)}
                  onChange={(e) => setR("jobs")(Math.max(1, Number(e.target.value) || 1))}
                />
                <span />
                <div className={styles.dumpChecks}>
                  <Checkbox
                    checked={restore.create}
                    onChange={setR("create")}
                    label="Create the database from the archive (--create)"
                  />
                  <Checkbox
                    checked={restore.clean}
                    onChange={setR("clean")}
                    label="Drop objects before recreating them"
                  />
                  <Checkbox
                    checked={restore.clean && restore.ifExists}
                    disabled={!restore.clean}
                    onChange={setR("ifExists")}
                    label="Use DROP … IF EXISTS"
                  />
                  <Checkbox
                    checked={restore.singleTransaction}
                    onChange={setR("singleTransaction")}
                    label="Wrap the restore in BEGIN … COMMIT"
                  />
                  <Checkbox
                    checked={restore.exitOnError}
                    onChange={setR("exitOnError")}
                    label="Stop on the first error"
                  />
                  <Checkbox checked={restore.noOwner} onChange={setR("noOwner")} label="Skip ownership (--no-owner)" />
                  <Checkbox
                    checked={restore.noPrivileges}
                    onChange={setR("noPrivileges")}
                    label="Skip privileges (--no-privileges)"
                  />
                </div>
              </>
            ) : (
              <>
                <span />
                <div className={styles.dumpChecks}>
                  <Checkbox
                    checked={psql.singleTransaction}
                    onChange={setP("singleTransaction")}
                    label="Wrap the restore in BEGIN … COMMIT"
                  />
                  <Checkbox checked={psql.stopOnError} onChange={setP("stopOnError")} label="Stop on the first error" />
                </div>
              </>
            )}
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
        </>
      )}
    </Dialog>
  );
}
