/**
 * Database tools (IDEA's Database tool window, scoped): data sources for
 * SQLite / PostgreSQL / MySQL-MariaDB, a schema tree, query consoles with
 * results grids, and a table data editor. Connections, introspection and
 * statements run in Rust (`ide-db`).
 */
import { lazyComponent } from "@/ui";
import { activeEditor, registerEditorContribution } from "@/editor/api";
import { registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import {
  registerEditorKind,
  registerOverlay,
  registerServiceView,
  registerToolWindow,
  setFileDecorations,
  toolWindowService,
} from "@/workbench/contributions";
import { SQL_LANGUAGE, consoleExtension, executeInView, explainInView } from "./console";
import { DatabaseDialogs } from "./Dialogs";
import { TABLE_KIND, tableTitle } from "./tableInput";
import { nodeTarget, type DbNode } from "./nodes";
import { registerDatabaseTreeActions } from "./treeActions";
import {
  DB_TOOL_WINDOW,
  RESULTS_VIEW,
  consoleSource,
  consoleTints,
  loadSources,
  openConsole,
  openHistory,
  openSourceDialog,
  useDatabase,
  watchIdleConnections,
} from "./store";

export function activate(): () => void {
  const disposers = [
    registerToolWindow({
      id: DB_TOOL_WINDOW,
      title: "Database",
      icon: "toolwindow-database",
      anchor: "right",
      order: 20,
      component: lazyComponent(() => import("./DatabaseView").then((m) => m.DatabaseView)),
      headerActions: lazyComponent(() => import("./DatabaseView").then((m) => m.DatabaseHeaderActions)),
    }),
    registerServiceView({
      id: RESULTS_VIEW,
      title: "Database",
      icon: "database",
      order: 20,
      onUse: true,
      component: lazyComponent(() => import("./ResultsView").then((m) => m.ResultsView)),
    }),
    registerEditorKind({
      kind: TABLE_KIND,
      component: lazyComponent(() => import("./TableEditor").then((m) => m.TableEditor)),
      title: tableTitle,
      icon: () => "database",
    }),
    registerOverlay({ id: "database.dialogs", component: DatabaseDialogs }),
    registerEditorContribution({ id: "database.console", order: 57, extensions: consoleExtension }),
    // A reopened project starts with a fresh backend: forget the old one's state.
    useProject.subscribe((s, prev) => {
      if (s.project?.root === prev.project?.root) return;
      useDatabase.setState({
        sources: [],
        loaded: false,
        connected: new Set(),
        databases: {},
        schemas: {},
        tables: {},
        details: {},
        objects: {},
        completion: {},
        results: [],
        output: [],
        activeResult: null,
        selectedSource: null,
        selectedNode: null,
        treeExpanded: new Set(),
        treeReveal: null,
        manualCommit: new Set(),
        pendingTx: new Set(),
        running: {},
        dialog: null,
        newMenuOpen: false,
      });
    }),
    // Consoles of coloured data sources get a tinted tab.
    useDatabase.subscribe((s, prev) => {
      if (s.consoles !== prev.consoles || s.sources !== prev.sources) setFileDecorations("database", consoleTints(s));
    }),
    () => setFileDecorations("database", new Map()),
    watchIdleConnections(),
    registerDatabaseTreeActions(),
    registerActions([
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
        id: "db.newDataSource",
        title: "New Data Source…",
        category: "Tools",
        icon: "plus",
        keywords: ["database", "connection", "postgres", "mysql", "sqlite"],
        when: "projectOpen",
        run: async () => {
          if (!useDatabase.getState().loaded) await loadSources();
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
          const s = useDatabase.getState();
          if (!s.loaded) await loadSources();
          const { sources, selectedSource } = useDatabase.getState();
          // A tree node (New ▸ Query Console) opens its data source's console.
          const node = arg && typeof arg === "object" && "kind" in arg ? nodeTarget(arg as DbNode) : null;
          const id = node ?? selectedSource ?? (sources.length === 1 ? sources[0]!.id : null);
          if (id) await openConsole(id);
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
          const e = activeEditor();
          if (!e || e.ctx.language !== SQL_LANGUAGE) return;
          if (!useDatabase.getState().loaded) await loadSources();
          if (!consoleSource(e.ctx.path) && !useDatabase.getState().sources.length) {
            openSourceDialog(null);
            return;
          }
          await executeInView(e.view, e.ctx.path);
        },
      },
      {
        id: "db.explainPlan",
        title: "Explain Plan",
        category: "Tools",
        icon: "db-plan",
        keywords: ["query plan", "explain", "sql"],
        when: `editorTextFocus && editorLangId == ${SQL_LANGUAGE}`,
        run: async () => {
          const e = activeEditor();
          if (!e || e.ctx.language !== SQL_LANGUAGE) return;
          if (!useDatabase.getState().loaded) await loadSources();
          await explainInView(e.view, e.ctx.path);
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
          if (!useDatabase.getState().loaded) await loadSources();
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
  return () => disposers.reverse().forEach((d) => d());
}
