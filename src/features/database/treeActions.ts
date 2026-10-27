/**
 * Actions of the Database tool window (IDEA's Database view actions): they
 * act on the node passed as the argument (context menus) or on the tree's
 * lead node (toolbar, shortcuts while the tree has focus).
 */
import { call, commands, type DataSource, type DbDriver, type DbTableInfo } from "@/platform/ipc";
import { registerActions, type Action } from "@/platform/actions";
import { editorService, notifications, showServiceView, toolWindowService } from "@/workbench/contributions";
import { splitTarget } from "./model";
import { nodeTarget, objectOf, schemaObjectOf, tableFolder, tableOf, type DbNode } from "./nodes";
import { canDrop, canRename, reference, scriptSql, type ScriptKind } from "./objects";
import {
  DB_TOOL_WINDOW,
  OUTPUT_TAB,
  RESULTS_VIEW,
  detailsKey,
  disconnect,
  duplicateSource,
  loadDetails,
  loadSchemas,
  loadSources,
  loadTables,
  openConsole,
  openConsoleWith,
  openDdl,
  openObjectDdl,
  openDialog,
  openSourceDialog,
  readableDdl,
  refresh,
  revealInTree,
  runSql,
  sourceById,
  tablesKey,
  useDatabase,
  withConnection,
  removeSource,
} from "./store";
import { tableInput } from "./tableInput";

/** Context key: the Database tree has focus. */
export const DB_VIEW_FOCUS = "databaseViewFocus";
const OPEN = "projectOpen";

const isNode = (v: unknown): v is DbNode => !!v && typeof v === "object" && "kind" in v && "key" in v;

/** The node an action runs on: its argument, else the tree's lead node. */
function nodeFrom(arg: unknown): DbNode | null {
  return isNode(arg) ? arg : useDatabase.getState().selectedNode;
}

function driverOf(id: string): DbDriver {
  return sourceById(id)?.driver ?? "sqlite";
}

function sourceOf(n: DbNode | null): DataSource | undefined {
  return n ? sourceById(nodeTarget(n)) : undefined;
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    notifications().notify({ level: "error", title: `Cannot copy the ${what}` });
  }
}

/** Where Quick Documentation opens: below the tree's selected row. */
function rowAnchor(): { x: number; y: number } {
  const row = document.querySelector(
    '[role="tree"][aria-label="Data sources"] [role="treeitem"][aria-selected="true"]',
  );
  const r = row?.getBoundingClientRect();
  return r ? { x: r.left + 24, y: r.bottom + 2 } : { x: window.innerWidth / 2, y: window.innerHeight / 3 };
}

export function openTableData(id: string, schema: string, table: string) {
  void editorService().openInput(tableInput(id, schema, table), { focus: true });
}

/** Tables of a schema, loading them if needed. */
async function tablesIn(id: string, schema: string): Promise<DbTableInfo[]> {
  if (useDatabase.getState().tables[tablesKey(id, schema)]?.status !== "ok") await loadTables(id, schema);
  const l = useDatabase.getState().tables[tablesKey(id, schema)];
  return l?.status === "ok" ? l.value : [];
}

