/**
 * Database tools state: data sources, connection status, the introspection
 * cache of the tree, query consoles (file → data source) and their results.
 */
import { useProject } from "@/platform/project";
import { isRemoteWindow } from "@/platform/remote";
import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import {
  IpcError,
  call,
  commands,
  isCancelled,
  nextRequestId,
  type DataSource,
  type DbCatalogSchema,
  type DbCompletion,
  type DbDatabases,
  type DbDriver,
  type DbIntrospection_Deserialize,
  type ExecutionEvent,
  type DbObjectKind,
  type DbPlanNode,
  type DbSchemaObjects,
  type DbStatementOutcome,
  type DbTableDetails,
  type DbTableInfo,
  type DbTableKind,
  type DbVisibilityChange,
  type RequestId,
  type SqlStatement,
} from "@/platform/ipc";
import { activeEditor, editorsFor } from "@/editor/api";
import {
  editorService,
  maybeEditorService,
  notifications,
  showServiceView,
  toolWindowService,
  type FileDecoration,
} from "@/workbench/contributions";
import { workflowSettings } from "@/platform/workflowSettings";
import { ask, confirm } from "@/workbench/messages";
import {
  activeSchema,
  collapseTarget,
  colorVar,
  connectRemedy,
  databaseKey,
  effectiveSsh,
  idleTargets,
  newSourceId,
  sourceIcon,
  splitTarget,
  targetOf,
} from "./model";
import { tableFolder, type DbNode } from "./nodes";
import { SQL_LANGUAGE } from "./sqlLanguage";
import { TABLE_KIND, type TableRef } from "./tableInput";
import type { ExportData, ExportFormat } from "./export";
import type { DbObjectRef } from "./objects";
import { formatted } from "./sql/format";
import { bindParams, findParams } from "./sql/params";
import { isReadOnlyQuery } from "./sql/readOnly";
import { pageFetch } from "./resultView";
import type { TableSnapshot } from "./schemaCompare";
import { resolutionScopeOf, resolutionScopesOf, type SqlResolutionScope } from "./resolutionScopes";
import { databaseRequest, invalidateDatabaseRequests, projectRequest } from "./requests";
import { tx } from "@/platform/i18n";

export const DB_TOOL_WINDOW = "database";
export const RESULTS_VIEW = "dbResults";
const BINDINGS_KEY = "openidea.database.consoles";
const CONSOLE_SCHEMAS_KEY = "openidea.database.consoleSchemas";
const VIEW_OPTIONS_KEY = "openidea.database.viewOptions";
const MAX_TABS = 12;
const RESULT_DELIVERY_TIMEOUT_MS = 15_000;

export interface ResultTab {
  id: number;
  /** `Result N`, `Result N-2`… (N numbers a console execution, like IDEA). */
  title: string;
  /** Console file the statement came from. */
  path: string;
  sourceId: string;
  /** Schema used for these rows; retained across edits, paging and refresh. */
  schema?: string;
  outcome: DbStatementOutcome;
  /** The Query Plan tab: the plan of `outcome.statement` (which was explained, not run). */
  plan?: DbPlanNode[];
  /** Being re-run. */
  busy?: boolean;
  /** Zero-based page of the result shown in `outcome` (IDEA's paging re-runs the query). */
  page?: number;
  pageSize?: number;
  /** Rows of the whole query, once counted. */
  total?: number | null;
  /** Kept when the console runs again (Pin Tab); results otherwise replace the console's last ones. */
  pinned?: boolean;
  /** Shown in the editor under its statement (In-Editor Results), not as a result tab. */
  inline?: boolean;
}

/** Database › In-Editor Results: result sets show under their statements instead of in result tabs. */
export function inEditorResults(settings: unknown = useProject.getState().settings): boolean {
  return (settings as { database?: { inEditorResults?: unknown } } | null)?.database?.inEditorResults === true;
}

export async function setInEditorResults(on: boolean): Promise<void> {
  const settings = await call(commands.settingsSet("global", "database.inEditorResults", JSON.stringify(on)));
  useProject.setState({ settings });
}

/** One line of the consoles' Output log (IDEA's Database Console output). */
export interface OutputLine {
  id: number;
  time: number;
  kind: "info" | "statement" | "result" | "error";
  text: string;
  /** Prompt before a statement: the schema it ran in (`main>`). */
  prompt?: string;
}

/** `activeResult` value of the Output tab. */
export const OUTPUT_TAB = 0;
const MAX_OUTPUT = 2000;

/** Load state of a tree level. */
export type Loaded<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; value: T };

export type DialogState =
  /** Data source properties; `preset` seeds a new one (New › Data Source › PostgreSQL). */
  | { kind: "source"; source: DataSource | null; preset?: Partial<DataSource>; password?: string | null }
  /** Data Source from URL. */
  | { kind: "sourceUrl" }
  /** Rename a data source (`object` null) or a schema object of target `id`. */
  | { kind: "rename"; id: string; object: DbObjectRef | null }
  | { kind: "renameDatabase"; id: string; database: string }
  /** Confirm Drop / Truncate, with a preview of the statement. */
  | { kind: "drop"; id: string; object: DbObjectRef }
  | { kind: "truncate"; id: string; schema: string; table: string }
  /** New › Database of data source `id`; New › Schema in target `id`. */
  | { kind: "createDatabase"; id: string }
  | { kind: "createSchema"; id: string }
  /** Drop on database `database` of data source `id`. */
  | { kind: "dropDatabase"; id: string; database: string }
  /** Modify Table (`table` null: New › Table); `focusColumn` selects a column, `addColumn` starts a new one. */
  | { kind: "modifyTable"; id: string; schema: string; table: string | null; focusColumn?: string; addColumn?: boolean }
  /** Quick Documentation of a tree node, shown at `anchor` (client coordinates). */
  | { kind: "quickDoc"; node: DbNode; anchor: { x: number; y: number } }
  | { kind: "password"; source: DataSource; resolve: (ok: boolean) => void }
  /** SSH password or key passphrase (`prompt` is the backend's reason). */
  | { kind: "sshSecret"; source: DataSource; prompt: string; resolve: (ok: boolean) => void }
  /** Values of query parameters (`null`: cancelled). */
  | { kind: "params"; names: string[]; resolve: (values: Record<string, string> | null) => void }
  /** Export Data of a result or table page; `source` names it (`main.customers`). */
  | { kind: "export"; data: ExportData; source: string; format?: ExportFormat }
  /** Browse Query History of target `id`; Paste goes to console `path`. */
  | { kind: "history"; id: string; path: string | null }
  /** Import Data from File into a table. */
  | { kind: "import"; id: string; schema: string; table: string }
  /** Compare Structure: `source` starts as the schema the action was invoked on. */
  | { kind: "compareSchemas"; source: { id: string; schema: string } | null }
  /** Export with 'pg_dump' of a database, schema or table. */
  | { kind: "dump"; target: string; database: string; schemas?: string; tables?: string; serverVersion: number | null }
  /** Restore with 'pg_restore' / 'psql' into a database. */
  | { kind: "restore"; target: string; database: string; serverVersion: number | null }
  /** Export with 'mysqldump' of a data source, database or table. */
  | { kind: "mysqlDump"; target: string; database: string; tables?: string }
  /** Restore with 'mysql' into a database. */
  | { kind: "mysqlRestore"; target: string; database: string };

/** The schemas and tables of a data source's databases, as far as introspection has read them. */
export interface SourceCatalog {
  status: "running" | "done" | "cancelled";
  done: number;
  total: number;
  /** When the oldest of the databases was read (ms since the epoch; absent: nothing read yet). */
  readAt?: number;
  /** Database → its schemas with their tables and views. */
  databases: Record<string, DbCatalogSchema[]>;
}

export interface ConsoleExecution {
  startedAt: number;
  statements: number;
  active: { index: number; startedAt: number } | null;
}

export type StatementProgress = Exclude<ExecutionEvent, { type: "done" }>;

interface DatabaseState {
  sources: DataSource[];
  loaded: boolean;
  /** Connected targets (see `splitTarget`). */
  connected: Set<string>;
  /** Data source id → databases of its server (PostgreSQL). */
  databases: Record<string, Loaded<DbDatabases>>;
  /** Data source id → what its introspection has read (Snowflake; see `introspection.ts`). */
  catalogs: Record<string, SourceCatalog>;
  /** Target → schemas. */
  schemas: Record<string, Loaded<string[]>>;
  /** `${id}\u0000${schema}` → tables. */
  tables: Record<string, Loaded<DbTableInfo[]>>;
  /** `${id}\u0000${schema}\u0000${table}` → columns / indexes. */
  details: Record<string, Loaded<DbTableDetails>>;
  /** `${id}\u0000${schema}` → routines and sequences (loaded with the tables). */
  objects: Record<string, DbSchemaObjects>;
  /** Console / SQL file path → data source id. */
  consoles: Record<string, string>;
  /** Console path → its active schema (unqualified names resolve there; see `consoleSchema`). */
  consoleSchemas: Record<string, string>;
  separateProceduresAndFunctions: boolean;
  completion: Record<string, DbCompletion>;
  results: ResultTab[];
  /** Results shown in the editor under their statements (In-Editor Results), oldest first. */
  inline: ResultTab[];
  /** Result tab id, or `OUTPUT_TAB`. */
  activeResult: number | null;
  output: OutputLine[];
  /** Console path → running request. */
  running: Record<string, RequestId>;
  /** Console path → what its running request submitted, and since when (ms since the epoch). */
  executions: Record<string, ConsoleExecution>;
  maxRows: number;
  dialog: DialogState | null;
  /** Target of the tree's lead node. */
  selectedSource: string | null;
  /** The tree's lead node: what the tree actions act on. */
  selectedNode: DbNode | null;
  /** The toolbar's New popup is open. */
  newMenuOpen: boolean;
  /** Expanded nodes of the Database tree. */
  treeExpanded: Set<string>;
  /** A tree node to select and scroll to (Go to Declaration from a console). */
  treeReveal: { path: string[]; seq: number } | null;
  /** Last value entered per query parameter name. */
  paramValues: Record<string, string>;
  /** Data sources in manual-commit mode. */
  manualCommit: Set<string>;
  /** Manual-commit data sources with statements not yet committed. */
  pendingTx: Set<string>;
}

