/**
 * GraphQL state: discovered schemas, the tool window's tab and last query result, and
 * per file the endpoint and variables the editor toolbar runs queries with.
 */
import { create } from "zustand";
import { editorsFor, useEditorRegistry, type TextEditorHandle } from "@/editor/api";
import { setFileDiagnostics } from "@/editor/lsp/diagnostics";
import { tx } from "@/platform/i18n";
import type { Diagnostic } from "@/bindings";
import { call, commands, isCancelled, nextRequestId, type RequestId } from "@/platform/ipc";
import { basename, dirname, useProject } from "@/platform/project";
import { editorService, notifications, toolWindowService } from "@/workbench/contributions";
import { confirm, showError } from "@/workbench/messages";
import {
  CONFIG_NAMES,
  CONFIG_TEMPLATE,
  GENERATED_HEADER,
  INTROSPECTION_QUERY,
  analyzeSchema,
  discoverSchemas,
  expandEndpoint,
  missingVariables,
  httpRequestText,
  introspectionTarget,
  introspectionToSdl,
  isConfigFile,
  isSchemaFile,
  parseConfig,
  parseVariables,
  unresolvedTypes,
  type Endpoint,
  type SchemaFile,
  type SchemaProject,
} from "./model";

export const TOOL_WINDOW = "graphql";

export type GraphQLTab = "schemas" | "result";

export interface QueryResult {
  /** The GraphQL file the query came from. */
  path: string;
  endpoint: Endpoint;
  status: number | null;
  totalMs: number | null;
  body: string | null;
  /** Response size in bytes. */
  size: number | null;
  error: string | null;
}

interface GraphQLState {
  tab: GraphQLTab;
  /** null until the first discovery of the open project. */
  projects: SchemaProject[] | null;
  discovering: boolean;
  /** Expanded tree rows; null: the default (schemas and their sections open). */
  expanded: Set<string> | null;
  result: QueryResult | null;
  running: RequestId | null;
  /** Endpoint chosen in the editor toolbar, by schema key. */
  endpointBySchema: Record<string, string>;
  /** Files whose editor shows the variables editor. */
  variablesShown: ReadonlySet<string>;
  /** Variables editor text (JSON), by file. */
  variables: Record<string, string>;
  /** The last introspection, for "Rerun Introspection Query". */
  lastIntrospection: { path: string; endpoint: string } | null;
  /** The open GraphQL Environment Variables dialog; `done` hears whether it was confirmed. */
  envDialog: { configPath: string; variables: string[]; done?: (ok: boolean) => void } | null;
}

const INITIAL: GraphQLState = {
  tab: "schemas",
  projects: null,
  discovering: false,
  expanded: null,
  result: null,
  running: null,
  endpointBySchema: {},
  variablesShown: new Set(),
  variables: {},
  lastIntrospection: null,
  envDialog: null,
};

export const useGraphQL = create<GraphQLState>(() => ({ ...INITIAL }));

export function resetGraphQL() {
  publishSchemaDiagnostics([]);
  useGraphQL.setState({ ...INITIAL });
}

// --- schema errors in editors ------------------------------------------------------------------

const DIAGNOSTICS_SOURCE = "graphql-schema";
let published = new Set<string>();

/** Shows discovery's schema errors (unresolved types) in editors and Problems, as IDEA does. */
function publishSchemaDiagnostics(projects: readonly SchemaProject[]) {
  const byPath = new Map<string, Diagnostic[]>();
  for (const p of projects)
    for (const { path, diagnostic } of unresolvedTypes(p)) {
      const list = byPath.get(path) ?? [];
      list.push(diagnostic);
      byPath.set(path, list);
    }
  for (const path of published) if (!byPath.has(path)) setFileDiagnostics(path, DIAGNOSTICS_SOURCE, []);
  for (const [path, items] of byPath) setFileDiagnostics(path, DIAGNOSTICS_SOURCE, items);
  published = new Set(byPath.keys());
}

function setProjects(projects: SchemaProject[]) {
  useGraphQL.setState({ projects });
  publishSchemaDiagnostics(projects);
}

/** Re-checks a schema file from its editor text while it is edited (not yet saved). */
export function revalidateFile(path: string, text: string) {
  const projects = useGraphQL.getState().projects;
  if (!projects?.some((p) => p.files.some((f) => f.path === path))) return;
  const file: SchemaFile = { path, ...analyzeSchema(text) };
  setProjects(projects.map((p) => ({ ...p, files: p.files.map((f) => (f.path === path ? file : f)) })));
}

// --- environment variables ---------------------------------------------------------------------

const ENV_KEY = "openidea.graphql.environment";

function readEnvironment(): Record<string, Record<string, string>> {
  try {
    const raw = localStorage.getItem(ENV_KEY);
    return raw ? (JSON.parse(raw) as Record<string, Record<string, string>>) : {};
  } catch {
    return {};
  }
}

