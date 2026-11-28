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
  emitLocalIdeEvent,
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
  type DbSourceFolder,
  type DbQueryResult,
  type DbStatementOutcome,
  type DbTableDetails,
  type DbTableInfo,
  type DbTableKind,
  type DbVisibilityChange,
  type DbTableGrant,
  type RequestId,
  type SqlStatement,
} from "@/platform/ipc";
import { activeEditor, editorsFor } from "@/editor/api";
import {
  editorService,
  maybeEditorService,
  notifications,
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
  schemaNodeKey,
  treeIdentifier,
  effectiveSsh,
  idleTargets,
  newSourceId,
  sourceIcon,
  supportsExplain,
  splitTarget,
  targetOf,
} from "./model";
import { nodeTarget, tableFolder, type DbNode } from "./nodes";
import { SQL_LANGUAGE } from "./sqlLanguage";
import { TABLE_KIND, type TableRef } from "./tableInput";
import type { DiagramData } from "./erDiagram";
import type { ExportData, ExportFormat } from "./export";
import type { DbObjectRef } from "./objects";
import type { SqlCatalog } from "./sql/complete";
import { nameMatcher, sqlDriverOf } from "./sql/dialect";
import { formatted } from "./sql/format";
import { lex } from "./sql/lexer";
import { bindParams, findParams, unbindRange } from "./sql/params";
import { unsafeStatement, type UnsafeStatement } from "./sql/unsafe";
import { isReadOnlyQuery } from "./sql/readOnly";
import { pageFetch } from "./resultView";
import type { TableSnapshot } from "./schemaCompare";
import { resolutionScopeOf, resolutionScopesOf, type SqlResolutionScope } from "./resolutionScopes";
import { databaseRequest, invalidateDatabaseRequests, projectRequest } from "./requests";
import { tx } from "@/platform/i18n";
import { revealDatabaseResults } from "./outputDestination";
export { RESULTS_VIEW } from "./outputDestination";

export const DB_TOOL_WINDOW = "database";
const BINDINGS_KEY = "openidea.database.consoles";
const CONSOLE_SCHEMAS_KEY = "openidea.database.consoleSchemas";
const VIEW_OPTIONS_KEY = "openidea.database.viewOptions";
const MAX_TABS = 12;
const RESULT_DELIVERY_TIMEOUT_MS = 15_000;
/**
 * The longest cell text (UTF-16 units) a page of a result carries. A cut cell shows a marker
 * and its whole value is read when it is expanded, copied, exported or edited.
 */
export const CELL_LIMIT = 8192;

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
  /** SQL console or file that emitted the line. */
  path?: string;
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
  /** New or rename a user data source folder; `sources` joins them when creating. */
  | { kind: "sourceFolder"; folder: DbSourceFolder | null; sources?: string[] }
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
  | { kind: "mysqlRestore"; target: string; database: string }
  /** Diagrams › Show Diagram Popup. */
  | { kind: "diagram"; data: DiagramData };

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
  folders: DbSourceFolder[];
  loaded: boolean;
  foldersLoaded: boolean;
  /** Connected targets (see `splitTarget`). */
  connected: Set<string>;
  /** Targets or whole sources deactivated until the next deliberate database operation. */
  pausedConsoleMetadata: ReadonlySet<string>;
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
  showTableComments: boolean;
  completion: Record<string, DbCompletion>;
  results: ResultTab[];
  /** Results shown in the editor under their statements (In-Editor Results), oldest first. */
  inline: ResultTab[];
  /** Result tab id, or `OUTPUT_TAB`. */
  activeResult: number | null;
  activeClientResults: Record<string, number>;
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
  /** Every selected node of the tree, the lead's included (Show Diagram). */
  selectedNodes: DbNode[];
  /** The toolbar's New popup is open. */
  newMenuOpen: boolean;
  workspaceSettingsRequest: string | null;
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
  consoleModes: Map<string, boolean>;
  consolePendingTx: Set<string>;
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

function consoleTargetFromPath(path: string, sources: readonly DataSource[]): string | null {
  const folder = /(?:^|[\\/])consoles[\\/]db[\\/]([^\\/]+)[\\/]console(?:_\d+)?\.sql$/i.exec(path)?.[1];
  if (!folder) return null;
  const source = sources.find((candidate) => {
    const id = candidate.id ?? "";
    return !!id && (folder === id || folder.startsWith(`${id}.`));
  });
  if (!source?.id) return null;
  const database = folder === source.id ? null : folder.slice(source.id.length + 1);
  return database ? `${source.id}:${database}` : source.id;
}

function readViewOptions(): Pick<DatabaseState, "separateProceduresAndFunctions" | "showTableComments"> {
  try {
    const raw = localStorage.getItem(VIEW_OPTIONS_KEY);
    const value = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    return {
      separateProceduresAndFunctions: value.separateProceduresAndFunctions === true,
      showTableComments: value.showTableComments !== false,
    };
  } catch {
    return { separateProceduresAndFunctions: false, showTableComments: true };
  }
}

const initialViewOptions = readViewOptions();

export const useDatabase = create<DatabaseState>(() => ({
  sources: [],
  folders: [],
  loaded: false,
  foldersLoaded: false,
  connected: new Set(),
  pausedConsoleMetadata: new Set(),
  databases: {},
  catalogs: {},
  schemas: {},
  tables: {},
  details: {},
  objects: {},
  consoles: readBindings(),
  consoleSchemas: readConsoleSchemas(),
  ...initialViewOptions,
  completion: {},
  results: [],
  inline: [],
  activeResult: null,
  activeClientResults: {},
  output: [],
  running: {},
  executions: {},
  maxRows: 500,
  dialog: null,
  selectedSource: null,
  selectedNode: null,
  selectedNodes: [],
  newMenuOpen: false,
  workspaceSettingsRequest: null,
  treeExpanded: new Set(),
  treeReveal: null,
  paramValues: {},
  manualCommit: new Set(),
  pendingTx: new Set(),
  consoleModes: new Map(),
  consolePendingTx: new Set(),
}));

/**
 * A result's later pages continue a cursor the backend keeps open on the server; it closes when
 * no result tab shows the statement any more (the backend also closes idle ones).
 */
const resultKey = (tab: ResultTab) =>
  JSON.stringify([
    tab.sourceId,
    tab.outcome.statement.text,
    tab.schema ?? consoleSchema(tab.path),
    sourceById(tab.sourceId)?.driver === "postgres" ? tab.path : null,
  ]);
useDatabase.subscribe((state, previous) => {
  if (state.results === previous.results && state.inline === previous.inline) return;
  const shown = [...state.results, ...state.inline];
  const keys = new Set(shown.map(resultKey));
  for (const tab of [...previous.results, ...previous.inline]) {
    if (tab.plan || keys.has(resultKey(tab))) continue;
    const schema = tab.schema ?? consoleSchema(tab.path);
    const console = sourceById(tab.sourceId)?.driver === "postgres" ? tab.path : null;
    void call(commands.dbReleaseResult(tab.sourceId, tab.outcome.statement.text, schema || null, console)).catch(
      () => {},
    );
  }
});

export function toggleSeparateProceduresAndFunctions() {
  const separateProceduresAndFunctions = !useDatabase.getState().separateProceduresAndFunctions;
  useDatabase.setState({ separateProceduresAndFunctions });
  saveViewOptions();
}

export function toggleShowTableComments() {
  const showTableComments = !useDatabase.getState().showTableComments;
  useDatabase.setState({ showTableComments });
  saveViewOptions();
}

function saveViewOptions() {
  const { separateProceduresAndFunctions, showTableComments } = useDatabase.getState();
  try {
    localStorage.setItem(VIEW_OPTIONS_KEY, JSON.stringify({ separateProceduresAndFunctions, showTableComments }));
  } catch {
    // Per-viewer convenience only.
  }
}

const catalogKey = (key: string, catalog?: string) => (catalog === undefined ? key : `${key}\u0000${catalog}`);
export const schemasKey = catalogKey;
export const tablesKey = (id: string, schema: string, catalog?: string) => catalogKey(`${id}\u0000${schema}`, catalog);
export const detailsKey = (id: string, schema: string, table: string, catalog?: string) =>
  catalogKey(`${id}\u0000${schema}\u0000${table}`, catalog);

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