function readBindings(): Record<string, string> {
  try {
    const raw = localStorage.getItem(BINDINGS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function readConsoleSchemas(): Record<string, string> {
  try {
    const raw = localStorage.getItem(CONSOLE_SCHEMAS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function readSeparateProceduresAndFunctions(): boolean {
  try {
    const raw = localStorage.getItem(VIEW_OPTIONS_KEY);
    return raw ? JSON.parse(raw)?.separateProceduresAndFunctions === true : false;
  } catch {
    return false;
  }
}

export const useDatabase = create<DatabaseState>(() => ({
  sources: [],
  loaded: false,
  connected: new Set(),
  databases: {},
  catalogs: {},
  schemas: {},
  tables: {},
  details: {},
  objects: {},
  consoles: readBindings(),
  consoleSchemas: readConsoleSchemas(),
  separateProceduresAndFunctions: readSeparateProceduresAndFunctions(),
  completion: {},
  results: [],
  inline: [],
  activeResult: null,
  output: [],
  running: {},
  executions: {},
  maxRows: 500,
  dialog: null,
  selectedSource: null,
  selectedNode: null,
  newMenuOpen: false,
  treeExpanded: new Set(),
  treeReveal: null,
  paramValues: {},
  manualCommit: new Set(),
  pendingTx: new Set(),
}));

export function toggleSeparateProceduresAndFunctions() {
  const separateProceduresAndFunctions = !useDatabase.getState().separateProceduresAndFunctions;
  useDatabase.setState({ separateProceduresAndFunctions });
  try {
    localStorage.setItem(VIEW_OPTIONS_KEY, JSON.stringify({ separateProceduresAndFunctions }));
  } catch {
    // Per-viewer convenience only.
  }
}

export const tablesKey = (id: string, schema: string) => `${id}\u0000${schema}`;
export const detailsKey = (id: string, schema: string, table: string) => `${id}\u0000${schema}\u0000${table}`;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The data source of a target (`<id>` or `<id>:<database>`). */
export function sourceById(id: string | null | undefined): DataSource | undefined {
  if (!id) return undefined;
  const sourceId = splitTarget(id).id;
  return useDatabase.getState().sources.find((s) => s.id === sourceId);
}

/** `name` or `name: database` for messages and pickers. */
export function targetLabel(target: string): string {
  const name = sourceById(target)?.name ?? target;
  const db = splitTarget(target).database;
  return db ? `${name}: ${db}` : name;
}

/** Targets of data source `id` that are connected. */
export function connectedTargets(id: string): string[] {
  return [...useDatabase.getState().connected].filter((t) => splitTarget(t).id === id);
}

let sourcesRequest = 0;
const connectionIntents = new Map<string, object>();
const sourceConnectionIntents = new Map<string, object>();
const sourceMutations = new Map<string, object>();

function sourceMutation(id: string): () => boolean {
  const project = projectRequest();
  const intent = {};
  sourceMutations.set(id, intent);
  return () => project() && sourceMutations.get(id) === intent;
}

/** The cached names come from the server before the visibility rules are applied. */
function sourceMetadataKey(source: DataSource | undefined): string | undefined {
  if (!source) return undefined;
  const { introspection, ...connection } = source;
  const metadata: DbIntrospection_Deserialize = {
    ...introspection,
    showSystem: !!introspection?.showSystem,
    showTemplates: !!introspection?.showTemplates,
  };
  delete metadata.allDatabases;
  delete metadata.databases;
  delete metadata.allSchemas;
  delete metadata.schemas;
  delete metadata.schemasByDatabase;
  delete metadata.objectFilter;
  return JSON.stringify([connection, metadata]);
}

function jdbcSchemaRuleKey(source: DataSource): string | undefined {
  const rules = source.introspection;
  if (rules?.allSchemas !== false) return undefined;
  return JSON.stringify([...new Set(rules.schemas?.map((pattern) => pattern.trim()).filter(Boolean))].sort());
}

export async function loadSources(): Promise<void> {
  // Closing the project resets `loaded` while its SQL consoles are still mounted.
  if (!useProject.getState().project) return;
  const request = ++sourcesRequest;
  const current = projectRequest();
  const intents = new Map(connectionIntents);
  const sourceIntents = new Map(sourceConnectionIntents);
  try {
    const [sources, connected] = await Promise.all([call(commands.dbSources()), call(commands.dbConnected())]);
    if (request !== sourcesRequest || !current()) return;
    const staleCompletionSources = new Set<string>();
    for (const old of useDatabase.getState().sources) {
      const next = sources.find((s) => s.id === old.id);
      const id = old.id ?? "";
      if (sourceMetadataKey(old) !== sourceMetadataKey(next)) forget(id);
      else if (old.driver === "jdbc" && next && jdbcSchemaRuleKey(old) !== jdbcSchemaRuleKey(next)) {
        staleCompletionSources.add(id);
      }
    }
    if (staleCompletionSources.size) {
      // JDBC completion uses the source's schema rules. Raw names and live sessions do not.
      for (const target of completionLoads.keys()) {
        if (staleCompletionSources.has(splitTarget(target).id)) completionLoads.delete(target);
      }
    }
    useDatabase.setState((s) => {
      const server = new Set(connected);
      const targets = new Set([...server, ...s.connected]);
      const live = [...targets].filter((target) => {
        const sourceId = splitTarget(target).id;
        if (!sources.some((source) => source.id === sourceId)) return false;
        const changed =
          intents.get(target) !== connectionIntents.get(target) ||
          sourceIntents.get(sourceId) !== sourceConnectionIntents.get(sourceId);
        return changed ? s.connected.has(target) : server.has(target);
      });
      const completion = staleCompletionSources.size
        ? Object.fromEntries(
            Object.entries(s.completion).filter(([target]) => !staleCompletionSources.has(splitTarget(target).id)),
          )
        : s.completion;
      return { sources, connected: new Set(live), completion, loaded: true };
    });
  } catch (e) {
    if (request !== sourcesRequest || !current()) return;
    useDatabase.setState({ loaded: true });
    notifications().notify({ level: "error", title: "Cannot read data sources", body: message(e), key: "db-sources" });
  }
}

/** Drops cached metadata of target `id` (refresh, disconnect); a data source id drops all its databases. */
function forget(id: string) {
  invalidateDatabaseRequests(id);
  const whole = !splitTarget(id).database;
  const ofTarget = (t: string) => t === id || (whole && splitTarget(t).id === id);
  const dropKeys = <T>(m: Record<string, T>) =>
    Object.fromEntries(Object.entries(m).filter(([k]) => !ofTarget(k.split("\u0000")[0]!)));
  useDatabase.setState((s) => {
    const databases = { ...s.databases };
    const catalogs = { ...s.catalogs };
    if (whole) delete databases[id];
    if (whole) delete catalogs[id];
    return {
      databases,
      catalogs,
      schemas: dropKeys(s.schemas),
      completion: dropKeys(s.completion),
      tables: dropKeys(s.tables),
      details: dropKeys(s.details),
      objects: dropKeys(s.objects),
    };
  });
}

export async function saveSource(
  source: DataSource,
  password: string | null | undefined,
  sshSecret: string | null | undefined = undefined,
): Promise<void> {
  const id = source.id ?? "";
  const st = useDatabase.getState();
  const preserve =
    password === undefined &&
    sshSecret === undefined &&
    sourceMetadataKey(st.sources.find((s) => s.id === id)) === sourceMetadataKey(source);
  const loaded = id in st.databases || Object.keys(st.schemas).some((t) => splitTarget(t).id === id);
  // Taken before anything is forgotten: what the tree had expanded under this source.
  const levels = !preserve && loaded ? loadedLevels(id) : undefined;
  const connection = connectionIntents.get(id);
  if (!preserve) forget(id);
  const current = sourceMutation(id);
  const sources = useDatabase.getState().sources;
  const next = sources.some((s) => s.id === source.id)
    ? sources.map((s) => (s.id === source.id ? source : s))
    : [...sources, source];
  await call(commands.dbSaveSources(next));
  if (!current()) return;
  // `undefined`: keep; `null`: forget; string: store.
  if (password !== undefined) await call(commands.dbSetPassword(id, password, !!source.savePassword));
  if (!current()) return;
  if (sshSecret !== undefined) await call(commands.dbSetSshSecret(id, sshSecret, !!source.ssh?.saveSecret));
  if (!current()) return;
  // What the tree had loaded for this source is reloaded with the new settings, so its
  // expanded nodes don't stay on Loading.
  await loadSources();
  if (!current() || !sourceById(id)) return;
  if (levels && connectionIntents.get(id) === connection) await refresh(id, levels);
}

export async function saveSourceVisibility(id: string, available: string[], change: DbVisibilityChange): Promise<void> {
  const current = projectRequest();
  try {
    await call(commands.dbSaveSourceVisibility(id, available, change));
  } catch (e) {
    // This command is deliberately separate: older hosts reject it before writing or disconnecting.
    if (message(e).includes("command db_save_source_visibility is not available remotely")) {
      throw new Error(tx("Update the remote OpenIDEA server to edit visibility from the tree."), { cause: e });
    }
    throw e;
  }
  if (current()) await loadSources();
}

/** Copy/Paste › Duplicate: a copy of data source `id` named `<name> [2]` (its password is not copied). */
export async function duplicateSource(id: string): Promise<void> {
  const src = sourceById(id);
  if (!src) return;
  const names = new Set(useDatabase.getState().sources.map((s) => s.name));
  let n = 2;
  while (names.has(`${src.name} [${n}]`)) n++;
  try {
    await saveSource(
      { ...src, id: newSourceId(), name: `${src.name} [${n}]`, pluginOwner: null, pluginSourceId: null },
      undefined,
    );
  } catch (e) {
    notifications().notify({ level: "error", title: "Cannot duplicate the data source", body: message(e) });
  }
}

export async function renameSource(id: string, name: string): Promise<void> {
  const src = sourceById(id);
  if (!src || !name.trim() || name.trim() === src.name) return;
  // Saved like any edit, so what the tree had loaded under the source is loaded again.
  await saveSource({ ...src, name: name.trim() }, undefined);
}

/** Removes the data source after asking (Database tree › Drop on a source). */
export async function removeSource(source: DataSource): Promise<void> {
  const ok = await confirm({
    title: "Remove Data Source",
    message: tx`Remove data source '${source.name}'? Its query console file stays on disk.`,
    ok: "Remove",
  });
  if (!ok) return;
  const id = source.id ?? "";
  if (connectedTargets(id).length) await disconnect(id);
  await deleteSource(id);
}

export async function deleteSource(id: string): Promise<void> {
  forget(id);
  const current = sourceMutation(id);
  await call(commands.dbSaveSources(useDatabase.getState().sources.filter((s) => s.id !== id)));
  if (!current()) return;
  await loadSources();
}

export function openSourceDialog(source: DataSource | null, preset?: Partial<DataSource>, password?: string | null) {
  useDatabase.setState({ dialog: { kind: "source", source, preset, password } });
}

export function openDialog(dialog: DialogState) {
  useDatabase.setState({ dialog });
}

export function closeDialog() {
  useDatabase.setState({ dialog: null });
}

/** Asks for the password of `source` (ask-on-connect); resolves false when cancelled. */
function askPassword(source: DataSource): Promise<boolean> {
  return new Promise((resolve) => useDatabase.setState({ dialog: { kind: "password", source, resolve } }));
}

function askSshSecret(source: DataSource, prompt: string): Promise<boolean> {
  return new Promise((resolve) => useDatabase.setState({ dialog: { kind: "sshSecret", source, prompt, resolve } }));
}

/** First connection to an SSH host: trust its key (added to ~/.ssh/known_hosts)? */
function askTrustHost(prompt: string): Promise<boolean> {
  return confirm({
    title: "Unknown SSH Host",
    icon: "warning",
    message: `${prompt}. The authenticity of the host cannot be established. Trust it and add the key to ~/.ssh/known_hosts?`,
    ok: "Trust and Connect",
  });
}

/** Asks the user what a failed connection needs (password, SSH secret, host key trust); false = give up. */
export async function resolveConnectError(e: unknown, source: DataSource): Promise<boolean> {
  if (!(e instanceof IpcError)) return false;
  // Prompts show the SSH configuration's host and authentication when the tunnel uses one.
  const resolved = { ...source, ssh: effectiveSsh(source.ssh, workflowSettings().ssh.configs) };
  switch (connectRemedy(e.kind, e.message, resolved)) {
    case "password":
      return askPassword(source);
    case "sshSecret":
      return askSshSecret(resolved, e.message);
    case "trustHostKey":
      if (!(await askTrustHost(e.message))) return false;
      await call(commands.dbTrustSshHost(source.id ?? ""));
      return true;
    default:
      return false;
  }
}

/** Target → time of its last use (Options › Auto-disconnect). */
const lastUsed = new Map<string, number>();

/** Options › Transaction control: a manual data source's consoles start in manual commit. */
function applyConnectDefaults(id: string) {
  if (
    sourceById(id)?.driver !== "clickhouse" &&
    sourceById(id)?.driver !== "jdbc" &&
    sourceById(id)?.options?.transaction === "manual" &&
    !useDatabase.getState().manualCommit.has(id)
  )
    void setManualCommit(id, true).catch(() => {});
}

/** Runs `op`, asking for passwords / host key trust and retrying when the connection needs them. */
export async function withConnection<T>(id: string, op: () => Promise<T>): Promise<T> {
  const current = databaseRequest(id);
  for (;;) {
    try {
      const r = await op();
      // A completed write keeps its result, but must not revive an old connection.
      if (!current()) return r;
      connectionIntents.set(id, {});
      lastUsed.set(id, Date.now());
      if (!useDatabase.getState().connected.has(id)) {
        useDatabase.setState((s) => ({ connected: new Set(s.connected).add(id) }));
        applyConnectDefaults(id);
      }
      return r;
    } catch (e) {
      if (!current()) throw new IpcError({ kind: "cancelled", message: "Cancelled", data: null });
      const source = sourceById(id);
      if (!source || !(await resolveConnectError(e, source))) throw e;
      if (!current()) throw new IpcError({ kind: "cancelled", message: "Cancelled", data: null });
    }
  }
}

export async function connect(id: string): Promise<boolean> {
  const current = databaseRequest(id);
  try {
    await withConnection(id, () => call(commands.dbConnect(id)));
    return current();
  } catch (e) {
    if (!isCancelled(e))
      notifications().notify({ level: "error", title: `Cannot connect to ${targetLabel(id)}`, body: message(e) });
    return false;
  }
}

/** Disconnects target `id`; a data source id disconnects all its databases. */
export async function disconnect(id: string): Promise<void> {
  const targets = splitTarget(id).database ? [id] : connectedTargets(id);
  if (!targets.includes(id)) targets.push(id);
  const current = projectRequest();
  forget(id);
  useDatabase.setState((s) => ({ treeExpanded: collapseTarget(s.treeExpanded, id) }));
  const intent = {};
  for (const target of targets) connectionIntents.set(target, intent);
  if (!splitTarget(id).database) sourceConnectionIntents.set(id, {});
  await Promise.all(targets.map((t) => call(commands.dbDisconnect(t))));
  if (!current()) return;
  if (!splitTarget(id).database) sourceConnectionIntents.set(id, {});
  useDatabase.setState((s) => {
    const connected = new Set(s.connected);
    for (const t of targets) {
      if (connectionIntents.get(t) !== intent) continue;
      connected.delete(t);
      connectionIntents.set(t, {});
    }
    return { connected };
  });
}

/** Disconnects targets idle past their data source's Auto-disconnect; returns the stopper. */
export function watchIdleConnections(everyMs = 5000): () => void {
  const timer = setInterval(() => {
    const s = useDatabase.getState();
    const running = new Set(Object.keys(s.running).map((path) => s.consoles[path]));
    const busy = (t: string) => running.has(t) || s.pendingTx.has(t);
    for (const t of idleTargets(s.connected, s.sources, lastUsed, busy, Date.now())) {
      lastUsed.delete(t);
      void disconnect(t).then(() => log("info", `${targetLabel(t)}: disconnected after being idle`));
    }
  }, everyMs);
  return () => clearInterval(timer);
}

/** Managed consoles show their source in the tab. Ordinary SQL files can also inherit a source tint. */
export function consoleDecorations(s: Pick<DatabaseState, "consoles" | "sources">): Map<string, FileDecoration> {
  const out = new Map<string, FileDecoration>();
  for (const [path, target] of Object.entries(s.consoles)) {
    const { id, database } = splitTarget(target);
    const source = s.sources.find((x) => x.id === id);
    if (!source) continue;
    const tint = colorVar(source.color);
    // db_console_path and db_consoles own this directory, including already saved consoles.
    const consoleName = /(?:^|\/)consoles\/db\/[^/]+\/(console(?:_\d+)?)\.sql$/.exec(path.replaceAll("\\", "/"))?.[1];
    if (consoleName) {
      const name = source.name || id;
      const label = database ? `${name}: ${database}` : name;
      out.set(path, { tint, tabTitle: `${consoleName} [${label}]`, tabIcon: sourceIcon(source) });
    } else if (tint) out.set(path, { tint });
  }
  return out;
}

/** PostgreSQL, SQL Server and Snowflake data sources show their server's databases (IDEA's data source › database › schema). */
export function listsDatabases(source: DataSource | undefined): boolean {
  return (
    (source?.driver === "postgres" || source?.driver === "sqlServer" || source?.driver === "snowflake") &&
    !source.options?.singleDatabase
  );
}

/** New › Database and Drop on database nodes: PostgreSQL and SQL Server data sources that show their databases. */
export function createsDatabases(source: DataSource | undefined): boolean {
  return listsDatabases(source) && source?.driver !== "snowflake";
}

/** The target New › Schema creates a schema in: a database node, or a data source that shows schemas directly. */
export function newSchemaTarget(n: DbNode): string | null {
  if (n.kind === "database") return createsDatabases(sourceById(n.id)) ? n.id : null;
  if (n.kind !== "source" || !n.source.id) return null;
  const driver = n.source.driver;
  if (driver !== "postgres" && driver !== "sqlServer" && driver !== "mysql") return null;
  return listsDatabases(n.source) ? null : n.source.id;
}

interface LoadedLevels {
  schemas: string[];
  tables: [string, string][];
  details: [string, string, string][];
}

/** The metadata of target `id` (a data source id: all its databases) the tree has loaded. */
function loadedLevels(id: string): LoadedLevels {
  const whole = !splitTarget(id).database;
  const ofTarget = (k: string) => {
    const t = k.split("\u0000")[0]!;
    return t === id || (whole && splitTarget(t).id === id);
  };
  const st = useDatabase.getState();
  const loaded = (m: Record<string, Loaded<unknown>>) =>
    Object.keys(m).filter((k) => ofTarget(k) && m[k]!.status === "ok");
  return {
    schemas: loaded(st.schemas),
    tables: loaded(st.tables).map((k) => k.split("\u0000") as [string, string]),
    details: loaded(st.details).map((k) => k.split("\u0000") as [string, string, string]),
  };
}

/**
 * Re-reads the metadata of target `id` (a data source id: all its databases),
 * reloading the levels that were loaded (`levels`) so the tree keeps its expanded nodes.
 */
export async function refresh(id: string, levels = loadedLevels(id)): Promise<void> {
  const whole = !splitTarget(id).database;
  const { tables, details } = levels;
  const schemas = [...levels.schemas];
  forget(id);
  const current = databaseRequest(id);
  const targets = new Map(
    [...new Set([...schemas, ...tables.map(([t]) => t), ...details.map(([t]) => t)])].map((target) => [
      target,
      databaseRequest(target),
    ]),
  );
  const valid = (target: string) => targets.get(target)?.() ?? current();
  if (whole && listsDatabases(sourceById(id))) await loadDatabases(id);
  else if (!schemas.includes(id)) schemas.push(id);
  if (!current()) return;
  await Promise.all(schemas.filter(valid).map((t) => loadSchemas(t)));
  if (!current()) return;
  await Promise.all(tables.filter(([t]) => valid(t)).map(([t, schema]) => loadTables(t, schema)));
  if (!current()) return;
  const exists = (t: string, schema: string, table: string) => {
    const l = useDatabase.getState().tables[tablesKey(t, schema)];
    return l?.status === "ok" && l.value.some((x) => x.name === table);
  };
  await Promise.all(
    details.filter((d) => valid(d[0]) && exists(...d)).map(([t, schema, table]) => loadDetails(t, schema, table)),
  );
}

function metadataRequest(id: string, cache: "databases" | "schemas" | "tables" | "details", key = id) {
  const current = databaseRequest(id);
  const loading = { status: "loading" as const };
  useDatabase.setState((s) => ({ ...s, [cache]: { ...s[cache], [key]: loading } }));
  return () => current() && useDatabase.getState()[cache][key] === loading;
}

export async function loadDatabases(id: string): Promise<void> {
  const current = metadataRequest(id, "databases");
  try {
    const value = await withConnection(id, () => call(commands.dbDatabases(id)));
    if (!current()) return;
    useDatabase.setState((s) => ({ databases: { ...s.databases, [id]: { status: "ok", value } } }));
  } catch (e) {
    if (!current()) return;
    useDatabase.setState((s) => ({ databases: { ...s.databases, [id]: { status: "error", message: message(e) } } }));
  }
}

export async function loadSchemas(id: string): Promise<void> {
  const current = metadataRequest(id, "schemas");
  try {
    const value = await withConnection(id, () => call(commands.dbSchemas(id)));
    if (!current()) return;
    useDatabase.setState((s) => ({ schemas: { ...s.schemas, [id]: { status: "ok", value } } }));
  } catch (e) {
    if (!current()) return;
    useDatabase.setState((s) => ({ schemas: { ...s.schemas, [id]: { status: "error", message: message(e) } } }));
  }
}

export async function loadTables(id: string, schema: string): Promise<void> {
  const key = tablesKey(id, schema);
  const current = metadataRequest(id, "tables", key);
  try {
    const value = await withConnection(id, () => call(commands.dbTables(id, schema)));
    if (!current()) return;
    // Routines / sequences are extras: a server refusing their catalog still lists tables.
    const objects = await call(commands.dbSchemaObjects(id, schema)).catch(() => null);
    if (!current()) return;
    useDatabase.setState((s) => ({
      tables: { ...s.tables, [key]: { status: "ok", value } },
      objects: objects ? { ...s.objects, [key]: objects } : s.objects,
    }));
  } catch (e) {
    if (!current()) return;
    useDatabase.setState((s) => ({ tables: { ...s.tables, [key]: { status: "error", message: message(e) } } }));
  }
}

/** The tables of `schema` on target `id` with their columns, indexes and foreign keys (Compare Structure). */
export async function schemaSnapshot(id: string, schema: string, signal?: AbortSignal): Promise<TableSnapshot[]> {
  const tables = (await withConnection(id, () => call(commands.dbTables(id, schema)))).filter(
    (t) => t.kind === "table",
  );
  const out: TableSnapshot[] = [];
  let next = 0;
  const worker = async () => {
    while (next < tables.length) {
      if (signal?.aborted) return;
      const t = tables[next++]!;
      const details = await call(commands.dbTableDetails(id, schema, t.name));
      out.push({ name: t.name, kind: t.kind, ...details });
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, tables.length) }, worker));
  return out;
}

export async function loadDetails(id: string, schema: string, table: string): Promise<void> {
  const key = detailsKey(id, schema, table);
  const current = metadataRequest(id, "details", key);
  try {
    const value = await withConnection(id, () => call(commands.dbTableDetails(id, schema, table)));
    if (!current()) return;
    useDatabase.setState((s) => ({ details: { ...s.details, [key]: { status: "ok", value } } }));
  } catch (e) {
    if (!current()) return;
    useDatabase.setState((s) => ({ details: { ...s.details, [key]: { status: "error", message: message(e) } } }));
  }
}

/**
 * Selects a table (or one of its columns) in the Database tool window,
 * loading and expanding the nodes that lead to it. Without `kind` the loaded
 * tables tell whether it is a table or a view.
 */
export async function revealInTree(
  id: string,
  schema: string,
  table: string,
  kind: DbTableKind | undefined,
  column?: string,
): Promise<void> {
  const current = databaseRequest(id);
  const loaded = (l: Loaded<unknown> | undefined) => l?.status === "ok";
  const { id: sourceId, database } = splitTarget(id);
  let databaseNode: string[] = [];
  if (listsDatabases(sourceById(id))) {
    if (!loaded(useDatabase.getState().databases[sourceId])) {
      if (!(await connect(sourceId))) return;
      if (!current()) return;
      await loadDatabases(sourceId);
      if (!current()) return;
    }
    const dbs = useDatabase.getState().databases[sourceId];
    const name = database ?? (dbs?.status === "ok" ? dbs.value.current : null);
    if (name) databaseNode = [databaseKey(sourceId, name)];
  }
  if (!loaded(useDatabase.getState().schemas[id])) {
    if (!(await connect(id))) return;
    if (!current()) return;
    await loadSchemas(id);
    if (!current()) return;
  }
  if (!loaded(useDatabase.getState().tables[tablesKey(id, schema)])) await loadTables(id, schema);
  if (!current()) return;
  if (column && !loaded(useDatabase.getState().details[detailsKey(id, schema, table)]))
    await loadDetails(id, schema, table);
  if (!current()) return;
  const tables = useDatabase.getState().tables[tablesKey(id, schema)];
  kind ??= (tables?.status === "ok" ? tables.value.find((t) => t.name === table)?.kind : undefined) ?? "table";
  const folder = `${id}/${schema}/${tableFolder(kind)}`;
  const tableKey = `${folder}/${table}`;
  selectInTree(
    [sourceId, ...databaseNode, `${id}/${schema}`, folder, ...(column ? [tableKey, `${tableKey}/columns`] : [])],
    column ? `${tableKey}/columns/${column}` : tableKey,
  );
}

/**
 * Expands `open` and selects node `key` in the Database tool window, showing it.
 * A node the tree doesn't show (filtered out, dropped) selects its nearest shown ancestor.
 */
function selectInTree(open: string[], key: string) {
  useDatabase.setState((s) => ({
    treeExpanded: new Set([...s.treeExpanded, ...open]),
    treeReveal: { path: [...open, key], seq: (s.treeReveal?.seq ?? 0) + 1 },
  }));
  // Not `show(…, true)`: activation focuses the filter field after the view focuses the tree.
  toolWindowService().show(DB_TOOL_WINDOW);
}

/**
 * Select Opened File: the active table editor's table, else the schema (or
 * database / data source) a SQL console runs in. A console reveals only nodes
 * already loaded: it never connects.
 */
export async function revealOpened(): Promise<void> {
  const input = maybeEditorService()?.activeInput?.();
  if (input?.kind === TABLE_KIND) {
    const { id, schema, table } = input.data as TableRef;
    return revealInTree(id, schema, table, undefined);
  }
  const editor = activeEditor();
  if (editor?.ctx.language !== SQL_LANGUAGE || (input && input.path !== editor.ctx.path)) return;
  const target = consoleSource(editor.ctx.path);
  if (!target) return;
  const s = useDatabase.getState();
  const { id: sourceId, database } = splitTarget(target);
  const open: string[] = [];
  let key = sourceId;
  let nodeTarget = target;
  if (listsDatabases(sourceById(sourceId))) {
    const dbs = s.databases[sourceId];
    const name = database ?? (dbs?.status === "ok" ? dbs.value.current : null);
    if (dbs?.status !== "ok" || !name) return selectInTree(open, key);
    open.push(key);
    key = databaseKey(sourceId, name);
    nodeTarget = targetOf(sourceId, name, dbs.value.current);
  }
  const schema = consoleSchema(editor.ctx.path);
  const schemas = s.schemas[nodeTarget];
  if (schema && schemas?.status === "ok" && schemas.value.includes(schema)) {
    open.push(key);
    key = `${nodeTarget}/${schema}`;
  }
  selectInTree(open, key);
}

const completionLoads = new Map<string, { current: () => boolean; promise: Promise<DbCompletion | null> }>();
const preparingConsoles = new Map<string, RequestId>();
const stopResultDelivery = new Map<RequestId, () => void>();
const incompleteResultDelivery = Symbol("incomplete SQL result delivery");
const streamingResultTabs = new Set<number>();

/** The schema model of `id` for completion (cached; one load at a time). */
export function loadCompletion(id: string): Promise<DbCompletion | null> {
  const cached = useDatabase.getState().completion[id];
  if (cached) return Promise.resolve(cached);
  let pending = completionLoads.get(id);
  if (!pending?.current()) {
    const current = databaseRequest(id);
    const promise = call(commands.dbCompletion(id))
      .then((model) => {
        if (!current() || completionLoads.get(id)?.promise !== promise) return null;
        useDatabase.setState((s) => ({ completion: { ...s.completion, [id]: model } }));
        return model;
      })
      .catch(() => null)
      .finally(() => {
        if (completionLoads.get(id)?.promise === promise) completionLoads.delete(id);
      });
    pending = { current, promise };
    completionLoads.set(id, pending);
  }
  return pending.promise;
}

useProject.subscribe((state, previous) => {
  if (state.project?.root === previous.project?.root) return;
  sourcesRequest++;
  connectionIntents.clear();
  sourceConnectionIntents.clear();
  sourceMutations.clear();
  completionLoads.clear();
  preparingConsoles.clear();
  lastUsed.clear();
});

// ---- consoles ----------------------------------------------------------------

export function bindConsole(path: string, id: string | null) {
  useDatabase.setState((s) => {
    const consoles = { ...s.consoles };
    if (id) consoles[path] = id;
    else delete consoles[path];
    try {
      localStorage.setItem(BINDINGS_KEY, JSON.stringify(consoles));
    } catch {
      // Per-viewer convenience only.
    }
    // Re-bound to another data source: the console starts from its default schema again.
    const consoleSchemas = { ...s.consoleSchemas };
    if (consoles[path] !== s.consoles[path]) {
      delete consoleSchemas[path];
      try {
        localStorage.setItem(CONSOLE_SCHEMAS_KEY, JSON.stringify(consoleSchemas));
      } catch {
        // Per-viewer convenience only.
      }
    }
    return { consoles, consoleSchemas };
  });
}

/** The schema a console's statements run in: its pick, else the connection's default. */
export function consoleSchema(path: string): string {
  const s = useDatabase.getState();
  const id = consoleSource(path);
  // A scope's schema applies while the console is on that scope's data source.
  const scope = s.consoles[path] ? null : scopeOf(path);
  const picked = s.consoleSchemas[path] ?? (scope && scope.dataSource === id ? scope.schema : undefined);
  return activeSchema(picked || undefined, id ? s.completion[id]?.defaultSchema : undefined);
}

/** Sets (or clears, for `null`) the console's active schema and remembers it per console file. */
export function setConsoleSchema(path: string, schema: string | null) {
  useDatabase.setState((s) => {
    const consoleSchemas = { ...s.consoleSchemas };
    if (schema) consoleSchemas[path] = schema;
    else delete consoleSchemas[path];
    try {
      localStorage.setItem(CONSOLE_SCHEMAS_KEY, JSON.stringify(consoleSchemas));
    } catch {
      // Per-viewer convenience only.
    }
    return { consoleSchemas };
  });
}

/** The SQL resolution scope of file `path` (Languages & Frameworks › SQL Resolution Scopes), if any. */
function scopeOf(path: string): SqlResolutionScope | null {
  const { project, settings } = useProject.getState();
  if (!project) return null;
  const sources = useDatabase.getState().sources;
  return resolutionScopeOf(path, project.root, resolutionScopesOf(settings), (id) =>
    sources.some((x) => x.id === splitTarget(id).id),
  );
}

/**
 * The data source a console / SQL file runs on and resolves against: the one picked in its
 * toolbar, else its SQL resolution scope's, else the only data source.
 */
export function consoleSource(path: string): string | null {
  const s = useDatabase.getState();
  const bound = s.consoles[path];
  if (bound && s.sources.some((x) => x.id === splitTarget(bound).id)) return bound;
  const scope = scopeOf(path);
  if (scope) return scope.dataSource;
  return s.sources.length === 1 ? (s.sources[0]!.id ?? null) : null;
}

/** Opens (creating it on first use) the query console of data source `id`. */
export async function openConsole(id: string): Promise<void> {
  try {
    const path = await call(commands.dbConsolePath(id));
    bindConsole(path, id);
    await editorService().openFile(path, { focus: true });
  } catch (e) {
    notifications().notify({ level: "error", title: "Cannot open the query console", body: message(e) });
  }
}

/** The query console files of data source `id`: `console.sql`, then `console_1.sql`, `console_2.sql`… */
export function consoleFiles(id: string): Promise<string[]> {
  return call(commands.dbConsoles(id, false));
}

/** Opens one of the query consoles of data source `id`. */
export async function openConsoleFile(id: string, path: string): Promise<void> {
  bindConsole(path, id);
  await editorService().openFile(path, { focus: true });
}

/** Creates and opens another query console of data source `id` (DataGrip's New › Query Console). */
export async function newConsole(id: string): Promise<void> {
  try {
    const before = new Set(await consoleFiles(id));
    const after = await call(commands.dbConsoles(id, true));
    const path = after.find((p) => !before.has(p)) ?? after[after.length - 1];
    if (path) await openConsoleFile(id, path);
  } catch (e) {
    notifications().notify({ level: "error", title: "Cannot open the query console", body: message(e) });
  }
}

let nextTab = 1;
let nextRun = 1;
let nextLine = 1;

function outputLine(kind: OutputLine["kind"], text: string, prompt?: string): OutputLine {
  return { id: nextLine++, time: Date.now(), kind, text, prompt };
}

export function log(kind: OutputLine["kind"], text: string, prompt?: string) {
  const line = outputLine(kind, text, prompt);
  useDatabase.setState((s) => ({ output: [...s.output, line].slice(-MAX_OUTPUT) }));
}

export function clearOutput() {
  useDatabase.setState({ output: [] });
}

function elapsed(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** IDEA's summary line of an executed statement. */
export function outcomeSummary(o: DbStatementOutcome): string {
  const r = o.result;
  if (!r) return o.error ?? "";
  const n = r.columns.length ? r.rows.length : (r.affected ?? 0);
  const rows = `${n} row${n === 1 ? "" : "s"}`;
  if (!r.columns.length) return `${rows} affected in ${elapsed(r.elapsedMs ?? 0)}`;
  const total = r.elapsedMs ?? 0;
  const execution = Math.min(total, r.executionMs ?? total);
  const split = ` (execution: ${elapsed(execution)}, fetching: ${elapsed(total - execution)})`;
  return `${rows} retrieved starting from 1 in ${elapsed(total)}${split}${r.hasMore ? " (limit reached)" : ""}`;
}

/** The schema shown as the Output prompt (`main>`). */
function promptOf(id: string): string {
  return useDatabase.getState().completion[id]?.defaultSchema || sourceById(id)?.name || id;
}

function changesSchema(outcome: DbStatementOutcome): boolean {
  return !outcome.error && /^\s*(create|drop|alter|rename)\b/i.test(outcome.statement.text);
}

function outcomeUpdates(
  state: DatabaseState,
  id: string,
  schema: string | undefined,
  outcomes: readonly DbStatementOutcome[],
  logConnected: boolean,
): Pick<DatabaseState, "output" | "pendingTx"> {
  const prompt = `${schema || promptOf(id)}>`;
  const lines = logConnected ? [outputLine("info", "Connected")] : [];
  for (const outcome of outcomes) {
    lines.push(outputLine("statement", outcome.statement.text, prompt));
    lines.push(
      outcome.error
        ? outputLine("error", `[${targetLabel(id)}] ${outcome.error}`)
        : outputLine("result", outcomeSummary(outcome)),
    );
  }
  const pending =
    state.manualCommit.has(id) &&
    !state.pendingTx.has(id) &&
    outcomes.some((outcome) => !outcome.error && !READS.test(outcome.statement.text));
  return {
    output: [...state.output, ...lines].slice(-MAX_OUTPUT),
    pendingTx: pending ? new Set(state.pendingTx).add(id) : state.pendingTx,
  };
}

/**
 * Runs `statements` on `id`, logging to Output; errors stop the batch (backend).
 * Results keep `maxRows` rows after the first `skip`, which the backend reads past.
 * `schema` is a console's active context: the backend puts the connection that runs
 * each statement in it, so unqualified names resolve there.
 */
/** Shows `id` disconnected when the backend closed its connection (it reconnects on next use). */
async function syncDropped(id: string) {
  const current = databaseRequest(id);
  const server = await call(commands.dbConnected()).catch(() => null);
  if (!current() || !server || server.includes(id) || !useDatabase.getState().connected.has(id)) return;
  useDatabase.setState((s) => {
    const connected = new Set(s.connected);
    connected.delete(id);
    return { connected };
  });
  log("info", `${targetLabel(id)}: the connection was lost; the next statement reconnects`);
}

async function run(
  id: string,
  statements: SqlStatement[],
  request: RequestId,
  maxRows = useDatabase.getState().maxRows,
  skip = 0,
  schema?: string,
  progress?: {
    emit: (event: StatementProgress) => void;
    current: () => boolean;
    onStatementCancelled: () => void;
    onIncompleteDelivery: () => void;
  },
): Promise<DbStatementOutcome[]> {
  const current = databaseRequest(id);
  const wasConnected = useDatabase.getState().connected.has(id);
  const outcomes = await withConnection(id, async () => {
    const execute = async () => {
      progress?.emit({ type: "started", index: 0 });
      const outcomes = await call(commands.dbExecute(request, id, statements, skip, maxRows, schema || null)).catch(
        (error: unknown) => {
          if (isCancelled(error)) progress?.onStatementCancelled();
          throw error;
        },
      );
      outcomes.forEach((outcome, index) => progress?.emit({ type: "completed", index, outcome }));
      return outcomes;
    };
    if (!progress || statements.length === 1) return execute();
    const outcomes: DbStatementOutcome[] = [];
    let received = false;
    let runningStatement = false;
    let acknowledged = false;
    let stopRequested = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let finish!: (result: Error | typeof incompleteResultDelivery | null) => void;
    const done = new Promise<Error | typeof incompleteResultDelivery | null>((resolve) => (finish = resolve));
    const waitForDelivery = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => finish(incompleteResultDelivery), RESULT_DELIVERY_TIMEOUT_MS);
    };
    const channel = new Channel<ExecutionEvent>();
    channel.onmessage = (event) => {
      received = true;
      if (event.type === "done") {
        if (event.error?.kind === "cancelled" && runningStatement) progress.onStatementCancelled();
        finish(event.error ? new IpcError(event.error) : null);
        return;
      }
      runningStatement = event.type === "started";
      if (event.type === "completed") outcomes.push(event.outcome);
      progress.emit(event);
      if (acknowledged) waitForDelivery();
    };
    stopResultDelivery.set(request, () => {
      stopRequested = true;
      if (acknowledged) finish(incompleteResultDelivery);
    });
    try {
      // Large channel frames can arrive after the reply. Bound only this delivery wait.
      await call(commands.dbExecuteStream(request, id, statements, maxRows, schema || null, channel));
      acknowledged = true;
      waitForDelivery();
      const result = await done;
      if (result === incompleteResultDelivery) progress.onIncompleteDelivery();
      else if (result) throw result;
      return outcomes;
    } catch (error) {
      // An older remote dispatcher rejects the missing command before it executes any SQL.
      if (
        !received &&
        progress.current() &&
        isRemoteWindow() &&
        error instanceof IpcError &&
        error.kind === "protocol" &&
        error.message === "command db_execute_stream is not available remotely"
      ) {
        if (stopRequested) throw new IpcError({ kind: "cancelled", message: tx("Cancelled") });
        return execute();
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      stopResultDelivery.delete(request);
      channel.onmessage = () => {};
    }
  });
  if (!current()) return outcomes;
  // A failed statement can have found the session dead; the backend then dropped it.
  if (outcomes.some((o) => o.error)) void syncDropped(id);
  // Consoles publish the same outcome updates alongside their progress and grids.
  if (progress) return outcomes;
  useDatabase.setState((s) => outcomeUpdates(s, id, schema, outcomes, !wasConnected));
  if (outcomes.some(changesSchema)) void refresh(id);
  return outcomes;
}

/**
 * Runs statements the tree's object actions generated (Drop, Rename, Modify
 * Table…) on `id`, logging them to Output; false (and a notification) on error.
 */
export async function runSql(id: string, texts: string[]): Promise<boolean> {
  const statements = texts.map((t) => {
    const text = t.trim().replace(/;$/, "");
    return { from: 0, to: text.length, text };
  });
  try {
    const outcomes = await run(id, statements, nextRequestId());
    const failed = outcomes.find((o) => o.error);
    if (failed) {
      notifications().notify({
        level: "error",
        title: `[${targetLabel(id)}] ${failed.statement.text}`,
        body: failed.error ?? "",
      });
      return false;
    }
    return true;
  } catch (e) {
    if (!isCancelled(e))
      notifications().notify({ level: "error", title: `Cannot execute on ${targetLabel(id)}`, body: message(e) });
    return false;
  }
}

/**
 * Creates a database on data source `id` with `sql` after disconnecting `template`, then refreshes
 * the data source, reloading what the tree had shown of `template` too.
 */
export async function createDatabase(id: string, template: string, sql: string): Promise<boolean> {
  const levels = loadedLevels(id);
  await disconnect(`${id}:${template}`);
  try {
    // Asks for a password the data source does not save, like any statement it runs.
    await withConnection(id, () => call(commands.dbCreateDatabase(id, template, sql)));
  } catch (e) {
    notifications().notify({ level: "error", title: tx`Cannot create database`, body: message(e) });
    void refresh(id, levels);
    return false;
  }
  void refresh(id, levels);
  return true;
}

/** Drops `database` of data source `id` with `sql` after disconnecting it, then refreshes the data source. */
export async function dropDatabase(id: string, database: string, sql: string): Promise<boolean> {
  await disconnect(`${id}:${database}`);
  try {
    await withConnection(id, () => call(commands.dbDropDatabase(id, database, sql)));
  } catch (e) {
    notifications().notify({ level: "error", title: tx`Cannot drop database ${database}`, body: message(e) });
    return false;
  }
  void refresh(id);
  return true;
}

/** Renames `database` of data source `id` with `sql` after closing the sessions on it. */
export async function renameDatabase(id: string, database: string, sql: string): Promise<boolean> {
  await disconnect(`${id}:${database}`);
  if (!(await runSql(id, [sql]))) return false;
  void refresh(id);
  return true;
}

/** Opens the query console of `id` with `text` appended and selected (SQL Scripts › …). */
export async function openConsoleWith(id: string, text: string): Promise<void> {
  let path: string;
  try {
    path = await call(commands.dbConsolePath(id));
  } catch (e) {
    notifications().notify({ level: "error", title: "Cannot open the query console", body: message(e) });
    return;
  }
  await openConsole(id);
  // The editor mounts after `openFile` resolves.
  for (let i = 0; i < 40; i++) {
    const view = editorsFor(path)[0]?.view;
    if (view) {
      const doc = view.state.doc.toString();
      const sep = !doc || doc.endsWith("\n\n") ? "" : doc.endsWith("\n") ? "\n" : "\n\n";
      const from = doc.length + sep.length;
      view.dispatch({
        changes: { from: doc.length, insert: sep + text },
        selection: { anchor: from, head: from + text.trimEnd().length },
        scrollIntoView: true,
      });
      view.focus();
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** DDL laid out like IDEA's: SQLite returns the statements as they were typed. */
export function readableDdl(text: string, driver: DbDriver | undefined): string {
  return driver === "sqlite" ? formatted(text, driver) : text;
}

/** Go to DDL: the definition of a table / view, in a SQL file next to the data source's console. */
export async function openDdl(id: string, schema: string, name: string): Promise<void> {
  try {
    const [text, console] = await Promise.all([
      withConnection(id, () => call(commands.dbDdl(id, schema, name))),
      call(commands.dbConsolePath(id)),
    ]);
    const safe = (s: string) => s.replace(/[^\w.-]+/g, "_");
    const path = console.replace(/[^\\/]*$/, `${safe(schema)}.${safe(name)}.sql`);
    await call(commands.dbExportFile(path, readableDdl(text, sourceById(id)?.driver)));
    bindConsole(path, id);
    await editorService().openFile(path, { focus: true });
  } catch (e) {
    notifications().notify({ level: "error", title: `Cannot get the DDL of ${name}`, body: message(e) });
  }
}

/**
 * Runs the statement at `from` (or the selection `from..to`, UTF-16 offsets)
 * of console `path` on its data source. Result sets open as `Result N` tabs
 * of the Services view, replacing the console's unpinned ones; everything is
 * logged to its Output tab; returns the outcomes (errors included) for the
 * editor's marks.
 */
/** Asks for the values of the statements' query parameters and binds them; `[]` when cancelled. */
async function withParams(statements: SqlStatement[], driver: DbDriver): Promise<SqlStatement[]> {
  let numbered = 0;
  const found = statements.map((st) => {
    const params = findParams(st.text, driver, numbered);
    numbered += params.filter((p) => p.positional).length;
    return params;
  });
  const names = [...new Set(found.flat().map((p) => p.name))];
  if (!names.length) return statements;
  const values = await new Promise<Record<string, string> | null>((resolve) =>
    useDatabase.setState({ dialog: { kind: "params", names, resolve } }),
  );
  if (!values) return [];
  useDatabase.setState((s) => ({ paramValues: { ...s.paramValues, ...values } }));
  return statements.map((st, i) => ({ ...st, text: bindParams(st.text, found[i]!, values) }));
}

export async function executeConsole(
  path: string,
  text: string,
  from: number,
  to: number,
  /** Called once the statements are submitted, with what was submitted. */
  onStart?: (statements: readonly SqlStatement[]) => void,
  onProgress?: (events: readonly StatementProgress[]) => ReadonlyMap<number, DbStatementOutcome> | void,
): Promise<DbStatementOutcome[]> {
  const id = consoleSource(path);
  if (!id) {
    notifications().notify({
      level: "info",
      title: useDatabase.getState().sources.length ? "Choose a data source for this console" : "No data sources",
      body: useDatabase.getState().sources.length
        ? "Pick one in the toolbar above the editor."
        : "Add one in the Database tool window.",
      key: "db-execute",
    });
    return [];
  }
  const current = databaseRequest(id);
  const request = nextRequestId();
  const ownsRun = () => current() && useDatabase.getState().running[path] === request;
  preparingConsoles.set(path, request);
  const resultIds = new Set<number>();
  let finished = false;
  let selectOutput = false;
  let schemaChanged = false;
  let statementCancelled = false;
  let deliveryIncomplete = false;
  try {
    const statements = await consoleStatements(id, text, from, to);
    if (!current() || preparingConsoles.get(path) !== request || !statements.length) return [];
    preparingConsoles.delete(path);
    const prev = useDatabase.getState().running[path];
    if (prev) cancelExecution(prev);
    const execution = { startedAt: Date.now(), statements: statements.length, active: null };
    useDatabase.setState((s) => ({
      running: { ...s.running, [path]: request },
      executions: { ...s.executions, [path]: execution },
    }));
    onStart?.(statements);
    const inline = inEditorResults();
    if (!inline) showServiceView(RESULTS_VIEW, false);
    const pageSize = useDatabase.getState().maxRows;
    const schema = consoleSchema(path) || (await loadCompletion(id))?.defaultSchema || "";
    if (!ownsRun()) return [];
    let logConnected = !useDatabase.getState().connected.has(id);
    let runNumber: number | undefined;
    let queued: StatementProgress[] = [];
    let frame: number | undefined;
    const publish = () => {
      frame = undefined;
      const events = queued;
      queued = [];
      if (!ownsRun() || !events.length) return;
      const last = events[events.length - 1]!;
      const active = last.type === "started" ? { index: last.index, startedAt: Date.now() } : null;
      const placed = onProgress?.(events);
      const completed: DbStatementOutcome[] = [];
      const tabs: ResultTab[] = [];
      for (const event of events) {
        if (event.type === "started") continue;
        completed.push(event.outcome);
        if (!event.outcome.result?.columns.length) continue;
        runNumber ??= nextRun++;
        const index = resultIds.size + 1;
        const title = index === 1 ? tx`Result ${runNumber}` : tx`Result ${runNumber}-${index}`;
        const outcome = (inline ? placed?.get(event.index) : undefined) ?? event.outcome;
        const tab = { id: nextTab++, title, path, sourceId: id, schema, outcome, page: 0, pageSize };
        resultIds.add(tab.id);
        if (!inline) streamingResultTabs.add(tab.id);
        tabs.push(tab);
      }
      schemaChanged ||= completed.some(changesSchema);
      useDatabase.setState((s) => {
        const executions = { ...s.executions, [path]: { ...execution, active } };
        const state = completed.length
          ? { executions, ...outcomeUpdates(s, id, schema, completed, logConnected) }
          : { executions };
        const latest = tabs.at(-1);
        if (!latest) return state;
        if (inline) return { ...state, inline: [...s.inline, ...tabs.map((tab) => ({ ...tab, inline: true }))] };
        return { ...state, results: capResults([...s.results, ...tabs], resultIds), activeResult: latest.id };
      });
      if (completed.length) logConnected = false;
    };
    const emit = (event: StatementProgress) => {
      if (!ownsRun()) return;
      queued.push(event);
      if (statements.length === 1) publish();
      else frame ??= requestAnimationFrame(publish);
    };
    let outcomes: DbStatementOutcome[];
    try {
      outcomes = await run(id, statements, request, pageSize, 0, schema, {
        emit,
        current: ownsRun,
        onStatementCancelled: () => {
          statementCancelled = true;
        },
        onIncompleteDelivery: () => {
          deliveryIncomplete = true;
        },
      });
    } finally {
      if (frame !== undefined) cancelAnimationFrame(frame);
      publish();
    }
    if (!ownsRun()) return [];
    if (deliveryIncomplete) {
      const summary = tx("SQL result delivery was incomplete. The final execution status is unknown.");
      log("info", summary);
      notifications().notify({ level: "warning", title: summary, key: "db-execute" });
      if (useDatabase.getState().manualCommit.has(id)) setPending(id, true);
    }
    finished = !deliveryIncomplete;
    selectOutput = !inline && (!resultIds.size || outcomes.some((o) => o.error));
    return outcomes;
  } catch (e) {
    if (!current() || (!ownsRun() && preparingConsoles.get(path) !== request)) return [];
    if (!isCancelled(e)) {
      log("error", message(e));
      notifications().notify({ level: "error", title: "Cannot execute", body: message(e), key: "db-execute" });
    } else {
      log("info", "Cancelled");
      // Interrupting a running statement discards its held transaction. Between statements it stays open.
      if (statementCancelled && useDatabase.getState().pendingTx.has(id)) {
        log("info", "Transaction rolled back");
        setPending(id, false);
      }
    }
    return [];
  } finally {
    if (preparingConsoles.get(path) === request) preparingConsoles.delete(path);
    const refreshMetadata = schemaChanged && ownsRun();
    for (const id of resultIds) streamingResultTabs.delete(id);
    useDatabase.setState((s) => {
      if (s.running[path] !== request) return s;
      const running = { ...s.running };
      delete running[path];
      const executions = { ...s.executions };
      delete executions[path];
      const tabs = s.results.filter((tab) => resultIds.has(tab.id));
      let results = s.results;
      if (tabs.length) {
        results = finished
          ? replaceResults(
              s.results.filter((tab) => !resultIds.has(tab.id)),
              path,
              tabs,
              resultIds,
            )
          : capResults(s.results, resultIds);
      }
      return { running, executions, results, activeResult: selectOutput ? OUTPUT_TAB : s.activeResult };
    });
    if (refreshMetadata) void refresh(id);
  }
}

/**
 * IDEA reuses result tabs: a console's new result sets take the place of its
 * unpinned ones (where the first of them was), others stay. Nothing is
 * replaced when the run returned no result set (an UPDATE keeps the SELECT).
 */
function replaceResults(
  results: ResultTab[],
  path: string,
  tabs: ResultTab[],
  fresh: ReadonlySet<number>,
): ResultTab[] {
  if (!tabs.length) return results;
  const replaced = (r: ResultTab) => r.path === path && !r.plan && !r.pinned;
  const at = results.findIndex(replaced);
  const kept = results.filter((r) => !replaced(r));
  const index = at < 0 ? kept.length : at;
  return capResults([...kept.slice(0, index), ...tabs, ...kept.slice(index)], fresh);
}

/** Drops older tabs beyond `MAX_TABS`, keeping pinned and newly arrived grids. */
function capResults(results: ResultTab[], fresh: ReadonlySet<number>): ResultTab[] {
  let extra = results.length - MAX_TABS;
  if (extra <= 0) return results;
  return results.filter((r) => r.pinned || fresh.has(r.id) || streamingResultTabs.has(r.id) || extra-- <= 0);
}

/** The statements of console `path` to run or explain: the selection's, else the one at `from`, parameters bound. */
async function consoleStatements(id: string, text: string, from: number, to: number): Promise<SqlStatement[]> {
  const statements: SqlStatement[] = await call(commands.dbStatements(id, text, from, to));
  if (!statements.length) return [];
  return withParams(statements, sourceById(id)?.driver ?? "sqlite");
}

const PLAN_TITLE = "Query Plan";

/** Shows `plan` of `statement` in the window's Query Plan tab (one per window, like IDEA's). */
function showPlan(path: string, id: string, statement: SqlStatement, plan: DbPlanNode[]) {
  useDatabase.setState((s) => {
    const old = s.results.find((r) => r.plan && !r.pinned);
    const tab: ResultTab = {
      id: old?.id ?? nextTab++,
      title: old?.title ?? PLAN_TITLE,
      path,
      sourceId: id,
      outcome: { statement, result: null, error: null },
      plan,
    };
    const results = old
      ? s.results.map((r) => (r === old ? tab : r))
      : capResults([...s.results, tab], new Set([tab.id]));
    return { results, activeResult: tab.id };
  });
  showServiceView(RESULTS_VIEW, false);
}

async function explain(id: string, statement: SqlStatement, schema?: string): Promise<DbPlanNode[]> {
  const plan = await withConnection(id, () =>
    call(commands.dbExplain(nextRequestId(), id, statement.text, schema || null)),
  );
  log("statement", `explain ${statement.text}`, `${schema || promptOf(id)}>`);
  log("result", `${plan.length} plan node${plan.length === 1 ? "" : "s"}`);
  return plan;
}

/** Explain Plan: the plan of the statement at `from` (the first selected one) of console `path`. */
export async function explainConsole(path: string, text: string, from: number, to: number): Promise<void> {
  const id = consoleSource(path);
  if (!id || sourceById(id)?.driver === "jdbc") return;
  try {
    const [statement] = await consoleStatements(id, text, from, to);
    if (!statement) return;
    showPlan(
      path,
      id,
      statement,
      await explain(id, statement, useDatabase.getState().consoleSchemas[path] || undefined),
    );
  } catch (e) {
    if (isCancelled(e)) return;
    log("error", `[${targetLabel(id)}] ${message(e)}`);
    notifications().notify({
      level: "error",
      title: "Cannot explain the statement",
      body: message(e),
      key: "db-explain",
    });
  }
}

/** Browse Query History of the data source of console `path` (or of target `id`). */
export function openHistory(path: string | null, id: string | null = path ? consoleSource(path) : null) {
  if (!id) {
    notifications().notify({ level: "info", title: "Choose a data source for this console", key: "db-history" });
    return;
  }
  openDialog({ kind: "history", id, path });
}

/** Go to DDL of a routine, trigger or sequence: its definition in a SQL file next to the console. */
export async function openObjectDdl(id: string, schema: string, kind: DbObjectKind, name: string): Promise<void> {
  try {
    const [text, console] = await Promise.all([
      withConnection(id, () => call(commands.dbObjectDdl(id, schema, kind, name))),
      call(commands.dbConsolePath(id)),
    ]);
    const safe = (s: string) => s.replace(/[^\w.-]+/g, "_");
    const path = console.replace(/[^\\/]*$/, `${safe(schema)}.${safe(name)}.sql`);
    await call(commands.dbExportFile(path, text));
    bindConsole(path, id);
    await editorService().openFile(path, { focus: true });
  } catch (e) {
    notifications().notify({ level: "error", title: `Cannot get the definition of ${name}`, body: message(e) });
  }
}

/** Re-runs the statement of result tab `tabId`, replacing its rows (a plan tab explains it again). */
export async function rerunResult(tabId: number): Promise<void> {
  const tab = findResult(tabId);
  if (!tab || tab.busy) return;
  if (tab.plan) {
    patchResult(tabId, { busy: true });
    try {
      patchResult(tabId, {
        plan: await explain(tab.sourceId, tab.outcome.statement, tab.schema ?? consoleSchema(tab.path)),
        busy: false,
      });
    } catch (e) {
      patchResult(tabId, { busy: false });
      if (!isCancelled(e)) log("error", `[${targetLabel(tab.sourceId)}] ${message(e)}`);
    }
    return;
  }
  await loadResultPage(tabId, tab.page ?? 0, tab.pageSize ?? useDatabase.getState().maxRows, true);
}

/** Whether result tab `tab` can show other pages: running its query again only reads. */
export function pageable(tab: ResultTab): boolean {
  return !tab.plan && isReadOnlyQuery(tab.outcome.statement.text, sourceById(tab.sourceId)?.driver ?? "sqlite");
}

/** Result tab `tabId`, in the Services view or in an editor. */
export function findResult(tabId: number): ResultTab | undefined {
  const st = useDatabase.getState();
  return st.results.find((r) => r.id === tabId) ?? st.inline.find((r) => r.id === tabId);
}

function patchResult(tabId: number, p: Partial<ResultTab>) {
  const patch = (list: ResultTab[]) =>
    list.some((r) => r.id === tabId) ? list.map((r) => (r.id === tabId ? { ...r, ...p } : r)) : list;
  useDatabase.setState((s) => ({ results: patch(s.results), inline: patch(s.inline) }));
}

/**
 * Shows page `page` of `pageSize` rows of result tab `tabId`: its query runs
 * again and the backend returns only that page (IDEA's result paging).
 * `rerun` also forgets the counted total.
 */
export async function loadResultPage(tabId: number, page: number, pageSize: number, rerun = false): Promise<void> {
  const tab = findResult(tabId);
  if (!tab || tab.busy || tab.plan) return;
  if (page > 0 && !pageable(tab)) return;
  patchResult(tabId, { busy: true });
  const { maxRows, skip } = pageFetch(page, pageSize);
  try {
    const [outcome] = await run(
      tab.sourceId,
      [tab.outcome.statement],
      nextRequestId(),
      maxRows,
      skip,
      tab.schema ?? consoleSchema(tab.path),
    );
    const r = outcome?.result;
    if (r) {
      const sizeChanged = pageSize !== tab.pageSize;
      patchResult(tabId, {
        outcome,
        page,
        pageSize,
        busy: false,
        ...(rerun || sizeChanged ? { total: null } : {}),
      });
    } else patchResult(tabId, { busy: false });
    // A run of its console may have replaced the tab meanwhile.
    if (outcome?.error && useDatabase.getState().results.some((r) => r.id === tabId))
      useDatabase.setState({ activeResult: OUTPUT_TAB });
  } catch (e) {
    patchResult(tabId, { busy: false });
    if (!isCancelled(e)) log("error", message(e));
  }
}

/** `SELECT COUNT(*)` over a query, for queries that can be a subquery. */
function countQuery(text: string): string | null {
  if (!/^\s*(\(|select\b|with\b|values\b|table\b)/i.test(text)) return null;
  // `)` on its own line: a trailing line comment (`… from t -- note`) would swallow it.
  return `select count(*) from (\n${text.trim()}\n) q`;
}

/** Whether the rows of result tab `tab` can be counted. */
export function countable(tab: ResultTab): boolean {
  return pageable(tab) && countQuery(tab.outcome.statement.text) !== null;
}

/** Counts the rows of result tab `tabId`'s whole query (the pager's "of 501+"). */
export async function countResult(tabId: number): Promise<number | null> {
  const tab = findResult(tabId);
  if (!tab || tab.busy || !countable(tab)) return null;
  const text = countQuery(tab.outcome.statement.text)!;
  patchResult(tabId, { busy: true });
  try {
    const [outcome] = await run(
      tab.sourceId,
      [{ from: 0, to: text.length, text }],
      nextRequestId(),
      1,
      0,
      tab.schema ?? consoleSchema(tab.path),
    );
    const total = Number(outcome?.result?.rows[0]?.[0]);
    const known = outcome?.error || !Number.isFinite(total) ? null : total;
    patchResult(tabId, { busy: false, ...(known === null ? {} : { total: known }) });
    return known;
  } catch (e) {
    patchResult(tabId, { busy: false });
    if (!isCancelled(e)) log("error", message(e));
    return null;
  }
}

/** Statements that only read (they leave a manual transaction clean). */
const READS = /^\s*(select|show|pragma|explain|describe|desc|values|table)\b/i;

function setPending(id: string, pending: boolean) {
  useDatabase.setState((s) => {
    const pendingTx = new Set(s.pendingTx);
    if (pending) pendingTx.add(id);
    else pendingTx.delete(id);
    return { pendingTx };
  });
}

/** Commits or rolls back the open transaction of a manual-commit data source. */
export async function finishTransaction(id: string, commit: boolean): Promise<boolean> {
  if (sourceById(id)?.driver === "clickhouse" || sourceById(id)?.driver === "jdbc") return false;
  try {
    await call(commands.dbFinishTransaction(id, commit));
    log("statement", commit ? "commit" : "rollback", `${promptOf(id)}>`);
    log("result", commit ? "Transaction committed" : "Transaction rolled back");
    setPending(id, false);
    return true;
  } catch (e) {
    log("error", `[${targetLabel(id)}] ${message(e)}`);
    notifications().notify({ level: "error", title: commit ? "Cannot commit" : "Cannot roll back", body: message(e) });
    return false;
  }
}

/** Leaving manual commit with changes pending (IDEA asks the same); null when cancelled. */
async function askEndTransaction(source: DataSource): Promise<boolean | null> {
  const { button } = await ask({
    title: "Switch to Auto-Commit",
    body: tx`${source.name} has uncommitted changes. Commit or roll them back before switching to auto-commit?`,
    buttons: [
      { id: "rollback", label: "Roll Back" },
      { id: "commit", label: "Commit", primary: true },
    ],
  });
  return button === "cancel" ? null : button === "commit";
}

/**
 * IDEA's Tx: Auto / Manual. Leaving manual mode with changes pending asks
 * whether to commit or roll them back.
 */
export async function setManualCommit(id: string, manual: boolean): Promise<void> {
  if (sourceById(id)?.driver === "jdbc" || (sourceById(id)?.driver === "clickhouse" && manual)) return;
  const st = useDatabase.getState();
  if (manual === st.manualCommit.has(id)) return;
  if (!manual && st.pendingTx.has(id)) {
    const source = sourceById(id);
    const commit = source ? await askEndTransaction(source) : false;
    if (commit === null || !(await finishTransaction(id, commit))) return;
  }
  await call(commands.dbSetManualCommit(id, manual));
  useDatabase.setState((s) => {
    const manualCommit = new Set(s.manualCommit);
    if (manual) manualCommit.add(id);
    else manualCommit.delete(id);
    return { manualCommit };
  });
  setPending(id, false);
}

export function cancelConsole(path: string) {
  const r = useDatabase.getState().running[path];
  if (r) cancelExecution(r);
}

function cancelExecution(request: RequestId) {
  stopResultDelivery.get(request)?.();
  void commands.cancelRequest(request);
}

export function closeResult(id: number) {
  useDatabase.setState((s) => {
    const index = s.results.findIndex((r) => r.id === id);
    if (index < 0) return s;
    const results = s.results.filter((r) => r.id !== id);
    return {
      results,
      activeResult: s.activeResult === id ? ((results[index - 1] ?? results[index])?.id ?? OUTPUT_TAB) : s.activeResult,
    };
  });
}

/** Closes in-editor results `ids`. */
export function closeInlineResults(ids: readonly number[]) {
  if (!ids.length) return;
  useDatabase.setState((s) => ({ inline: s.inline.filter((r) => !ids.includes(r.id)) }));
}

export function pinResult(id: number, pinned: boolean) {
  patchResult(id, { pinned });
}
