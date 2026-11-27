/**
 * Database tools (IDEA's Database tool window, scoped): data sources for
 * SQLite / PostgreSQL / MySQL-MariaDB, a schema tree, query consoles with
 * results grids, and a table data editor. Connections, introspection and
 * statements run in Rust (`ide-db`).
 */
import { lazyComponent, lazyWhen, type MenuItem } from "@/ui";
import { activeEditor, lazyEditorExtension, registerEditorContribution } from "@/editor/api";
import { onFileOperation } from "@/platform/fileOps";
import { tx } from "@/platform/i18n";
import { call, commands, emitLocalIdeEvent, onIdeEvent } from "@/platform/ipc";
import { registerActions, type ActionContext } from "@/platform/actions";
import { activeCellGrid } from "./cellActions";
import {
  activeTableEditor,
  focusedTableEditor,
  installTableEditorFocus,
  type TableCommand,
  type TableCommandTarget,
} from "./tableEditorFocus";
import { useProject } from "@/platform/project";
import { projectLocation, useRemote } from "@/platform/remote";
import {
  editorService,
  registerEditorKind,
  registerOverlay,
  registerProjectViewRoot,
  registerServiceView,
  registerTextEditorWrapper,
  registerToolWindow,
  setFileDecorations,
  toolWindowService,
} from "@/workbench/contributions";
import { installCellActions } from "./cellActions";
import { installValueEditorActions } from "./valueEditorActions";
import { registerResultTabActions } from "./resultTabActions";
import { SQL_LANGUAGE } from "./sqlLanguage";
import { TABLE_KIND, tableTitle } from "./tableInput";
import { DIAGRAM_KIND, diagramTitle } from "./erDiagram";
import { isCsvPath } from "./csv";
import { registerCsvLiveSource, useCsvSourceHidden } from "./csvModes";
import { databaseRequest, projectRequest } from "./requests";
import { nodeSchema, nodeTarget, type DbNode } from "./nodes";
import { registerDatabaseTreeActions } from "./treeActions";
import {
  DB_TOOL_WINDOW,
  RESULTS_VIEW,
  consoleSource,
  consoleDecorations,
  inEditorResults,
  setInEditorResults,
  loadSources,
  loadSourceFolders,
  connect,
  loadSchemas,
  loadDatabases,
  listsDatabases,
  sourceById,
  newConsole,
  openConsole,
  openHistory,
  openSourceDialog,
  useDatabase,
  watchIdleConnections,
} from "./store";

/**
 * The schema a console opened for `id` starts in: the invoking node's, else the selected tree
 * node's while it is on the same connection target (#6329).
 */
function consoleStartSchema(arg: unknown, id: string): string | undefined {
  const of = (n: unknown) => {
    if (!n || typeof n !== "object" || !("kind" in n)) return null;
    const node = n as DbNode;
    return nodeTarget(node) === id ? nodeSchema(node) : null;
  };
  return of(arg) ?? of(useDatabase.getState().selectedNode) ?? undefined;
}

function useDatabaseHeaderMenu(): MenuItem[] {
  const separate = useDatabase((s) => s.separateProceduresAndFunctions);
  const comments = useDatabase((s) => s.showTableComments);
  return [
    { kind: "action", action: "db.separateProceduresAndFunctions", checked: separate },
    { kind: "action", action: "db.showTableComments", checked: comments },
  ];
}

const useDialogOpen = () => useDatabase((s) => !!s.dialog);

/** Table editor / result grid commands as actions (IDEA's data editor actions). */
const TABLE_COMMANDS: Array<[TableCommand, string, string, string[]]> = [
  ["reload", "db.reloadPage", "Reload Page", ["refresh", "rerun"]],
  ["firstPage", "db.firstPage", "First Page", ["pagination"]],
  ["previousPage", "db.previousPage", "Previous Page", ["pagination"]],
  ["nextPage", "db.nextPage", "Next Page", ["pagination"]],
  ["lastPage", "db.lastPage", "Last Page", ["pagination"]],
  ["addRow", "db.addRow", "Add Row", ["insert row", "new row"]],
  ["exportData", "db.exportData", "Export Data", ["export", "save as"]],
  ["deleteRows", "db.deleteRows", "Delete Rows", ["remove rows"]],
  ["restoreRows", "db.restoreRows", "Restore Rows", ["undelete rows"]],
  ["revertRows", "db.revertSelected", "Revert Selected", ["revert rows", "discard row changes", "undo"]],
];