export function allowsPassiveConsoleMetadata(
  id: string,
  paused = useDatabase.getState().pausedConsoleMetadata,
): boolean {
  return !paused.has(id) && !paused.has(splitTarget(id).id);
}

function pauseConsoleMetadata(id: string, pause: boolean) {
  useDatabase.setState((s) => {
    if (s.pausedConsoleMetadata.has(id) === pause) return s;
    const pausedConsoleMetadata = new Set(s.pausedConsoleMetadata);
    if (pause) pausedConsoleMetadata.add(id);
    else pausedConsoleMetadata.delete(id);
    return { pausedConsoleMetadata };
  });
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

export async function loadSourceFolders(): Promise<void> {
  if (!useProject.getState().project) return;
  const current = projectRequest();
  try {
    const folders = await call(commands.dbSourceFolders());
    if (current()) useDatabase.setState({ folders, foldersLoaded: true });
  } catch (e) {
    if (!current()) return;
    useDatabase.setState({ folders: [], foldersLoaded: true });
    if (!message(e).includes("is not available remotely")) {
      notifications().notify({
        level: "error",
        title: "Cannot read data source folders",
        body: message(e),
        key: "db-folders",
      });
    }
  }
}

async function saveSourceFolders(folders: DbSourceFolder[], failure: string): Promise<boolean> {
  const current = projectRequest();
  try {
    await call(commands.dbSaveSourceFolders(folders));
    if (!current()) return false;
    useDatabase.setState({ folders });
    return true;
  } catch (e) {
    if (current())
      notifications().notify({
        level: "error",
        title: failure,
        body: message(e),
        key: "db-folders",
      });
    return false;
  }
}

function withoutSources(folders: DbSourceFolder[], sourceIds: ReadonlySet<string>): DbSourceFolder[] {
  return folders.map((folder) => ({
    ...folder,
    sources: folder.sources.filter((source) => !sourceIds.has(source)),
  }));
}

export async function createSourceFolder(name: string, sourceIds: readonly string[] = []): Promise<string | null> {
  const clean = name.trim();
  if (!clean) return null;
  const folders = useDatabase.getState().folders;
  const names = new Set(folders.map((folder) => folder.name.toLocaleLowerCase()));
  let unique = clean;
  for (let n = 2; names.has(unique.toLocaleLowerCase()); n++) unique = `${clean} (${n})`;
  const id = `folder-${newSourceId()}`;
  const members = [...new Set(sourceIds)].filter((source) =>
    useDatabase.getState().sources.some((entry) => entry.id === source),
  );
  const next = withoutSources(folders, new Set(members));
  next.push({
    id,
    name: unique,
    order: folders.reduce((max, folder) => Math.max(max, folder.order), -1) + 1,
    sources: members,
  });
  if (!(await saveSourceFolders(next, "Cannot create the data source folder"))) return null;
  expandSourceFolder(id);
  return id;
}

export async function renameSourceFolder(id: string, name: string): Promise<boolean> {
  const clean = name.trim();
  if (!clean) return false;
  const folders = useDatabase.getState().folders;
  if (!folders.some((folder) => folder.id === id)) return false;
  const names = new Set(folders.filter((folder) => folder.id !== id).map((folder) => folder.name.toLocaleLowerCase()));
  let unique = clean;
  for (let n = 2; names.has(unique.toLocaleLowerCase()); n++) unique = `${clean} (${n})`;
  return saveSourceFolders(
    folders.map((folder) => (folder.id === id ? { ...folder, name: unique } : folder)),
    "Cannot rename the data source folder",
  );
}

export async function deleteSourceFolder(id: string): Promise<boolean> {
  const folders = useDatabase.getState().folders;
  if (!folders.some((folder) => folder.id === id)) return false;
  return saveSourceFolders(
    folders.filter((folder) => folder.id !== id),
    "Cannot delete the data source folder",
  );
}

export async function removeSourceFolder(folder: DbSourceFolder): Promise<void> {
  const ok = await confirm({
    title: "Delete Data Source Folder",
    message: tx`Delete folder '${folder.name}'? Its data sources move back to the root.`,
    ok: "Delete",
    icon: "warning",
  });
  if (!ok) return;
  await deleteSourceFolder(folder.id);
}

export async function moveSourcesToFolder(sourceIds: readonly string[], folderId: string | null): Promise<boolean> {
  const ids = new Set(sourceIds);
  const folders = withoutSources(useDatabase.getState().folders, ids);
  if (folderId) {
    const folder = folders.find((candidate) => candidate.id === folderId);
    if (!folder) return false;
    const valid = [...ids].filter((source) =>
      useDatabase.getState().sources.some((candidate) => candidate.id === source),
    );
    folder.sources = [...folder.sources, ...valid];
  }
  const saved = await saveSourceFolders(folders, "Cannot move the data sources");
  if (saved && folderId) expandSourceFolder(folderId);
  return saved;
}

function expandSourceFolder(id: string) {
  useDatabase.setState((state) => ({
    treeExpanded: new Set(state.treeExpanded).add(`source-folder:${id}`),
  }));
}

/** Drops cached metadata of target `id` (refresh, disconnect); a data source id drops all its databases. */
function forget(id: string) {
  invalidateDatabaseRequests(id);
  duckdbCatalogLoads.delete(id);
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

/** Removes data sources after one confirmation (Database tree › Drop on a source). */
export async function removeSources(sources: readonly DataSource[]): Promise<void> {
  const unique = [...new Map(sources.flatMap((source) => (source.id ? [[source.id, source] as const] : []))).values()];
  if (!unique.length) return;
  const one = unique.length === 1;
  const count = unique.length;
  const names = unique
    .slice(0, 8)
    .map((source) => source.name)
    .join("\n");
  const n = count - 8;
  const more = n > 0 ? `\n${tx`and ${n} more`}` : "";
  const ok = await confirm({
    title: one ? "Remove Data Source" : "Remove Data Sources",
    message: one
      ? tx`Remove data source '${unique[0]!.name}'? Its query console file stays on disk.`
      : tx`Remove ${count} data sources? Their query console files stay on disk.\n\n${names}${more}`,
    ok: "Remove",
  });
  if (!ok) return;
  const ids = new Set(unique.map((source) => source.id!));
  const current = projectRequest();
  const mutations = unique.map((source) => sourceMutation(source.id!));
  try {
    await Promise.all([...ids].filter((id) => connectedTargets(id).length).map((id) => disconnect(id)));
    await call(commands.dbSaveSources(useDatabase.getState().sources.filter((source) => !ids.has(source.id ?? ""))));
    if (!current() || mutations.some((unchanged) => !unchanged())) return;
    for (const id of ids) forget(id);
    await loadSources();
    if (!current()) return;
    useDatabase.setState((s) => {
      const removed = (node: DbNode) => {
        const target = nodeTarget(node);
        return !!target && ids.has(splitTarget(target).id);
      };
      const selectedNodes = s.selectedNodes.filter((node) => !removed(node));
      const selectedNode = s.selectedNode && !removed(s.selectedNode) ? s.selectedNode : null;
      return {
        selectedNode,
        selectedSource: selectedNode ? nodeTarget(selectedNode) : null,
        selectedNodes,
      };
    });
  } catch (e) {
    notifications().notify({
      level: "error",
      title: one ? "Cannot remove the data source" : "Cannot remove the data sources",
      body: message(e),
    });
  }
}

/** Removes one data source after asking. */
export async function removeSource(source: DataSource): Promise<void> {
  await removeSources([source]);
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
      // oxlint-disable-next-line no-await-in-loop -- the retry loop must finish op before updating connection state or deciding to retry
      const r = await op();
      // A completed write keeps its result, but must not revive an old connection.
      if (!current()) return r;
      connectionIntents.set(id, {});
      lastUsed.set(id, Date.now());
      const state = useDatabase.getState();
      const fresh = !state.connected.has(id);
      if (fresh || !allowsPassiveConsoleMetadata(id, state.pausedConsoleMetadata)) {
        const pausedConsoleMetadata = new Set(state.pausedConsoleMetadata);
        pausedConsoleMetadata.delete(id);
        pausedConsoleMetadata.delete(splitTarget(id).id);
        useDatabase.setState({
          connected: fresh ? new Set(state.connected).add(id) : state.connected,
          pausedConsoleMetadata,
        });
        if (fresh) applyConnectDefaults(id);
      }
      return r;
    } catch (e) {
      if (!current()) throw new IpcError({ kind: "cancelled", message: "Cancelled", data: null });
      const source = sourceById(id);
      // oxlint-disable-next-line no-await-in-loop -- credential/host-key prompts must resolve before deciding whether to retry the connection
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
  const intent = {};
  for (const target of targets) connectionIntents.set(target, intent);
  if (!splitTarget(id).database) sourceConnectionIntents.set(id, {});
  const alreadyPaused = useDatabase.getState().pausedConsoleMetadata.has(id);
  // Dropping the caches can wake up metadata effects in a still-mounted console.
  pauseConsoleMetadata(id, true);
  forget(id);
  useDatabase.setState((s) => ({ treeExpanded: collapseTarget(s.treeExpanded, id) }));
  try {
    if (!splitTarget(id).database && sourceById(id)?.externalTunnel) {
      await call(commands.dbDisconnect(id, true));
    } else {
      await Promise.all(targets.map((t) => call(commands.dbDisconnect(t, null))));
    }
  } catch (e) {
    if (current() && connectionIntents.get(id) === intent && !alreadyPaused) pauseConsoleMetadata(id, false);
    throw e;
  }
  if (!current()) return;
  if (!splitTarget(id).database) sourceConnectionIntents.set(id, {});
  useDatabase.setState((s) => {
    const connected = new Set(s.connected);
    for (const t of targets) {
      if (connectionIntents.get(t) !== intent) continue;
      connected.delete(t);
      connectionIntents.set(t, {});
    }
    const consoleModes = new Map(s.consoleModes);
    const consolePendingTx = new Set(s.consolePendingTx);
    for (const [key, scope] of consoleScopes) {
      if (connected.has(scope.id) || !targets.includes(scope.id)) continue;
      scope.retired = true;
      consoleScopes.delete(key);
      consoleModes.delete(key);
      consolePendingTx.delete(key);
    }
    return { connected, consoleModes, consolePendingTx };
  });
}

/** Disconnects targets idle past their data source's Auto-disconnect; returns the stopper. */
export function watchIdleConnections(everyMs = 5000): () => void {
  const timer = setInterval(() => {
    const s = useDatabase.getState();
    const running = new Set(Object.keys(s.running).map(consoleSource));
    const pending = new Set([...s.consolePendingTx].map((key) => consoleScopes.get(key)?.id));
    const busy = (t: string) => running.has(t) || pending.has(t) || s.pendingTx.has(t);
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
  const roots = new Set<string>();
  for (const [path, target] of Object.entries(s.consoles)) {
    const { id, database } = splitTarget(target);
    const source = s.sources.find((x) => x.id === id);
    if (!source) continue;
    const tint = colorVar(source.color);
    // db_console_path and db_consoles own this directory, including already saved consoles.
    const match = /[\\/]consoles[\\/]db[\\/][^\\/]+[\\/](console(?:_\d+)?)\.sql$/i.exec(path);
    if (match) {
      const folder = path.replace(/[\\/]console(?:_\d+)?\.sql$/i, "");
      const root = folder.replace(/[\\/][^\\/]+$/, "");
      const name = source.name || id;
      const label = database ? `${name}: ${database}` : name;
      const icon = sourceIcon(source);
      out.set(path, { tint, tabTitle: `${match[1]} [${label}]`, tabIcon: icon });
      out.set(folder, { label, icon });
      roots.add(root);
    } else if (tint) out.set(path, { tint });
  }
  for (const root of roots) {
    const separator = root.includes("\\") ? "\\" : "/";
    for (const source of s.sources) {
      if (!source.id) continue;
      out.set(`${root}${separator}${source.id}`, { label: source.name || source.id, icon: sourceIcon(source) });
    }
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

export function duckdbCatalogTree(source: DataSource | undefined): boolean {
  return source?.driver === "jdbc" && source.vendor === "duckdb";
}

export function listsTreeDatabases(source: DataSource | undefined): boolean {
  return listsDatabases(source) || duckdbCatalogTree(source);
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
  schemas: [id: string, catalog?: string][];
  tables: [id: string, schema: string, catalog?: string][];
  details: [id: string, schema: string, table: string, catalog?: string][];
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
    schemas: loaded(st.schemas).map((k) => k.split("\u0000") as LoadedLevels["schemas"][number]),
    tables: loaded(st.tables).map((k) => k.split("\u0000") as LoadedLevels["tables"][number]),
    details: loaded(st.details).map((k) => k.split("\u0000") as LoadedLevels["details"][number]),
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
    [...new Set([...schemas, ...tables, ...details].map(([target]) => target))].map((target) => [
      target,
      databaseRequest(target),
    ]),
  );
  const valid = (target: string) => targets.get(target)?.() ?? current();
  if (whole && listsTreeDatabases(sourceById(id))) await loadDatabases(id);
  else if (!schemas.some(([t, catalog]) => t === id && catalog === undefined)) schemas.push([id]);
  if (!current()) return;
  const listed = useDatabase.getState().databases[id];
  const present = (catalog?: string) =>
    catalog === undefined || (listed?.status === "ok" && listed.value.names.includes(catalog));
  await Promise.all(schemas.filter(([t, catalog]) => valid(t) && present(catalog)).map(([t, c]) => loadSchemas(t, c)));
  if (!current()) return;
  // Loading a DuckDB catalog already loaded its tables along with its schemas.
  await Promise.all(
    tables.filter(([t, , catalog]) => valid(t) && catalog === undefined).map(([t, schema]) => loadTables(t, schema)),
  );
  if (!current()) return;
  const exists = (t: string, schema: string, table: string, catalog?: string) => {
    const l = useDatabase.getState().tables[tablesKey(t, schema, catalog)];
    return l?.status === "ok" && l.value.some((x) => x.name === table);
  };
  await Promise.all(details.filter((d) => valid(d[0]) && exists(...d)).map((d) => loadDetails(...d)));
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

export async function loadSchemas(id: string, catalog?: string): Promise<void> {
  const key = schemasKey(id, catalog);
  const current = metadataRequest(id, "schemas", key);
  try {
    if (catalog !== undefined) {
      const catalogSchemas = await withConnection(id, () => call(commands.dbDatabaseCatalog(id, catalog)));
      if (!current()) return;
      useDatabase.setState((s) => {
        const tables = { ...s.tables };
        for (const schema of catalogSchemas)
          tables[tablesKey(id, schema.name, catalog)] = { status: "ok", value: schema.tables };
        return {
          schemas: { ...s.schemas, [key]: { status: "ok", value: catalogSchemas.map((schema) => schema.name) } },
          tables,
        };
      });
      return;
    }
    const value = await withConnection(id, () => call(commands.dbSchemas(id)));
    if (!current()) return;
    useDatabase.setState((s) => ({ schemas: { ...s.schemas, [id]: { status: "ok", value } } }));
  } catch (e) {
    if (!current()) return;
    useDatabase.setState((s) => ({ schemas: { ...s.schemas, [key]: { status: "error", message: message(e) } } }));
  }
}

export async function loadTables(id: string, schema: string, catalog?: string): Promise<void> {
  if (catalog !== undefined) return loadSchemas(id, catalog);
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
      // oxlint-disable-next-line no-await-in-loop -- bounded worker pool: each of up to 4 workers claims the next table via the shared index and checks the abort signal
      const details = await call(commands.dbTableDetails(id, schema, t.name));
      out.push({ name: t.name, kind: t.kind, ...details });
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, tables.length) }, worker));
  return out;
}

export async function loadDetails(id: string, schema: string, table: string, catalog?: string): Promise<void> {
  const key = detailsKey(id, schema, table, catalog);
  const current = metadataRequest(id, "details", key);
  try {
    const value = await withConnection(id, () =>
      call(
        catalog === undefined
          ? commands.dbTableDetails(id, schema, table)
          : commands.dbCatalogTableDetails(id, catalog, schema, table),
      ),
    );
    if (!current()) return;
    useDatabase.setState((s) => ({ details: { ...s.details, [key]: { status: "ok", value } } }));
  } catch (e) {
    if (!current()) return;
    useDatabase.setState((s) => ({ details: { ...s.details, [key]: { status: "error", message: message(e) } } }));
  }
}

/** The privileges granted on a table (PostgreSQL and MySQL; see `grantsSupported`). */
export function loadGrants(id: string, schema: string, table: string): Promise<DbTableGrant[]> {
  return withConnection(id, () => call(commands.dbTableGrants(id, schema, table)));
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
  catalog?: string,
): Promise<void> {
  const current = databaseRequest(id);
  const loaded = (l: Loaded<unknown> | undefined) => l?.status === "ok";
  const { id: sourceId, database } = splitTarget(id);
  const source = sourceById(id);
  const duck = duckdbCatalogTree(source) || catalog !== undefined;
  const eq = nameMatcher("duckdb");
  let databaseNode: string[] = [];
  if (listsTreeDatabases(source) || duck) {
    if (!loaded(useDatabase.getState().databases[sourceId])) {
      if (!(await connect(sourceId))) return;
      if (!current()) return;
      await loadDatabases(sourceId);
      if (!current()) return;
    }
    const dbs = useDatabase.getState().databases[sourceId];
    if (duck) {
      if (dbs?.status !== "ok") return selectInTree([], sourceId);
      catalog = catalog === undefined ? dbs.value.current : dbs.value.names.find((name) => eq(name, catalog));
      if (!catalog) return selectInTree([], sourceId);
    }
    const name = catalog ?? database ?? (dbs?.status === "ok" ? dbs.value.current : null);
    if (name) databaseNode = [databaseKey(sourceId, name, duck)];
  }
  const schemaKey = schemasKey(id, catalog);
  if (!loaded(useDatabase.getState().schemas[schemaKey])) {
    if (!(await connect(id))) return;
    if (!current()) return;
    await loadSchemas(id, catalog);
    if (!current()) return;
  }
  if (duck) {
    const schemas = useDatabase.getState().schemas[schemaKey];
    if (schemas?.status === "ok") schema = schemas.value.find((name) => eq(name, schema)) ?? schema;
  }
  const key = tablesKey(id, schema, catalog);
  if (!loaded(useDatabase.getState().tables[key])) await loadTables(id, schema, catalog);
  if (!current()) return;
  const tables = useDatabase.getState().tables[key];
  const match =
    tables?.status === "ok" ? tables.value.find((t) => (duck ? eq(t.name, table) : t.name === table)) : undefined;
  if (match) table = match.name;
  if (column && !loaded(useDatabase.getState().details[detailsKey(id, schema, table, catalog)]))
    await loadDetails(id, schema, table, catalog);
  if (!current()) return;
  kind ??= match?.kind ?? "table";
  const schemaNode = schemaNodeKey(id, schema, catalog);
  const folder = `${schemaNode}/${tableFolder(kind)}`;
  const tableKey = `${folder}/${treeIdentifier(table, catalog)}`;
  selectInTree(
    [sourceId, ...databaseNode, schemaNode, folder, ...(column ? [tableKey, `${tableKey}/columns`] : [])],
    column ? `${tableKey}/columns/${treeIdentifier(column, catalog)}` : tableKey,
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
    const { id, schema, table, catalog } = input.data as TableRef;
    return revealInTree(id, schema, table, undefined, undefined, catalog);
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
  const source = sourceById(sourceId);
  let catalog: string | undefined;
  if (listsTreeDatabases(source)) {
    const dbs = s.databases[sourceId];
    const name = database ?? (dbs?.status === "ok" ? dbs.value.current : null);
    if (dbs?.status !== "ok" || !name) return selectInTree(open, key);
    open.push(key);
    if (duckdbCatalogTree(source)) catalog = name;
    key = databaseKey(sourceId, name, catalog !== undefined);
    nodeTarget = catalog === undefined ? targetOf(sourceId, name, dbs.value.current) : sourceId;
  }
  const schema = consoleSchema(editor.ctx.path);
  const schemas = s.schemas[schemasKey(nodeTarget, catalog)];
  if (schema && schemas?.status === "ok" && schemas.value.includes(schema)) {
    open.push(key);
    key = schemaNodeKey(nodeTarget, schema, catalog);
  }
  selectInTree(open, key);
}

const completionLoads = new Map<string, { current: () => boolean; promise: Promise<DbCompletion | null> }>();
const duckdbCatalogLoads = new Map<
  string,
  { names: Promise<DbDatabases>; catalog?: { name: string; schemas: Promise<DbCatalogSchema[]> } }
>();
const preparingConsoles = new Map<string, RequestId>();
interface ConsoleScope {
  id: string;
  path: string;
  retired: boolean;
  modeRequest: Promise<unknown>;
}

const consoleScopes = new Map<string, ConsoleScope>();
const closingConsoles = new Map<string, Promise<unknown>>();
const pendingExplains = new Map<string, RequestId>();
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

/** DuckDB attachments belong to this JDBC session. The catalog name is never a connection target. */
export async function loadDuckdbCatalog(id: string, wanted?: string): Promise<SqlCatalog | undefined> {
  const sourceId = splitTarget(id).id;
  if (!allowsPassiveConsoleMetadata(sourceId)) return undefined;
  let live = duckdbCatalogLoads.get(sourceId);
  if (!live) {
    const names = call(commands.dbDatabases(sourceId)).catch((error) => {
      if (duckdbCatalogLoads.get(sourceId)?.names === names) duckdbCatalogLoads.delete(sourceId);
      throw error;
    });
    live = { names };
    duckdbCatalogLoads.set(sourceId, live);
  }
  const { names } = await live.names;
  if (duckdbCatalogLoads.get(sourceId) !== live) return undefined;
  const eq = nameMatcher("duckdb");
  const database = wanted === undefined ? undefined : names.find((name) => eq(name, wanted));
  let schemas: DbCatalogSchema[] = [];
  if (database !== undefined) {
    if (live.catalog?.name !== database) {
      const entry = live;
      const schemas = call(commands.dbDatabaseCatalog(sourceId, database)).catch((error) => {
        if (entry.catalog?.schemas === schemas) delete entry.catalog;
        throw error;
      });
      live.catalog = { name: database, schemas };
    }
    schemas = await live.catalog.schemas;
  }
  if (duckdbCatalogLoads.get(sourceId) !== live) return undefined;
  return {
    databases: names,
    schemas: (name) => (name === database ? schemas.map((schema) => schema.name) : null),
    tables: (name, schema) =>
      name === database
        ? (schemas
            .find((s) => eq(s.name, schema))
            ?.tables.map((table) => ({
              name: table.name,
              view: table.kind !== "table",
            })) ?? null)
        : null,
  };
}

useProject.subscribe((state, previous) => {
  if (state.project?.root === previous.project?.root) return;
  sourcesRequest++;
  connectionIntents.clear();
  sourceConnectionIntents.clear();
  sourceMutations.clear();
  completionLoads.clear();
  duckdbCatalogLoads.clear();
  preparingConsoles.clear();
  for (const scope of consoleScopes.values()) scope.retired = true;
  consoleScopes.clear();
  closingConsoles.clear();
  pendingExplains.clear();
  lastUsed.clear();
  if (useDatabase.getState().pausedConsoleMetadata.size) useDatabase.setState({ pausedConsoleMetadata: new Set() });
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

/** Rebinding resolves the old editor's pending PostgreSQL transaction before changing targets. */
export async function rebindConsole(path: string, id: string | null): Promise<boolean> {
  const previous = consoleSource(path);
  if (previous === id) {
    bindConsole(path, id);
    return true;
  }
  if (useDatabase.getState().running[path]) return false;
  const current = projectRequest();
  const source = previous ? sourceById(previous) : undefined;
  if (previous && source?.driver === "postgres" && consoleHasPending(useDatabase.getState(), previous, path)) {
    const commit = await askEndTransaction(source, true);
    if (commit === null || !current() || consoleSource(path) !== previous) return false;
    if (!(await finishTransaction(previous, commit, path))) return false;
  }
  if (!current() || consoleSource(path) !== previous) return false;
  bindConsole(path, id);
  return true;
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
  const inferred = consoleTargetFromPath(path, s.sources);
  if (inferred) return inferred;
  const scope = scopeOf(path);
  if (scope) return scope.dataSource;
  return s.sources.length === 1 ? (s.sources[0]!.id ?? null) : null;
}

/** Opens (creating it on first use) the query console of data source `id`, switched to `schema` if given. */
export async function openConsole(id: string, schema?: string): Promise<void> {
  try {
    const path = await call(commands.dbConsolePath(id));
    if (!(await rebindConsole(path, id))) return;
    announceConsoleFile(path);
    if (schema) setConsoleSchema(path, schema);
    await editorService().openFile(path, { focus: true });
  } catch (e) {
    notifications().notify({ level: "error", title: "Cannot open the query console", body: message(e) });
  }
}

/** The query console files of data source `id`: `console.sql`, then `console_1.sql`, `console_2.sql`… */
export function consoleFiles(id: string): Promise<string[]> {
  return call(commands.dbConsoles(id, false));
}

/** Opens one of the query consoles of data source `id`, switched to `schema` if given. */
export async function openConsoleFile(id: string, path: string, schema?: string): Promise<void> {
  if (!(await rebindConsole(path, id))) return;
  if (schema) setConsoleSchema(path, schema);
  await editorService().openFile(path, { focus: true });
}

/** Creates and opens another query console of data source `id` (DataGrip's New › Query Console). */
export async function newConsole(id: string, schema?: string): Promise<void> {
  try {
    const before = new Set(await consoleFiles(id));
    const after = await call(commands.dbConsoles(id, true));
    const path = after.find((p) => !before.has(p)) ?? after[after.length - 1];
    if (path) {
      announceConsoleFile(path);
      await openConsoleFile(id, path, schema);
    }
  } catch (e) {
    notifications().notify({ level: "error", title: "Cannot open the query console", body: message(e) });
  }
}

function announceConsoleFile(path: string) {
  emitLocalIdeEvent({ type: "fsChanged", created: [path], modified: [], removed: [] });
}

let nextTab = 1;
let nextRun = 1;
let nextLine = 1;

function outputLine(kind: OutputLine["kind"], text: string, prompt?: string, path?: string): OutputLine {
  return { id: nextLine++, time: Date.now(), kind, text, prompt, path };
}

export function log(kind: OutputLine["kind"], text: string, prompt?: string, path?: string) {
  const line = outputLine(kind, text, prompt, path);
  useDatabase.setState((s) => ({ output: [...s.output, line].slice(-MAX_OUTPUT) }));
}

export function clearOutput(path?: string) {
  useDatabase.setState((s) => ({ output: path === undefined ? [] : s.output.filter((line) => line.path !== path) }));
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

function changesSchema(id: string, outcome: DbStatementOutcome): boolean {
  if (outcome.error) return false;
  const { text } = outcome.statement;
  if (sqlDriverOf(sourceById(id)) === "duckdb") {
    const first = /^\s*([a-z_][\w$]*)/i.exec(text)?.[1]?.toUpperCase() ?? lex(text, "duckdb").tokens[0]?.upper;
    return /^(ATTACH|DETACH|USE|CREATE|DROP|ALTER|RENAME)$/.test(first ?? "");
  }
  return /^\s*(create|drop|alter|rename)\b/i.test(text);
}

function outcomeUpdates(
  state: DatabaseState,
  id: string,
  schema: string | undefined,
  outcomes: readonly DbStatementOutcome[],
  logConnected: boolean,
  path?: string,
): Pick<DatabaseState, "output" | "pendingTx" | "consolePendingTx"> {
  const prompt = `${schema || promptOf(id)}>`;
  const lines = logConnected ? [outputLine("info", "Connected", undefined, path)] : [];
  for (const outcome of outcomes) {
    lines.push(outputLine("statement", outcome.statement.text, prompt, path));
    lines.push(
      outcome.error
        ? outputLine("error", `[${targetLabel(id)}] ${outcome.error}`, undefined, path)
        : outputLine("result", outcomeSummary(outcome), undefined, path),
    );
  }
  const pending =
    consoleUsesManualCommit(state, id, path) &&
    !consoleHasPending(state, id, path) &&
    outcomes.some((outcome) => !outcome.error && !READS.test(outcome.statement.text));
  const scope = postgresConsoleKey(state, id, path);
  return {
    output: [...state.output, ...lines].slice(-MAX_OUTPUT),
    pendingTx: pending && !scope ? new Set(state.pendingTx).add(id) : state.pendingTx,
    consolePendingTx: pending && scope ? new Set(state.consolePendingTx).add(scope) : state.consolePendingTx,
  };
}

/**
 * Runs `statements` on `id`, logging to Output; errors stop the batch (backend).
 * Results keep `maxRows` rows after the first `skip`, which the backend reads past.
 * `schema` is a console's active context: the backend puts the connection that runs
 * each statement in it, so unqualified names resolve there.
 */
/** Shows `id` disconnected when the backend closed its connection (it reconnects on next use). */
async function syncDropped(id: string, path?: string) {
  const current = databaseRequest(id);
  const server = await call(commands.dbConnected()).catch(() => null);
  if (!current() || !server || server.includes(id) || !useDatabase.getState().connected.has(id)) return;
  duckdbCatalogLoads.delete(id);
  useDatabase.setState((s) => {
    const connected = new Set(s.connected);
    connected.delete(id);
    return { connected };
  });
  log("info", `${targetLabel(id)}: the connection was lost; the next statement reconnects`, undefined, path);
}

function consoleScopeKey(id: string, path: string): string {
  return JSON.stringify([id, path]);
}

function openConsoleScope(id: string, path: string): ConsoleScope {
  const key = consoleScopeKey(id, path);
  const existing = consoleScopes.get(key);
  if (existing) return existing;
  const scope = { id, path, retired: false, modeRequest: Promise.resolve() };
  consoleScopes.set(key, scope);
  return scope;
}

function updateConsoleMode(scope: ConsoleScope, manual: boolean): Promise<boolean> {
  const changed = scope.modeRequest.then(() => {
    if (scope.retired) throw new IpcError({ kind: "cancelled", message: tx("Cancelled") });
    return call(commands.dbSetConsoleManualCommit(scope.id, scope.path, manual));
  });
  scope.modeRequest = changed.catch(() => {});
  return changed;
}

function postgresConsoleKey(state: DatabaseState, id: string, path?: string): string | null {
  const source = state.sources.find((source) => source.id === splitTarget(id).id);
  return source?.driver === "postgres" && path ? consoleScopeKey(id, path) : null;
}

/** Keep a console connection while the editor or one of its results can use it. */
export function watchConsoleSessions(): () => void {
  const editor = maybeEditorService();
  const release = () => {
    const paths = editor?.openPaths?.();
    if (!paths || !consoleScopes.size) return;
    const open = new Set(paths);
    const { results, inline } = useDatabase.getState();
    const retained = new Set([...results, ...inline].map((tab) => consoleScopeKey(tab.sourceId, tab.path)));
    for (const [key, scope] of consoleScopes) {
      const { id, path } = scope;
      if (retained.has(key) || (open.has(path) && consoleSource(path) === id)) continue;
      scope.retired = true;
      consoleScopes.delete(key);
      if (!open.has(path)) {
        preparingConsoles.delete(path);
        cancelConsole(path);
      }
      const current = databaseRequest(id);
      const pending = consoleHasPending(useDatabase.getState(), id, path);
      const closing = scope.modeRequest
        .then(() => {
          if (current()) return call(commands.dbReleaseConsole(path, id));
        })
        .then(() => {
          if (pending && current()) log("info", "Transaction rolled back");
        })
        .catch((error: unknown) => {
          if (pending && current()) log("error", `[${targetLabel(id)}] ${message(error)}`);
        });
      closingConsoles.set(key, closing);
      void closing.then(() => {
        if (closingConsoles.get(key) !== closing) return;
        closingConsoles.delete(key);
        if (!current()) return;
        useDatabase.setState((s) => {
          const consoleModes = new Map(s.consoleModes);
          const consolePendingTx = new Set(s.consolePendingTx);
          consoleModes.delete(key);
          consolePendingTx.delete(key);
          return { consoleModes, consolePendingTx };
        });
      });
    }
  };
  const offTabs = editor?.onOpenTabsChange?.(release);
  const offResults = useDatabase.subscribe((state, previous) => {
    if (state.results !== previous.results || state.inline !== previous.inline || state.consoles !== previous.consoles)
      release();
  });
  return () => {
    offTabs?.();
    offResults();
  };
}

async function ensureConsoleManual(scope: ConsoleScope, current: () => boolean) {
  const { id, path } = scope;
  const pending = consoleHasPending(useDatabase.getState(), id, path);
  const initialized = await updateConsoleMode(scope, true);
  if (!current() || scope.retired) throw new IpcError({ kind: "cancelled", message: tx("Cancelled") });
  if (initialized && pending) {
    setPending(id, false, path);
    throw new IpcError({
      kind: "invalidInput",
      message: tx(
        "The previous transaction is no longer available. Check its outcome before running another statement.",
      ),
    });
  }
}

function withConsoleConnection<T>(
  id: string,
  path: string | undefined,
  op: (console: string | null, manual: boolean | null) => Promise<T>,
) {
  const current = databaseRequest(id);
  return withConnection(id, async () => {
    const driver = sourceById(id)?.driver;
    if (!path || (driver !== "clickhouse" && driver !== "postgres" && driver !== "jdbc")) return op(null, null);
    const key = consoleScopeKey(id, path);
    // A reopened editor waits for the previous session's release before using the same path.
    const closing = closingConsoles.get(key);
    if (closing) await closing;
    if (!current()) throw new IpcError({ kind: "cancelled", message: tx("Cancelled") });
    const scope = openConsoleScope(id, path);
    await scope.modeRequest;
    if (!current() || scope.retired) throw new IpcError({ kind: "cancelled", message: tx("Cancelled") });
    const manual = driver === "postgres" ? consoleUsesManualCommit(useDatabase.getState(), id, path) : null;
    if (manual) await ensureConsoleManual(scope, current);
    if (scope.retired) throw new IpcError({ kind: "cancelled", message: tx("Cancelled") });
    return op(path, manual);
  });
}

async function run(
  id: string,
  statements: SqlStatement[],
  request: RequestId,
  maxRows = useDatabase.getState().maxRows,
  skip = 0,
  schema?: string,
  path?: string,
  progress?: {
    emit: (event: StatementProgress) => void;
    current: () => boolean;
    onStatementCancelled: () => void;
    onIncompleteDelivery: () => void;
  },
): Promise<DbStatementOutcome[]> {
  const current = databaseRequest(id);
  const wasConnected = useDatabase.getState().connected.has(id);
  // Only a query that is safe to run again has its cells cut: the whole value is read by running it again.
  const driver = sourceById(id)?.driver ?? "sqlite";
  const cellLimit = statements.every((s) => isReadOnlyQuery(s.text, driver)) ? CELL_LIMIT : null;
  const outcomes = await withConsoleConnection(id, path, async (console, manual) => {
    const execute = async () => {
      progress?.emit({ type: "started", index: 0 });
      const outcomes = await call(
        commands.dbExecute(request, id, statements, skip, maxRows, schema || null, cellLimit, console, manual),
      ).catch((error: unknown) => {
        if (isCancelled(error)) progress?.onStatementCancelled();
        throw error;
      });
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
      await call(
        commands.dbExecuteStream(request, id, statements, maxRows, schema || null, cellLimit, channel, console, manual),
      );
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
  if (outcomes.some((o) => o.error)) void syncDropped(id, path);
  // Consoles publish the same outcome updates alongside their progress and grids.
  if (progress) return outcomes;
  useDatabase.setState((s) => outcomeUpdates(s, id, schema, outcomes, !wasConnected, path));
  if (outcomes.some((outcome) => changesSchema(id, outcome))) void refresh(id);
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
    // oxlint-disable-next-line no-await-in-loop -- polling waits 50ms between attempts for the editor view to mount
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

interface BoundStatements {
  /** The statements with their parameters' values in their text; `[]` when cancelled. */
  statements: SqlStatement[];
  /** A range of statement `i`'s bound text in its unbound text; `null` when it overlaps a value. */
  unbind: (i: number, from: number, to: number) => { from: number; to: number } | null;
}

/** Asks for the values of the statements' query parameters and binds them. */
async function withParams(statements: SqlStatement[], driver: DbDriver): Promise<BoundStatements> {
  let numbered = 0;
  const found = statements.map((st) => {
    const params = findParams(st.text, driver, numbered);
    numbered += params.filter((p) => p.positional).length;
    return params;
  });
  const names = [...new Set(found.flat().map((p) => p.name))];
  const same: BoundStatements["unbind"] = (_i, from, to) => ({ from, to });
  if (!names.length) return { statements, unbind: same };
  const values = await new Promise<Record<string, string> | null>((resolve) =>
    useDatabase.setState({ dialog: { kind: "params", names, resolve } }),
  );
  if (!values) return { statements: [], unbind: same };
  useDatabase.setState((s) => ({ paramValues: { ...s.paramValues, ...values } }));
  return {
    statements: statements.map((st, i) => ({ ...st, text: bindParams(st.text, found[i]!, values) })),
    unbind: (i, from, to) => unbindRange(found[i]!, values, from, to),
  };
}

/** Asks whether to run an unsafe statement (see `sql/unsafe`); false cancels the run. */
export type ConfirmUnsafe = (statement: SqlStatement, unsafe: UnsafeStatement) => Promise<boolean>;

/**
 * Runs the statement at `from` (or the selection `from..to`, UTF-16 offsets)
 * of console `path` on its data source. Result sets open as `Result N` tabs
 * of the Services view, replacing the console's unpinned ones; everything is
 * logged to its Output tab; returns the outcomes (errors included) for the
 * editor's marks.
 */
export async function executeConsole(
  path: string,
  text: string,
  from: number,
  to: number,
  /** Called once the statements are submitted, with what was submitted. */
  onStart?: (statements: readonly SqlStatement[]) => void,
  onProgress?: (events: readonly StatementProgress[]) => ReadonlyMap<number, DbStatementOutcome> | void,
  confirmUnsafe?: ConfirmUnsafe,
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
  const editor = maybeEditorService();
  const wasOpen = sourceById(id)?.driver === "postgres" && editor?.openPaths?.()?.includes(path);
  const request = nextRequestId();
  const ownsRun = () => current() && useDatabase.getState().running[path] === request;
  preparingConsoles.set(path, request);
  const earlierExplain = pendingExplains.get(path);
  const resultIds = new Set<number>();
  let finished = false;
  let selectOutput = false;
  let schemaChanged = false;
  let statementCancelled = false;
  let deliveryIncomplete = false;
  const inline = inEditorResults();
  try {
    const statements = await consoleStatements(id, text, from, to, confirmUnsafe);
    if (!current() || preparingConsoles.get(path) !== request || !statements.length) return [];
    preparingConsoles.delete(path);
    if (pendingExplains.get(path) === earlierExplain) pendingExplains.delete(path);
    const prev = useDatabase.getState().running[path];
    if (prev) cancelExecution(prev);
    const execution = { startedAt: Date.now(), statements: statements.length, active: null };
    useDatabase.setState((s) => ({
      running: { ...s.running, [path]: request },
      executions: { ...s.executions, [path]: execution },
    }));
    onStart?.(statements);
    if (!inline) revealDatabaseResults(path);
    const pageSize = useDatabase.getState().maxRows;
    const schema = consoleSchema(path) || (await loadCompletion(id))?.defaultSchema || "";
    if (!ownsRun() || (wasOpen && !editor?.openPaths?.()?.includes(path))) return [];
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
      schemaChanged ||= completed.some((outcome) => changesSchema(id, outcome));
      useDatabase.setState((s) => {
        const executions = { ...s.executions, [path]: { ...execution, active } };
        const state = completed.length
          ? { executions, ...outcomeUpdates(s, id, schema, completed, logConnected, path) }
          : { executions };
        const latest = tabs.at(-1);
        if (!latest) return state;
        if (inline) return { ...state, inline: [...s.inline, ...tabs.map((tab) => ({ ...tab, inline: true }))] };
        return {
          ...state,
          results: capResults([...s.results, ...tabs], resultIds),
          activeResult: latest.id,
          activeClientResults: { ...s.activeClientResults, [path]: latest.id },
        };
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
      outcomes = await run(id, statements, request, pageSize, 0, schema, path, {
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
      log("info", summary, undefined, path);
      notifications().notify({ level: "warning", title: summary, key: "db-execute" });
      if (consoleUsesManualCommit(useDatabase.getState(), id, path)) setPending(id, true, path);
    }
    finished = !deliveryIncomplete;
    selectOutput = !inline && (!resultIds.size || outcomes.some((o) => o.error));
    return outcomes;
  } catch (e) {
    if (!current() || (!ownsRun() && preparingConsoles.get(path) !== request)) return [];
    if (!isCancelled(e)) {
      if (!inline) showOutputFor(path);
      log("error", message(e), undefined, path);
      notifications().notify({ level: "error", title: "Cannot execute", body: message(e), key: "db-execute" });
    } else {
      log("info", "Cancelled", undefined, path);
      // Interrupting a running statement discards its held transaction. Between statements it stays open.
      if (statementCancelled && consoleHasPending(useDatabase.getState(), id, path)) {
        log("info", "Transaction rolled back", undefined, path);
        setPending(id, false, path);
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
      return {
        running,
        executions,
        results,
        ...(selectOutput && {
          activeResult: OUTPUT_TAB,
          activeClientResults: { ...s.activeClientResults, [path]: OUTPUT_TAB },
        }),
      };
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
async function consoleStatements(
  id: string,
  text: string,
  from: number,
  to: number,
  confirmUnsafe?: ConfirmUnsafe,
): Promise<SqlStatement[]> {
  const statements: SqlStatement[] = await call(commands.dbStatements(id, text, from, to));
  if (!statements.length) return [];
  const driver = sourceById(id)?.driver ?? "sqlite";
  const bound = await withParams(statements, driver);
  // The bound text is what runs: a parameter's value can make it unsafe (`where :cond`, `1=1`).
  if (confirmUnsafe)
    for (const [i, st] of bound.statements.entries()) {
      const unsafe = unsafeStatement(st.text, driver);
      if (!unsafe) continue;
      const original = statements[i]!;
      // A mark inside a parameter's value marks the whole statement.
      const at = bound.unbind(i, unsafe.from, unsafe.to) ?? { from: 0, to: original.text.length };
      // oxlint-disable-next-line no-await-in-loop -- each warning must be answered before asking the next
      if (!(await confirmUnsafe(original, { ...unsafe, ...at }))) return [];
    }
  return bound.statements;
}

const PLAN_TITLE = "Query Plan";

/** Publishes the plan, selecting its tab only if Explain still owns the selection. */
function showPlan(
  path: string,
  id: string,
  statement: SqlStatement,
  schema: string | undefined,
  plan: DbPlanNode[],
  select: boolean,
) {
  useDatabase.setState((s) => {
    const old = select ? s.results.find((r) => r.path === path && r.plan && !r.pinned) : undefined;
    const tab: ResultTab = {
      id: old?.id ?? nextTab++,
      title: old?.title ?? PLAN_TITLE,
      path,
      sourceId: id,
      schema,
      outcome: { statement, result: null, error: null },
      plan,
    };
    const active = select ? tab.id : activeResultFor(s, path);
    // Adding a late plan must not evict any of the selected tabs.
    const keep = select
      ? new Set([tab.id])
      : new Set([tab.id, active, s.activeResult ?? OUTPUT_TAB, ...Object.values(s.activeClientResults)]);
    const results = old ? s.results.map((r) => (r === old ? tab : r)) : capResults([...s.results, tab], keep);
    const activeClientResults = { ...s.activeClientResults, [path]: active };
    return select ? { results, activeResult: tab.id, activeClientResults } : { results, activeClientResults };
  });
}

async function explain(
  id: string,
  statement: SqlStatement,
  schema: string | undefined,
  path: string,
  request = nextRequestId(),
): Promise<DbPlanNode[]> {
  const current = databaseRequest(id);
  const plan = await withConsoleConnection(id, path, (console, manual) =>
    call(commands.dbExplain(request, id, statement.text, schema || null, console, manual)),
  );
  if (current()) {
    log("statement", `explain ${statement.text}`, `${schema || promptOf(id)}>`, path);
    log("result", `${plan.length} plan node${plan.length === 1 ? "" : "s"}`, undefined, path);
  }
  return plan;
}

/** Explain Plan: the plan of the statement at `from` (the first selected one) of console `path`. */
export async function explainConsole(path: string, text: string, from: number, to: number): Promise<void> {
  const id = consoleSource(path);
  if (!id || !supportsExplain(sourceById(id))) return;
  const current = databaseRequest(id);
  const request = nextRequestId();
  pendingExplains.set(path, request);
  const ownsSelection = () => pendingExplains.get(path) === request;
  try {
    const [statement] = await consoleStatements(id, text, from, to);
    if (!current() || !statement) return;
    if (ownsSelection()) revealDatabaseResults(path);
    const schema = consoleSchema(path);
    const plan = await explain(id, statement, schema, path, request);
    if (current()) showPlan(path, id, statement, schema, plan, ownsSelection());
  } catch (e) {
    if (!current() || isCancelled(e)) return;
    log("error", `[${targetLabel(id)}] ${message(e)}`, undefined, path);
    if (!ownsSelection()) return;
    showOutputFor(path);
    notifications().notify({
      level: "error",
      title: "Cannot explain the statement",
      body: message(e),
      key: "db-explain",
    });
  } finally {
    if (ownsSelection()) pendingExplains.delete(path);
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
        plan: await explain(tab.sourceId, tab.outcome.statement, tab.schema ?? consoleSchema(tab.path), tab.path),
        busy: false,
      });
    } catch (e) {
      patchResult(tabId, { busy: false });
      if (!isCancelled(e)) log("error", `[${targetLabel(tab.sourceId)}] ${message(e)}`, undefined, tab.path);
    }
    return;
  }
  await loadResultPage(tabId, tab.page ?? 0, tab.pageSize ?? useDatabase.getState().maxRows, true);
}

/** Whether result tab `tab` can show other pages: running its query again only reads. */
export function pageable(tab: ResultTab): boolean {
  return !tab.plan && isReadOnlyQuery(tab.outcome.statement.text, sourceById(tab.sourceId)?.driver ?? "sqlite");
}

/** Row `row` (from 0, over all pages) of result tab `tab`'s query, with its cells whole. */
export async function readResultRow(tab: ResultTab, row: number): Promise<DbQueryResult> {
  const schema = tab.schema ?? consoleSchema(tab.path);
  return withConsoleConnection(tab.sourceId, tab.path, (console, manual) =>
    call(
      commands.dbResultRow(nextRequestId(), tab.sourceId, tab.outcome.statement, row, schema || null, console, manual),
    ),
  );
}

/** The rows of the page result tab `tab` shows, with their cells whole. */
export async function readResultPage(tab: ResultTab): Promise<DbQueryResult> {
  const schema = tab.schema ?? consoleSchema(tab.path);
  const rows = Math.max(tab.outcome.result?.rows.length ?? 0, 1);
  const { skip } = pageFetch(tab.page ?? 0, tab.pageSize ?? rows);
  const [outcome] = await withConsoleConnection(tab.sourceId, tab.path, (console, manual) =>
    call(
      commands.dbExecute(
        nextRequestId(),
        tab.sourceId,
        [tab.outcome.statement],
        skip,
        rows,
        schema || null,
        null,
        console,
        manual,
      ),
    ),
  );
  if (!outcome?.result) throw new Error(outcome?.error ?? "The statement returned no result");
  return outcome.result;
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
      tab.path,
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
    if (outcome?.error && useDatabase.getState().results.some((r) => r.id === tabId)) showOutputFor(tab.path);
  } catch (e) {
    patchResult(tabId, { busy: false });
    if (!isCancelled(e)) log("error", message(e), undefined, tab.path);
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
      tab.path,
    );
    const total = Number(outcome?.result?.rows[0]?.[0]);
    const known = outcome?.error || !Number.isFinite(total) ? null : total;
    patchResult(tabId, { busy: false, ...(known === null ? {} : { total: known }) });
    return known;
  } catch (e) {
    patchResult(tabId, { busy: false });
    if (!isCancelled(e)) log("error", message(e), undefined, tab.path);
    return null;
  }
}

/** Statements that only read (they leave a manual transaction clean). */
const READS = /^\s*(select|show|pragma|explain|describe|desc|values|table)\b/i;

export function consoleUsesManualCommit(state: DatabaseState, id: string, path?: string): boolean {
  const key = postgresConsoleKey(state, id, path);
  if (!key) return state.manualCommit.has(id);
  const source = state.sources.find((source) => source.id === splitTarget(id).id);
  return state.consoleModes.get(key) ?? source?.options?.transaction === "manual";
}

export function consoleHasPending(state: DatabaseState, id: string, path?: string): boolean {
  const key = postgresConsoleKey(state, id, path);
  return key ? state.consolePendingTx.has(key) : state.pendingTx.has(id);
}

function setPending(id: string, pending: boolean, path?: string) {
  useDatabase.setState((s) => {
    const key = postgresConsoleKey(s, id, path);
    const scope = key ?? id;
    const updated = new Set(key ? s.consolePendingTx : s.pendingTx);
    if (pending) updated.add(scope);
    else updated.delete(scope);
    return key ? { consolePendingTx: updated } : { pendingTx: updated };
  });
}

/** Commits or rolls back the open transaction of the console or legacy data source scope. */
export async function finishTransaction(id: string, commit: boolean, path?: string): Promise<boolean> {
  const driver = sourceById(id)?.driver;
  if (driver === "clickhouse" || driver === "jdbc") return false;
  const current = databaseRequest(id);
  try {
    if (driver === "postgres" && path && consoleHasPending(useDatabase.getState(), id, path)) {
      await ensureConsoleManual(openConsoleScope(id, path), current);
    }
    await call(
      driver === "postgres" && path
        ? commands.dbFinishConsoleTransaction(id, path, commit)
        : commands.dbFinishTransaction(id, commit),
    );
    if (!current()) return false;
    log("statement", commit ? "commit" : "rollback", `${promptOf(id)}>`, path);
    log("result", commit ? "Transaction committed" : "Transaction rolled back", undefined, path);
    setPending(id, false, path);
    return true;
  } catch (e) {
    log("error", `[${targetLabel(id)}] ${message(e)}`, undefined, path);
    notifications().notify({ level: "error", title: commit ? "Cannot commit" : "Cannot roll back", body: message(e) });
    return false;
  }
}

/** Leaving a console scope with changes pending, or null when cancelled. */
async function askEndTransaction(source: DataSource, rebind = false): Promise<boolean | null> {
  const { button } = await ask({
    title: rebind ? "Switch Data Source" : "Switch to Auto-Commit",
    body: rebind
      ? tx`${source.name} has uncommitted changes. Commit or roll them back before switching data sources?`
      : tx`${source.name} has uncommitted changes. Commit or roll them back before switching to auto-commit?`,
    buttons: [
      { id: "rollback", label: "Roll Back" },
      { id: "commit", label: "Commit", primary: true },
    ],
  });
  return button === "cancel" ? null : button === "commit";
}

/** IDEA's Tx: Auto / Manual. Leaving manual mode resolves pending changes first. */
export async function setManualCommit(id: string, manual: boolean, path?: string): Promise<void> {
  const source = sourceById(id);
  if (source?.driver === "jdbc" || (source?.driver === "clickhouse" && manual)) return;
  const st = useDatabase.getState();
  if (manual === consoleUsesManualCommit(st, id, path)) return;
  const current = databaseRequest(id);
  if (!manual && consoleHasPending(st, id, path)) {
    const commit = source ? await askEndTransaction(source) : false;
    if (commit === null || !(await finishTransaction(id, commit, path))) return;
  }
  const key = postgresConsoleKey(st, id, path);
  try {
    if (key && path) {
      const closing = closingConsoles.get(key);
      if (closing) await closing;
      if (!current()) return;
      const scope = openConsoleScope(id, path);
      if (manual) await withConnection(id, () => updateConsoleMode(scope, true));
      else await updateConsoleMode(scope, false);
      if (!current() || scope.retired) return;
      useDatabase.setState((s) => ({ consoleModes: new Map(s.consoleModes).set(key, manual) }));
    } else {
      await call(commands.dbSetManualCommit(id, manual));
      if (!current()) return;
      useDatabase.setState((s) => {
        const manualCommit = new Set(s.manualCommit);
        if (manual) manualCommit.add(id);
        else manualCommit.delete(id);
        return { manualCommit };
      });
    }
    setPending(id, false, path);
  } catch (e) {
    if (!current()) return;
    log("error", `[${targetLabel(id)}] ${message(e)}`);
    notifications().notify({ level: "error", title: "Cannot change transaction mode", body: message(e) });
  }
}

export function cancelConsole(path: string) {
  const r = useDatabase.getState().running[path];
  if (r) cancelExecution(r);
}

function cancelExecution(request: RequestId) {
  stopResultDelivery.get(request)?.();
  void commands.cancelRequest(request);
}

export function resultsFor(s: Pick<DatabaseState, "results">, path?: string) {
  return path === undefined ? s.results : s.results.filter((tab) => tab.path === path);
}

export function activeResultFor(
  s: Pick<DatabaseState, "activeResult" | "activeClientResults" | "results">,
  path?: string,
) {
  const selected = path === undefined ? s.activeResult : s.activeClientResults[path];
  if (
    selected === OUTPUT_TAB ||
    s.results.some((tab) => tab.id === selected && (path === undefined || tab.path === path))
  )
    return selected ?? OUTPUT_TAB;
  return path === undefined ? OUTPUT_TAB : (resultsFor(s, path).at(-1)?.id ?? OUTPUT_TAB);
}

function showOutputFor(path: string) {
  useDatabase.setState((s) => ({
    activeResult: OUTPUT_TAB,
    activeClientResults: { ...s.activeClientResults, [path]: OUTPUT_TAB },
  }));
}

export function selectResult(id: number, path?: string) {
  useDatabase.setState((s) =>
    path === undefined ? { activeResult: id } : { activeClientResults: { ...s.activeClientResults, [path]: id } },
  );
}

export function closeResult(id: number) {
  useDatabase.setState((s) => {
    const index = s.results.findIndex((r) => r.id === id);
    if (index < 0) return s;
    const path = s.results[index]!.path;
    const results = s.results.filter((r) => r.id !== id);
    const sameClient = resultsFor(s, path);
    const clientIndex = sameClient.findIndex((r) => r.id === id);
    return {
      results,
      activeResult: s.activeResult === id ? ((results[index - 1] ?? results[index])?.id ?? OUTPUT_TAB) : s.activeResult,
      ...(s.activeClientResults[path] === id && {
        activeClientResults: {
          ...s.activeClientResults,
          [path]: (sameClient[clientIndex - 1] ?? sameClient[clientIndex + 1])?.id ?? OUTPUT_TAB,
        },
      }),
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