export function environmentOf(configPath: string | null): Record<string, string> {
  return configPath ? (readEnvironment()[configPath] ?? {}) : {};
}

export function saveEnvironment(configPath: string, values: Record<string, string>) {
  try {
    localStorage.setItem(ENV_KEY, JSON.stringify({ ...readEnvironment(), [configPath]: values }));
  } catch {
    // Storage unavailable (private window): the values are not kept.
  }
}

/** Opens IDEA's GraphQL Environment Variables dialog for a config; resolves true once confirmed. */
function requestEnvironment(schema: SchemaProject): Promise<boolean> {
  const configPath = schema.configPath;
  if (!configPath || !schema.variables.length) return Promise.resolve(false);
  useGraphQL.getState().envDialog?.done?.(false);
  return new Promise((done) =>
    useGraphQL.setState({ envDialog: { configPath, variables: [...schema.variables].sort(), done } }),
  );
}

/** "Edit Environment Variables": the `${NAME}` variables of `path`'s config, in IDEA's dialog. */
export async function editEnvironmentVariables(path: string): Promise<void> {
  const schema = schemaOf(await ensureDiscovered(), path);
  if (schema) await requestEnvironment(schema);
}

export function closeEnvironmentDialog(ok = false) {
  const done = useGraphQL.getState().envDialog?.done;
  useGraphQL.setState({ envDialog: null });
  done?.(ok);
}

/**
 * Before running against `endpoint`: when it uses variables with no value (and no default),
 * asks for them as IDEA does. False when the dialog is cancelled.
 */
async function ensureEnvironment(endpoint: Endpoint): Promise<boolean> {
  const schema = (useGraphQL.getState().projects ?? []).find((p) => p.endpoints.includes(endpoint));
  if (!schema?.configPath || !missingVariables(endpoint, environmentOf(schema.configPath)).length) return true;
  return requestEnvironment(schema);
}

/** Files are found through the file index's fuzzy search, then matched exactly. */
const FILE_QUERIES = [".graphql", ".gql", "graphqlrc", "graphql.config"];
const FILE_LIMIT = 10000;
/** Schema files read for discovery; more are listed without their definitions. */
const READ_LIMIT = 500;

async function readText(path: string): Promise<string | null> {
  try {
    return await call(commands.fsReadText(path));
  } catch {
    return null;
  }
}

let generation = 0;

/** (Re)discovers the open project's schemas ("Restart Schema Discovery"). */
export async function discoverSchemasNow(): Promise<void> {
  const root = useProject.getState().project?.root;
  if (!root) return;
  const run = ++generation;
  useGraphQL.setState({ discovering: true });
  try {
    const hits = await Promise.all(FILE_QUERIES.map((q) => call(commands.findFiles(q, FILE_LIMIT))));
    const paths = [...new Set(hits.flat().map((m) => m.path))];
    const schemaPaths = paths.filter((p) => isSchemaFile(basename(p)));
    const configPaths = paths.filter((p) => isConfigFile(basename(p)));
    const [files, configs] = await Promise.all([
      Promise.all(
        schemaPaths.map(async (path, i): Promise<SchemaFile> => {
          const text = i < READ_LIMIT ? await readText(path) : null;
          return { path, ...analyzeSchema(text ?? "") };
        }),
      ),
      Promise.all(
        configPaths.map(async (path) => ({ path, config: parseConfig(basename(path), (await readText(path)) ?? "") })),
      ),
    ]);
    if (run !== generation) return;
    setProjects(discoverSchemas(root, configs, files));
  } catch (e) {
    if (run === generation && !isCancelled(e))
      notifications().notify({ level: "error", title: "GraphQL schema discovery failed", body: String(e) });
  } finally {
    if (run === generation) useGraphQL.setState({ discovering: false });
  }
}

async function ensureDiscovered(): Promise<SchemaProject[]> {
  if (!useGraphQL.getState().projects) await discoverSchemasNow();
  return useGraphQL.getState().projects ?? [];
}

/** The configuration a toolbar or tool window acts on: the file's schema's, else the first one. */
export function configurationFor(projects: readonly SchemaProject[] | null, path?: string): string | null {
  if (!projects) return null;
  return (path ? schemaOf(projects, path)?.configPath : null) ?? projects.find((p) => p.configPath)?.configPath ?? null;
}

/** "Edit GraphQL Configuration": opens the configuration `path` (or the project) uses. */
export async function openConfiguration(path?: string): Promise<void> {
  const config = configurationFor(await ensureDiscovered(), path);
  if (config) await editorService().openFile(config);
}