/** The editor and rows a menu passed (focus has moved to the menu), else the focused grid's. */
function tableTarget(arg: unknown): TableCommandTarget {
  if (arg && typeof arg === "object" && "rows" in arg) return arg as TableCommandTarget;
  return { rows: activeCellGrid()?.selectedRows() ?? [], editor: null };
}

/** The Database window, on the stripe by default only while the project has data sources. */
function registerDatabaseWindow(): () => void {
  let withSources: boolean | null = null;
  let dispose = () => {};
  const sync = (next: boolean) => {
    if (next === withSources) return;
    withSources = next;
    // Registering the same id again replaces the contribution in place.
    dispose = registerToolWindow({
      id: DB_TOOL_WINDOW,
      title: "Database",
      icon: "toolwindow-database",
      anchor: "right",
      order: 20,
      ...(next ? {} : { stripe: "onUse" as const }),
      component: lazyComponent(() => import("./DatabaseView").then((m) => m.DatabaseView)),
      headerMenu: useDatabaseHeaderMenu,
      headerActions: lazyComponent(() => import("./DatabaseView").then((m) => m.DatabaseHeaderActions)),
    });
  };
  // Until the window loads the sources, a quiet probe decides; a failed one leaves it under "…".
  let probe = 0;
  const check = () => {
    const seq = ++probe;
    sync(false);
    if (!useProject.getState().project) return;
    Promise.resolve()
      .then(() => call(commands.dbSources()))
      .then(
        (sources) => seq === probe && !useDatabase.getState().loaded && sync(sources.length > 0),
        () => {},
      );
  };
  check();
  const offSources = useDatabase.subscribe((s) => {
    if (s.loaded) sync(s.sources.length > 0 || (s.foldersLoaded && s.folders.length > 0));
  });
  const offProject = useProject.subscribe((s, prev) => {
    if (s.project?.root !== prev.project?.root) check();
  });
  return () => {
    probe++;
    offSources();
    offProject();
    dispose();
  };
}