/** DDL of a table / view, or of every table and view of a schema or data source. */
async function ddlOf(n: DbNode): Promise<{ id: string; text: string } | null> {
  const id = nodeTarget(n);
  if (!id) return null;
  const one = async (schema: string, table: string) =>
    readableDdl(await withConnection(id, () => call(commands.dbDdl(id, schema, table))), driverOf(id));
  try {
    const o = schemaObjectOf(n);
    if (o)
      return { id, text: await withConnection(id, () => call(commands.dbObjectDdl(id, o.schema, o.kind, o.name))) };
    const t = tableOf(n);
    if (t) return { id, text: await one(t.schema, t.table) };
    let schemas: string[] = [];
    if (n.kind === "schema" || n.kind === "folder") schemas = [n.schema];
    else if (n.kind === "source" || n.kind === "database") {
      if (useDatabase.getState().schemas[id]?.status !== "ok") await loadSchemas(id);
      const l = useDatabase.getState().schemas[id];
      schemas = l?.status === "ok" ? l.value : [];
    }
    const parts: string[] = [];
    for (const schema of schemas) {
      const tables = (await tablesIn(id, schema)).filter(
        (t) => n.kind !== "folder" || tableFolder(t.kind) === n.folder,
      );
      // Tables before views: views select from them.
      tables.sort((a, b) => Number(a.kind !== "table") - Number(b.kind !== "table"));
      for (const t of tables) parts.push(await one(schema, t.name));
    }
    return { id, text: parts.join("\n") };
  } catch (e) {
    notifications().notify({
      level: "error",
      title: "Cannot generate the DDL",
      body: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/** SQL Scripts › Select / Insert / Update / Delete templates into the console. */
export async function insertScript(n: DbNode, kind: ScriptKind) {
  const t = tableOf(n);
  if (!t) return;
  const key = detailsKey(t.id, t.schema, t.table);
  if (useDatabase.getState().details[key]?.status !== "ok") await loadDetails(t.id, t.schema, t.table);
  const d = useDatabase.getState().details[key];
  const columns = d?.status === "ok" ? d.value.columns : [];
  await openConsoleWith(t.id, scriptSql(driverOf(t.id), kind, t.schema, t.table, columns));
}

/** SQL Scripts › Run SQL Script…: picks a `.sql` file and runs all its statements. */
async function runScriptFile(id: string) {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const file = await open({
    multiple: false,
    directory: false,
    title: "Run SQL Script",
    filters: [{ name: "SQL", extensions: ["sql", "ddl"] }],
  });
  if (typeof file !== "string") return;
  try {
    const text = await call(commands.fsReadText(file));
    const statements = await call(commands.dbStatements(id, text, 0, text.length));
    useDatabase.setState({ activeResult: OUTPUT_TAB });
    showServiceView(RESULTS_VIEW, false);
    if (
      await runSql(
        id,
        statements.map((s) => s.text),
      )
    )
      notifications().notify({
        level: "info",
        title: `Script finished: ${statements.length} statement${statements.length === 1 ? "" : "s"}`,
      });
  } catch (e) {
    notifications().notify({
      level: "error",
      title: "Cannot run the script",
      body: e instanceof Error ? e.message : String(e),
    });
  }
}

function refreshNode(n: DbNode | null) {
  if (!n) {
    void loadSources();
    for (const c of useDatabase.getState().connected) void refresh(c);
    return;
  }
  const id = nodeTarget(n);
  if (!id) return;
  if (n.kind === "schema" || n.kind === "folder") void loadTables(id, n.schema);
  else if (tableOf(n)) {
    const t = tableOf(n)!;
    void loadDetails(t.id, t.schema, t.table);
  } else void refresh(id);
}

export function registerDatabaseTreeActions(): () => void {
  const tree = (a: Omit<Action, "category">): Action => ({
    category: "Database",
    when: OPEN,
    keyWhen: DB_VIEW_FOCUS,
    ...a,
  });
  return registerActions([
    tree({
      id: "db.properties",
      title: "Data Source Properties…",
      icon: "db-properties",
      keywords: ["data sources", "connection settings"],
      run: ({ arg }) => {
        const src = sourceOf(nodeFrom(arg));
        const { sources } = useDatabase.getState();
        openSourceDialog(src ?? (sources.length === 1 ? sources[0]! : null));
      },
    }),
    tree({
      id: "db.refresh",
      title: "Refresh",
      icon: "refresh",
      keywords: ["synchronize", "introspect"],
      run: ({ arg }) => refreshNode(nodeFrom(arg)),
    }),
    tree({
      id: "db.disconnect",
      title: "Deactivate",
      icon: "db-disconnect",
      keywords: ["disconnect", "close connection"],
      run: ({ arg }) => {
        const n = nodeFrom(arg);
        const id = n ? nodeTarget(n) : null;
        if (!id) {
          for (const c of useDatabase.getState().connected) void disconnect(c);
          return;
        }
        // A database node closes its own connection; anything else the data source's.
        void disconnect(n?.kind === "database" ? id : splitTarget(id).id);
      },
    }),
    tree({
      id: "db.jumpToConsole",
      title: "Jump to Query Console…",
      icon: "db-console",
      run: ({ arg }) => {
        const n = nodeFrom(arg);
        const id = n ? nodeTarget(n) : null;
        const { sources } = useDatabase.getState();
        const target = id ?? (sources.length === 1 ? (sources[0]!.id ?? null) : null);
        if (target) void openConsole(target);
        else toolWindowService().show(DB_TOOL_WINDOW, true);
      },
    }),
    tree({
      id: "db.editData",
      title: "Edit Data",
      icon: "db-table",
      keywords: ["open table", "table editor"],
      run: ({ arg }) => {
        const n = nodeFrom(arg);
        const t = n && tableOf(n);
        if (t) openTableData(t.id, t.schema, t.table);
      },
    }),
    tree({
      id: "db.goToDdl",
      title: "Go to DDL",
      icon: "file-sql",
      keywords: ["edit source", "definition", "create table"],
      run: ({ arg }) => {
        const n = nodeFrom(arg);
        const o = n && schemaObjectOf(n);
        if (o) return void openObjectDdl(o.id, o.schema, o.kind, o.name);
        const t = n && tableOf(n);
        if (t) void openDdl(t.id, t.schema, t.table);
      },
    }),
    tree({
      id: "db.quickDoc",
      title: "Quick Documentation",
      icon: "info",
      run: ({ arg }) => {
        const n = nodeFrom(arg);
        if (n && n.kind !== "message") openDialog({ kind: "quickDoc", node: n, anchor: rowAnchor() });
      },
    }),
    tree({
      id: "db.rename",
      title: "Rename…",
      icon: "edit",
      run: ({ arg }) => {
        const n = nodeFrom(arg);
        if (!n) return;
        const id = nodeTarget(n);
        if (n.kind === "source" && id) return openDialog({ kind: "rename", id, object: null });
        const o = objectOf(n);
        if (id && o && canRename(driverOf(id), o)) openDialog({ kind: "rename", id, object: o });
      },
    }),
    tree({
      id: "db.drop",
      title: "Drop…",
      icon: "trash",
      keywords: ["delete", "remove data source"],
      run: ({ arg }) => {
        const n = nodeFrom(arg);
        if (!n) return;
        const id = nodeTarget(n);
        if (n.kind === "source") return void removeSource(n.source);
        const o = objectOf(n);
        if (id && o && canDrop(driverOf(id), o)) openDialog({ kind: "drop", id, object: o });
      },
    }),
    tree({
      id: "db.truncate",
      title: "Truncate…",
      keywords: ["delete all rows", "empty table"],
      run: ({ arg }) => {
        const n = nodeFrom(arg);
        if (n?.kind === "table" && n.table.kind === "table")
          openDialog({ kind: "truncate", id: n.id, schema: n.schema, table: n.table.name });
      },
    }),
    tree({
      id: "db.modifyTable",
      title: "Modify Table…",
      icon: "edit",
      keywords: ["alter table", "add column", "modify column"],
      run: ({ arg }) => {
        const n = nodeFrom(arg);
        const t = n && tableOf(n);
        if (!t || t.view) return;
        openDialog({
          kind: "modifyTable",
          id: t.id,
          schema: t.schema,
          table: t.table,
          focusColumn: n.kind === "column" ? n.column.name : undefined,
        });
      },
    }),
    tree({
      id: "db.newTable",
      title: "Table",
      icon: "db-table",
      keywords: ["create table", "new table"],
      run: ({ arg }) => {
        const n = nodeFrom(arg);
        const id = n && nodeTarget(n);
        if (!n || !id) return;
        const schema =
          "schema" in n && typeof n.schema === "string" ? n.schema : driverOf(id) === "sqlite" ? "main" : null;
        if (schema !== null) openDialog({ kind: "modifyTable", id, schema, table: null });
      },
    }),
    tree({
      id: "db.newColumn",
      title: "Column",
      icon: "db-column",
      keywords: ["add column"],
      run: ({ arg }) => {
        const n = nodeFrom(arg);
        const t = n && tableOf(n);
        if (t && !t.view)
          openDialog({ kind: "modifyTable", id: t.id, schema: t.schema, table: t.table, addColumn: true });
      },
    }),
    tree({
      id: "db.importData",
      title: "Import Data from File…",
      icon: "import",
      keywords: ["csv", "tsv", "load data"],
      run: ({ arg }) => {
        const n = nodeFrom(arg);
        if (n?.kind === "table" && n.table.kind === "table")
          openDialog({ kind: "import", id: n.id, schema: n.schema, table: n.table.name });
      },
    }),
    tree({
      id: "db.copyReference",
      title: "Copy Reference",
      icon: "copy",
      keywords: ["qualified name"],
      run: ({ arg }) => {
        const n = nodeFrom(arg);
        if (!n) return;
        const id = nodeTarget(n);
        if (n.kind === "source") return void copy(n.source.name ?? "", "name");
        if (n.kind === "database") return void copy(n.name, "name");
        const o = objectOf(n);
        if (id && o) void copy(reference(driverOf(id), o), "reference");
      },
    }),
    tree({
      id: "db.duplicateSource",
      title: "Duplicate",
      icon: "copy",
      keywords: ["copy data source"],
      run: ({ arg }) => {
        const src = sourceOf(nodeFrom(arg));
        if (src?.id) void duplicateSource(src.id);
      },
    }),
    tree({
      id: "db.ddlToClipboard",
      title: "Generate DDL to Clipboard",
      icon: "copy",
      keywords: ["create table", "sql script"],
      run: async ({ arg }) => {
        const n = nodeFrom(arg);
        const ddl = n && (await ddlOf(n));
        if (ddl) await copy(ddl.text, "DDL");
      },
    }),
    tree({
      id: "db.ddlToConsole",
      title: "Generate DDL to Query Console",
      icon: "db-console",
      keywords: ["create table", "sql script"],
      run: async ({ arg }) => {
        const n = nodeFrom(arg);
        const ddl = n && (await ddlOf(n));
        if (ddl) await openConsoleWith(ddl.id, ddl.text);
      },
    }),
    tree({
      id: "db.runSqlScript",
      title: "Run SQL Script…",
      icon: "run",
      keywords: ["execute file", "import sql"],
      run: ({ arg }) => {
        const n = nodeFrom(arg);
        const { sources } = useDatabase.getState();
        const id = (n && nodeTarget(n)) ?? (sources.length === 1 ? sources[0]!.id : null);
        if (id) void runScriptFile(id);
      },
    }),
    tree({
      id: "db.sqlScript",
      title: "SQL Script Template",
      hidden: true,
      run: ({ arg }) => {
        const a = (arg ?? {}) as { node?: DbNode; kind?: ScriptKind };
        const n = a.node ?? useDatabase.getState().selectedNode;
        if (n && a.kind) void insertScript(n, a.kind);
      },
    }),
    tree({
      id: "db.goToReferencedTable",
      title: "Go to Referenced Table",
      keywords: ["foreign key"],
      run: ({ arg }) => {
        const n = nodeFrom(arg);
        if (n?.kind === "foreignKey") void revealInTree(n.id, n.fk.refSchema, n.fk.refTable, "table");
      },
    }),
    tree({
      id: "db.new",
      title: "New…",
      icon: "plus",
      keywords: ["query console", "data source"],
      run: () => {
        toolWindowService().show(DB_TOOL_WINDOW, false);
        useDatabase.setState({ newMenuOpen: true });
      },
    }),
    tree({
      id: "db.collapseAll",
      title: "Collapse All",
      icon: "collapse-all",
      run: () => useDatabase.setState({ treeExpanded: new Set() }),
    }),
  ]);
}