/** Opens the project's graphql-config, creating IDEA's template when there is none. */
export async function addSchemaConfiguration(): Promise<void> {
  const root = useProject.getState().project?.root;
  if (!root) return;
  const existing = configurationFor(await ensureDiscovered());
  if (existing) return editorService().openFile(existing);
  const path = `${root}/${CONFIG_NAMES[0]}`;
  try {
    await call(commands.fsCreateFileBytes(path, [...new TextEncoder().encode(CONFIG_TEMPLATE)]));
  } catch (e) {
    notifications().notify({ level: "error", title: "Cannot create the GraphQL configuration", body: String(e) });
    return;
  }
  await editorService().openFile(path);
  await discoverSchemasNow();
}

export function showGraphQL(tab: GraphQLTab) {
  useGraphQL.setState({ tab });
  toolWindowService().show(TOOL_WINDOW, true);
}

/** The schema `path` belongs to: one listing it, else the closest config folder above it. */
export function schemaOf(projects: readonly SchemaProject[], path: string): SchemaProject | null {
  const listed = projects.find((p) => p.files.some((f) => f.path === path));
  if (listed) return listed;
  const dir = dirname(path);
  return (
    projects
      .filter((p) => p.configPath && (dir === p.root || dir.startsWith(p.root + "/")))
      .sort((a, b) => b.root.length - a.root.length)[0] ?? null
  );
}

/** The endpoint the toolbar of `path` runs against: the chosen one, else the schema's first. */
export function endpointFor(state: Pick<GraphQLState, "projects" | "endpointBySchema">, path: string) {
  const schema = state.projects ? schemaOf(state.projects, path) : null;
  if (!schema) return null;
  const chosen = state.endpointBySchema[schema.key];
  return schema.endpoints.find((e) => e.name === chosen) ?? schema.endpoints[0] ?? null;
}

export function chooseEndpoint(path: string, name: string) {
  useGraphQL.setState((s) => {
    const schema = s.projects ? schemaOf(s.projects, path) : null;
    return schema ? { endpointBySchema: { ...s.endpointBySchema, [schema.key]: name } } : s;
  });
}

export function toggleVariables(path: string) {
  useGraphQL.setState((s) => {
    const shown = new Set(s.variablesShown);
    if (!shown.delete(path)) shown.add(path);
    return { variablesShown: shown };
  });
}

export function setVariables(path: string, text: string) {
  useGraphQL.setState((s) => ({ variables: { ...s.variables, [path]: text } }));
}

function noEndpoint() {
  notifications().notify({
    level: "info",
    title: "No GraphQL endpoint",
    body: "Declare one under extensions.endpoints in graphql.config.yml.",
    key: "graphql-run",
  });
}

/** `configured` with its config's environment variables expanded. */
function resolveEndpoint(configured: Endpoint): Endpoint {
  const projects = useGraphQL.getState().projects ?? [];
  const config = projects.find((p) => p.endpoints.includes(configured))?.configPath ?? null;
  return expandEndpoint(configured, environmentOf(config));
}

/** IDEA's "GraphQL error" balloon for a request that failed, with Retry and Show error. */
function notifyRequestFailed(configured: Endpoint, error: string, retry: () => void) {
  const url = resolveEndpoint(configured).url;
  notifications().notify({
    level: "warning",
    title: "GraphQL error",
    body: tx`GraphQL request to ${url} failed.`,
    actions: [
      { label: "Retry", run: retry },
      { label: "Show error", run: () => void showError(tx`GraphQL request to ${url} failed.`, error) },
    ],
  });
}

async function send(configured: Endpoint, query: string, variables: Record<string, unknown> | null) {
  const endpoint = resolveEndpoint(configured);
  const busy = useGraphQL.getState().running;
  if (busy) void commands.cancelRequest(busy);
  const request = nextRequestId();
  useGraphQL.setState({ running: request });
  try {
    return await call(commands.httpExecute(request, null, httpRequestText(endpoint, query, variables), 0, null));
  } finally {
    if (useGraphQL.getState().running === request) useGraphQL.setState({ running: null });
  }
}

/** "Execute GraphQL": runs `query` from `path` with its variables; the response shows in "Query Result". */
export async function runQuery(path: string, query: string): Promise<void> {
  if (!query) return;
  await ensureDiscovered();
  const endpoint = endpointFor(useGraphQL.getState(), path);
  if (!endpoint) return noEndpoint();
  if (!(await ensureEnvironment(endpoint))) return;
  const parsed = parseVariables(useGraphQL.getState().variables[path] ?? "");
  if ("error" in parsed) {
    notifications().notify({
      level: "error",
      title: "Invalid GraphQL variables",
      body: parsed.error,
      key: "graphql-run",
    });
    return;
  }
  const retry = () => void runQuery(path, query);
  try {
    const ex = await send(endpoint, query, parsed.variables);
    if (ex.entry.error) notifyRequestFailed(endpoint, ex.entry.error, retry);
    useGraphQL.setState({
      result: {
        path,
        endpoint,
        status: ex.response?.status ?? null,
        totalMs: ex.response?.totalMs ?? ex.entry.totalMs,
        body: ex.response?.body ?? null,
        size: ex.response?.size ?? null,
        error: ex.entry.error,
      },
    });
  } catch (e) {
    if (isCancelled(e)) return;
    notifyRequestFailed(endpoint, String(e), retry);
    useGraphQL.setState({
      result: { path, endpoint, status: null, totalMs: null, body: null, size: null, error: String(e) },
    });
  }
  showGraphQL("result");
}