export function activate(): () => void {
  let disposed = false;
  let unregisterConsolesRoot = () => {};
  let consolesDir: string | null = null;
  let consolesRootGeneration = 0;
  const registerConsolesRoot = () => {
    const current = ++consolesRootGeneration;
    unregisterConsolesRoot();
    unregisterConsolesRoot = () => {};
    consolesDir = null;
    void call(commands.dbConsolesDir())
      .then((path) => {
        if (disposed || current !== consolesRootGeneration) return;
        consolesDir = path;
        unregisterConsolesRoot = registerProjectViewRoot({
          id: "db-consoles",
          label: tx("Database Consoles"),
          icon: "db-folder",
          path,
          order: 20,
          scope: "scratches",
        });
      })
      .catch((e: unknown) => console.warn("database consoles: no consoles folder", e));
  };
  registerConsolesRoot();
  const disposers = [
    useRemote.subscribe((state, previous) => {
      if (state.session !== previous.session) registerConsolesRoot();
    }),
    onFileOperation((op) => {
      const removed =
        consolesDir && op.kind === "deleted"
          ? op.paths.filter((path) => path === consolesDir || path.startsWith(`${consolesDir}/`))
          : [];
      if (removed.length) emitLocalIdeEvent({ type: "fsChanged", created: [], modified: [], removed });
    }),
    onIdeEvent("dbSourcesChanged", () => {
      void loadSources();
      void loadSourceFolders();
    }),
    registerDatabaseWindow(),
    registerServiceView({
      id: RESULTS_VIEW,
      title: "Database",
      icon: "database",
      order: 20,
      onUse: true,
      component: lazyComponent(() => import("./ResultsView").then((m) => m.ResultsView)),
    }),
    registerEditorKind({
      kind: "db-workspace",
      singleton: true,
      component: lazyComponent(() => import("./WorkspaceEditor").then((m) => m.WorkspaceEditor)),
      title: () => tx("Query Workspace"),
      icon: () => "database",
      keepAlive: true,
    }),
    registerEditorKind({
      kind: TABLE_KIND,
      component: lazyComponent(() => import("./TableEditor").then((m) => m.TableEditor)),
      title: tableTitle,
      icon: () => "database",
      // Switching tabs keeps the rows, filters, page and unsubmitted edits without querying again.
      keepAlive: true,
    }),
    registerTextEditorWrapper({
      id: "database.csv",
      matches: isCsvPath,
      component: lazyComponent(() => import("./CsvEditor").then((m) => m.CsvEditor)),
      useSourceHidden: useCsvSourceHidden,
    }),
    registerCsvLiveSource(),
    registerEditorKind({
      kind: DIAGRAM_KIND,
      component: lazyComponent(() => import("./DiagramView").then((m) => m.DiagramEditor)),
      title: diagramTitle,
      icon: () => "db-table",
    }),
    registerOverlay({
      id: "database.dialogs",
      component: lazyWhen(useDialogOpen, () => import("./Dialogs").then((m) => m.DatabaseDialogs)),
    }),
    registerEditorContribution({
      id: "database.console",
      order: 57,
      extensions: lazyEditorExtension(
        (ctx) => ctx.language === SQL_LANGUAGE && !ctx.virtual && !ctx.readOnly,
        () => import("./console").then((m) => m.consoleExtension),
      ),
    }),
    registerEditorContribution({
      id: "database.mybatis",
      order: 58,
      extensions: lazyEditorExtension(
        (ctx) => /\.xml$/i.test(ctx.path) && !ctx.virtual,
        () => import("./mybatis").then((m) => m.mapperExtension),
      ),
    }),
    // A reopened project starts with a fresh backend: forget the old one's state.
    useProject.subscribe((s, prev) => {
      if (s.project?.root === prev.project?.root) return;
      useDatabase.setState({
        sources: [],
        folders: [],
        loaded: false,
        foldersLoaded: false,
        connected: new Set(),
        databases: {},
        catalogs: {},
        schemas: {},
        tables: {},
        details: {},
        objects: {},
        completion: {},
        results: [],
        inline: [],
        output: [],
        activeResult: null,
        selectedSource: null,
        selectedNode: null,
        selectedNodes: [],
        treeExpanded: new Set(),
        treeReveal: null,
        manualCommit: new Set(),
        pendingTx: new Set(),
        running: {},
        executions: {},
        dialog: null,
        newMenuOpen: false,
        workspaceSettingsRequest: null,
      });
    }),
    useDatabase.subscribe((s, prev) => {
      if (s.consoles !== prev.consoles || s.sources !== prev.sources)
        setFileDecorations("database", consoleDecorations(s));
    }),
    () => setFileDecorations("database", new Map()),
    watchIdleConnections(),
    installTableEditorFocus(),
    installValueEditorActions(),
    installCellActions(),
    registerResultTabActions(),
    registerDatabaseTreeActions(),
    registerActions([
      {
        id: "db.pluginConnect",
        title: "Connect Plugin Data Source",
        category: "Tools",
        when: "projectOpen",
        run: async (e) => {
          if (!useProject.getState().project?.trusted)
            throw new Error(tx("Trust this project to connect plugin data sources"));
          const id = e.arg;
          if (typeof id !== "string") throw new Error(tx("Invalid data source id"));
          const project = projectRequest();
          await loadSources();
          if (!project()) return;
          const current = databaseRequest(id);
          toolWindowService().show(DB_TOOL_WINDOW, true);
          const connected = await connect(id);
          if (!current()) return;
          if (!connected) throw new Error(tx("Database connection failed"));
          if (listsDatabases(sourceById(id))) await loadDatabases(id);
          else await loadSchemas(id);
        },
      },
      {
        id: "db.showToolWindow",
        title: "Database",
        category: "Tools",
        icon: "toolwindow-database",
        keywords: ["data sources", "sql", "tables"],
        when: "projectOpen",
        run: () => toolWindowService().show(DB_TOOL_WINDOW, true),
      },
      {
        id: "db.queryWorkspace",
        title: "Query Workspace",
        category: "Tools",
        icon: "database",
        keywords: ["cross-database", "join", "workspace"],
        when: "projectOpen",
        run: async ({ arg }) => {
          const location = projectLocation(useProject.getState().project?.root);
          if (!location) return;
          const key = "db-workspace:" + location;
          const current = projectRequest();
          await editorService().openInput({ kind: "db-workspace", key }, { focus: true });
          if (arg === "configure" && current()) useDatabase.setState({ workspaceSettingsRequest: key });
        },
      },
      {
        id: "db.newDataSource",
        title: "New Data Source…",
        category: "Tools",
        icon: "plus",
        keywords: ["database", "connection", "postgres", "mysql", "sqlite"],
        when: "projectOpen",
        run: async () => {
          const current = projectRequest();
          if (!useDatabase.getState().loaded) await loadSources();
          if (!current()) return;
          openSourceDialog(null);
        },
      },
      {
        id: "db.openConsole",
        title: "Query Console",
        category: "Tools",
        icon: "file-sql",
        keywords: ["database", "sql console"],
        when: "projectOpen",
        run: async ({ arg }) => {
          const current = projectRequest();
          const s = useDatabase.getState();
          if (!s.loaded) await loadSources();
          if (!current()) return;
          const { sources, selectedSource } = useDatabase.getState();
          // A tree node (New ▸ Query Console) opens its data source's console.
          const node = arg && typeof arg === "object" && "kind" in arg ? nodeTarget(arg as DbNode) : null;
          const id = node ?? selectedSource ?? (sources.length === 1 ? sources[0]!.id : null);
          if (id) await openConsole(id, consoleStartSchema(arg, id));
          else toolWindowService().show(DB_TOOL_WINDOW, true);
        },
      },
      {
        id: "db.newConsole",
        title: "New Query Console",
        category: "Tools",
        icon: "db-console",
        keywords: ["database", "sql console"],
        when: "projectOpen",
        run: async ({ arg }) => {
          const current = projectRequest();
          if (!useDatabase.getState().loaded) await loadSources();
          if (!current()) return;
          const { sources, selectedSource } = useDatabase.getState();
          const node = arg && typeof arg === "object" && "kind" in arg ? nodeTarget(arg as DbNode) : null;
          const id = node ?? selectedSource ?? (sources.length === 1 ? sources[0]!.id : null);
          if (id) await newConsole(id, consoleStartSchema(arg, id));
          else toolWindowService().show(DB_TOOL_WINDOW, true);
        },
      },
      {
        id: "db.execute",
        title: "Execute SQL Statement",
        category: "Tools",
        icon: "run",
        when: `editorTextFocus && editorLangId == ${SQL_LANGUAGE}`,
        run: async () => {
          const current = projectRequest();
          const e = activeEditor();
          if (!e || e.ctx.language !== SQL_LANGUAGE) return;
          if (!useDatabase.getState().loaded) await loadSources();
          if (!current()) return;
          if (!consoleSource(e.ctx.path) && !useDatabase.getState().sources.length) {
            openSourceDialog(null);
            return;
          }
          await (await import("./console")).executeInView(e.view, e.ctx.path);
        },
      },
      {
        id: "db.toggleInEditorResults",
        title: "In-Editor Results",
        description: "Show query results in the editor, under the statements that produced them",
        category: "Tools",
        icon: "db-in-editor-results",
        keywords: ["inline", "results", "console", "grid"],
        toggled: () => inEditorResults(),
        run: () => setInEditorResults(!inEditorResults()),
      },
      {
        id: "db.executeScript",
        title: "Execute SQL Script",
        category: "Tools",
        icon: "gutter-run-all",
        keywords: ["run all", "whole file", "statements"],
        when: `editorTextFocus && editorLangId == ${SQL_LANGUAGE}`,
        run: async () => {
          const current = projectRequest();
          const e = activeEditor();
          if (!e || e.ctx.language !== SQL_LANGUAGE) return;
          if (!useDatabase.getState().loaded) await loadSources();
          if (!current()) return;
          if (!consoleSource(e.ctx.path) && !useDatabase.getState().sources.length) {
            openSourceDialog(null);
            return;
          }
          await (await import("./console")).executeScriptInView(e.view, e.ctx.path);
        },
      },
      {
        id: "db.goToColumn",
        title: "Go to Column",
        category: "Tools",
        keywords: ["table editor", "file structure", "columns"],
        when: "dbTableEditorFocus",
        run: () => activeTableEditor()?.showColumns(),
      },
      {
        id: "db.submitChanges",
        title: "Submit",
        category: "Tools",
        keywords: ["table editor", "apply changes", "commit"],
        when: "dbTableEditorFocus && dbTableEditorChanges",
        run: () => activeTableEditor()?.submit(),
      },
      {
        id: "db.revertChanges",
        title: "Revert",
        category: "Tools",
        keywords: ["table editor", "discard changes", "undo"],
        when: "dbTableEditorFocus && dbTableEditorChanges",
        run: () => activeTableEditor()?.revert(),
      },
      ...TABLE_COMMANDS.map(([command, id, title, keywords]) => ({
        id,
        title,
        category: "Tools",
        keywords: ["table editor", "data editor", ...keywords],
        keyWhen: "dbTableEditorFocus",
        enabled: ({ arg }: ActionContext) => {
          const { rows, editor } = tableTarget(arg);
          const handler = (editor ?? focusedTableEditor())?.commands?.[command];
          return !!handler && handler.enabled(rows);
        },
        run: ({ arg }: ActionContext) => {
          const { rows, editor } = tableTarget(arg);
          const handler = (editor ?? activeTableEditor())?.commands?.[command];
          if (handler?.enabled(rows)) handler.run(rows);
        },
      })),
      {
        id: "db.explainPlan",
        title: "Explain Plan",
        category: "Tools",
        icon: "db-plan",
        keywords: ["query plan", "explain", "sql"],
        when: `editorTextFocus && editorLangId == ${SQL_LANGUAGE}`,
        enabled: () => sourceById(consoleSource(activeEditor()?.ctx.path ?? ""))?.driver !== "jdbc",
        run: async () => {
          const current = projectRequest();
          const e = activeEditor();
          if (!e || e.ctx.language !== SQL_LANGUAGE) return;
          if (!useDatabase.getState().loaded) await loadSources();
          if (!current()) return;
          await (await import("./console")).explainInView(e.view, e.ctx.path);
        },
      },
      {
        id: "db.queryHistory",
        title: "Browse Query History",
        category: "Tools",
        icon: "history",
        keywords: ["database", "sql", "history"],
        when: "projectOpen",
        run: async () => {
          const current = projectRequest();
          if (!useDatabase.getState().loaded) await loadSources();
          if (!current()) return;
          const e = activeEditor();
          const path = e?.ctx.language === SQL_LANGUAGE ? e.ctx.path : null;
          const s = useDatabase.getState();
          const id =
            (path && consoleSource(path)) ?? s.selectedSource ?? (s.sources.length === 1 ? s.sources[0]!.id : null);
          openHistory(path, id ?? null);
        },
      },
    ]),
  ];
  return () => {
    disposed = true;
    consolesRootGeneration++;
    unregisterConsolesRoot();
    disposers.reverse().forEach((d) => d());
  };
}