/**
 * "Get GraphQL Schema from Endpoint": introspects an endpoint (`name`, else the one chosen for
 * `path`) and writes the schema as SDL to the config's schema file. An existing file's text is
 * replaced in its editor (undoable); one not written this way is only replaced once confirmed.
 */
export async function introspectEndpoint(path: string, name?: string): Promise<void> {
  const projects = await ensureDiscovered();
  const schema = schemaOf(projects, path);
  const endpoint =
    (name ? schema?.endpoints.find((e) => e.name === name) : null) ?? endpointFor(useGraphQL.getState(), path);
  if (!schema || !endpoint) return noEndpoint();
  if (!(await ensureEnvironment(endpoint))) return;
  useGraphQL.setState({ lastIntrospection: { path, endpoint: endpoint.name } });
  const target = introspectionTarget(schema);
  let sdl: string;
  try {
    const ex = await send(endpoint, INTROSPECTION_QUERY, null);
    if (ex.entry.error || !ex.response?.body) throw new Error(ex.entry.error ?? `HTTP ${ex.response?.status ?? "?"}`);
    sdl = introspectionToSdl(ex.response.body);
  } catch (e) {
    if (!isCancelled(e))
      notifyRequestFailed(
        endpoint,
        e instanceof Error ? e.message : String(e),
        () => void introspectEndpoint(path, name),
      );
    return;
  }
  const current = await readText(target);
  if (current !== null) {
    const generated = current.startsWith(GENERATED_HEADER);
    const ok =
      generated ||
      (await confirm({
        title: "Get GraphQL Schema from Endpoint",
        message: tx`Replace the contents of ${basename(target)} with the schema of ${endpoint.name}?`,
        ok: "Replace",
      }));
    if (!ok) return;
    if (!(await replaceFileText(target, sdl))) {
      notifications().notify({
        level: "error",
        title: "Cannot write the GraphQL schema",
        body: tx`${basename(target)} did not open in an editor`,
      });
      return;
    }
  } else {
    try {
      await call(commands.fsCreateFileBytes(target, [...new TextEncoder().encode(sdl)]));
    } catch (e) {
      notifications().notify({ level: "error", title: "Cannot write the GraphQL schema", body: String(e) });
      return;
    }
    await editorService().openFile(target);
  }
  notifications().notify({
    level: "info",
    title: "GraphQL schema updated",
    body: `${basename(target)} ← ${endpoint.url}`,
    key: "graphql-introspect",
  });
  await discoverSchemasNow();
}

/**
 * Opens `path` and replaces its text in the editor (one undoable edit). A file that was not open
 * gets its editor only after `openFile` resolves, so this waits for it; false when none appears.
 */
export async function replaceFileText(path: string, text: string, timeoutMs = 5000): Promise<boolean> {
  await editorService().openFile(path);
  const editor =
    editorsFor(path)[0] ??
    (await new Promise<TextEditorHandle | null>((resolve) => {
      const done = (e: TextEditorHandle | null) => {
        clearTimeout(timer);
        unsubscribe();
        resolve(e);
      };
      const timer = setTimeout(() => done(null), timeoutMs);
      const unsubscribe = useEditorRegistry.subscribe(() => {
        const e = editorsFor(path)[0];
        if (e) done(e);
      });
    }));
  if (!editor) return false;
  editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: text } });
  return true;
}

/** "Rerun Introspection Query": the last introspection of this schema, else its chosen endpoint. */
export async function rerunIntrospection(path: string): Promise<void> {
  const projects = await ensureDiscovered();
  const last = useGraphQL.getState().lastIntrospection;
  const same = last && schemaOf(projects, last.path) === schemaOf(projects, path);
  await introspectEndpoint(path, same ? last.endpoint : undefined);
}

/** "Open Introspection Schema": the schema file introspection writes for `path`'s schema. */
export async function openIntrospectionSchema(path: string): Promise<void> {
  const schema = schemaOf(await ensureDiscovered(), path);
  if (!schema) return;
  const target = introspectionTarget(schema);
  if ((await readText(target)) === null) {
    notifications().notify({
      level: "info",
      title: "No introspection schema yet",
      body: "Run Introspection Query on an endpoint to generate it.",
      key: "graphql-introspect",
    });
    return;
  }
  await editorService().openFile(target);
}
