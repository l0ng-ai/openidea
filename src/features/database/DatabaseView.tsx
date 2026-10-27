/**
 * Database tool window (IDEA's layout): data source → database (PostgreSQL) → schema → `tables` /
 * `views` / `materialized views` / `routines` / `sequences` folders → table → `columns` / `keys` /
 * `foreign keys` / `indexes` / `triggers`,
 * with counts and column types, loaded lazily. Double-click a table to open its data, a data
 * source to open its query console.
 */
import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import type { DbDatabases, DbTableDetails } from "@/platform/ipc";
import { setContext } from "@/platform/context";
import { executeAction } from "@/platform/actions";
import { shortcutLabel } from "@/platform/keymap";
import {
  Button,
  EmptyState,
  Icon,
  IconButton,
  Menu,
  Tree,
  showContextMenu,
  tooltipAttrs,
  type TreeHandle,
  T,
} from "@/ui";
import { colorVar, databaseKey, passesObjectFilter, shownNames, sourceIcon, splitTarget, targetOf } from "./model";
import { nodeTarget, schemaObjectOf, tableFolder, type DbNode as Node, type Folder, type Group } from "./nodes";
import {
  connect,
  detailsKey,
  listsDatabases,
  loadDatabases,
  loadDetails,
  loadSchemas,
  loadSources,
  loadTables,
  openConsole,
  openObjectDdl,
  tablesKey,
  useDatabase,
  type Loaded,
} from "./store";
import { DB_VIEW_FOCUS, openTableData } from "./treeActions";
import { newMenu, nodeMenu } from "./treeMenu";
import styles from "./Database.module.css";

const GROUP_LABELS: Record<Group, string> = {
  columns: "columns",
  keys: "keys",
  foreignKeys: "foreign keys",
  indexes: "indexes",
  triggers: "triggers",
};

const FOLDER_LABELS: Record<Folder, string> = {
  tables: "tables",
  views: "views",
  materializedViews: "materialized views",
  routines: "routines",
  sequences: "sequences",
};

const FOLDERS: readonly Folder[] = ["tables", "views", "materializedViews", "routines", "sequences"];

function status<T>(key: string, l: Loaded<T> | undefined, map: (v: T) => Node[]): Node[] | undefined {
  if (!l) return undefined;
  if (l.status === "loading") return undefined;
  if (l.status === "error") return [{ kind: "message", key: `${key}/err`, text: l.message, error: true }];
  const nodes = map(l.value);
  return nodes.length ? nodes : [{ kind: "message", key: `${key}/empty`, text: "Empty" }];
}

const primaryKey = (d: DbTableDetails) => d.columns.filter((c) => c.primaryKey).map((c) => c.name);

/** Rows under a table: IDEA's columns / keys / foreign keys / indexes folders (empty ones left out). */
function groupsOf(d: DbTableDetails): Group[] {
  const g: Group[] = ["columns"];
  if (primaryKey(d).length) g.push("keys");
  if (d.foreignKeys.length) g.push("foreignKeys");
  if (d.indexes.length) g.push("indexes");
  if (d.triggers.length) g.push("triggers");
  return g;
}

function groupSize(d: DbTableDetails, g: Group): number {
  if (g === "columns") return d.columns.length;
  if (g === "keys") return primaryKey(d).length ? 1 : 0;
  if (g === "foreignKeys") return d.foreignKeys.length;
  if (g === "triggers") return d.triggers.length;
  return d.indexes.length;
}

export function DatabaseView() {
  const st = useDatabase();
  const tree = useRef<TreeHandle>(null);
  useEffect(() => {
    if (!st.loaded) void loadSources();
  }, [st.loaded]);
  // Go to Declaration from a console: the rows exist once the expanded nodes render.
  useEffect(() => {
    if (!st.treeReveal) return;
    const key = st.treeReveal.key;
    const frame = requestAnimationFrame(() => {
      tree.current?.reveal(key);
      tree.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [st.treeReveal]);

  const roots = useMemo<Node[]>(
    () => st.sources.map((source) => ({ kind: "source", key: source.id ?? "", source })),
    [st.sources],
  );

  /** Schemas tab › Object filter of the data source of target `id`. */
  const shown = (id: string) => {
    const filter = sourceOf(id)?.introspection?.objectFilter;
    return (o: { name: string }) => passesObjectFilter(o.name, filter);
  };
  const tablesOf = (id: string, schema: string) => {
    const t = st.tables[tablesKey(id, schema)];
    return t?.status === "ok" ? t.value.filter(shown(id)) : null;
  };
  const routinesOf = (id: string, schema: string) =>
    (st.objects[tablesKey(id, schema)]?.routines ?? []).filter(shown(id));
  const sequencesOf = (id: string, schema: string) =>
    (st.objects[tablesKey(id, schema)]?.sequences ?? []).filter(shown(id));
  /** Members of a schema folder: tables / views / materialized views, routines or sequences. */
  const folderSize = (id: string, schema: string, folder: Folder): number => {
    if (folder === "routines") return routinesOf(id, schema).length;
    if (folder === "sequences") return sequencesOf(id, schema).length;
    return (tablesOf(id, schema) ?? []).filter((t) => tableFolder(t.kind) === folder).length;
  };
  const detailsOf = (id: string, schema: string, table: string) => {
    const d = st.details[detailsKey(id, schema, table)];
    return d?.status === "ok" ? d.value : null;
  };

  const sourceOf = (target: string) => st.sources.find((s) => s.id === splitTarget(target).id);
  /** The Schemas tab's choice. */
  const shownSchemas = (target: string, names: string[]) => {
    const i = sourceOf(target)?.introspection;
    return shownNames(names, i?.allSchemas, i?.schemas);
  };
  const shownDatabases = (id: string, v: DbDatabases) => {
    const i = sourceOf(id)?.introspection;
    return shownNames(v.names, i?.allDatabases, i?.databases, v.current);
  };

  const schemasOf = (key: string, id: string) =>
    status(key, st.schemas[id], (v) =>
      shownSchemas(id, v).map((schema) => ({ kind: "schema", key: `${id}/${schema}`, id, schema }) as Node),
    );

  const children = (n: Node): readonly Node[] | undefined => {
    switch (n.kind) {
      case "source": {
        const id = n.source.id ?? "";
        if (listsDatabases(n.source))
          return status(n.key, st.databases[id], (v) =>
            shownDatabases(id, v).map((name) => ({
              kind: "database",
              key: databaseKey(id, name),
              id: targetOf(id, name, v.current),
              name,
              current: name === v.current,
            })),
          );
        return schemasOf(n.key, id);
      }
      case "database":
        return schemasOf(n.key, n.id);
      case "schema":
        return status(n.key, st.tables[tablesKey(n.id, n.schema)], () =>
          FOLDERS.filter((f) => folderSize(n.id, n.schema, f) > 0).map((folder): Node => ({
            kind: "folder",
            key: `${n.key}/${folder}`,
            id: n.id,
            schema: n.schema,
            folder,
          })),
        );
      case "folder": {
        const at = { id: n.id, schema: n.schema };
        if (n.folder === "routines")
          // Overloads share a name: the key tells them apart by their arguments.
          return routinesOf(n.id, n.schema).map((routine) => ({
            kind: "routine",
            key: `${n.key}/${routine.name}(${routine.arguments})`,
            routine,
            ...at,
          }));
        if (n.folder === "sequences")
          return sequencesOf(n.id, n.schema).map((sequence) => ({
            kind: "sequence",
            key: `${n.key}/${sequence.name}`,
            sequence,
            ...at,
          }));
        return (tablesOf(n.id, n.schema) ?? [])
          .filter((t) => tableFolder(t.kind) === n.folder)
          .map((table) => ({ kind: "table", key: `${n.key}/${table.name}`, table, ...at }));
      }
      case "table": {
        const d = st.details[detailsKey(n.id, n.schema, n.table.name)];
        if (!d || d.status === "loading") return undefined;
        if (d.status === "error") return [{ kind: "message", key: `${n.key}/err`, text: d.message, error: true }];
        return groupsOf(d.value).map((group) => ({
          kind: "group",
          key: `${n.key}/${group}`,
          id: n.id,
          schema: n.schema,
          table: n.table.name,
          group,
        }));
      }
      case "group": {
        const d = detailsOf(n.id, n.schema, n.table);
        if (!d) return undefined;
        const fkCols = new Set(d.foreignKeys.flatMap((k) => k.columns));
        const at = { id: n.id, schema: n.schema, table: n.table };
        switch (n.group) {
          case "columns":
            return d.columns.map((column) => ({
              kind: "column",
              key: `${n.key}/${column.name}`,
              column,
              foreignKey: fkCols.has(column.name),
              ...at,
            }));
          case "keys":
            return [{ kind: "key", key: `${n.key}/pk`, columns: primaryKey(d), ...at }];
          case "foreignKeys":
            return d.foreignKeys.map((fk, i) => ({ kind: "foreignKey", key: `${n.key}/${i}`, fk, ...at }));
          case "indexes":
            return d.indexes.map((index) => ({ kind: "index", key: `${n.key}/${index.name}`, index, ...at }));
          case "triggers":
            return d.triggers.map((trigger) => ({ kind: "trigger", key: `${n.key}/${trigger.name}`, trigger, ...at }));
        }
        return undefined;
      }
      default:
        return undefined;
    }
  };

  const load = async (n: Node) => {
    if (n.kind === "source") {
      const id = n.source.id ?? "";
      if (!(await connect(id))) return;
      if (listsDatabases(n.source)) await loadDatabases(id);
      else await loadSchemas(id);
    } else if (n.kind === "database") {
      if (await connect(n.id)) await loadSchemas(n.id);
    } else if (n.kind === "schema") await loadTables(n.id, n.schema);
    else if (n.kind === "table") await loadDetails(n.id, n.schema, n.table.name);
  };

  const label = (n: Node): string => {
    switch (n.kind) {
      case "source":
        return n.source.name ?? "";
      case "database":
        return n.name;
      case "schema":
        return n.schema;
      case "folder":
        return FOLDER_LABELS[n.folder];
      case "routine":
        return n.routine.name;
      case "sequence":
        return n.sequence.name;
      case "trigger":
        return n.trigger.name;
      case "table":
        return n.table.name;
      case "group":
        return GROUP_LABELS[n.group];
      case "column":
        return n.column.name;
      // Unnamed (SQLite) keys are numbered like IDEA's `key #1` / `foreign-key #1`.
      case "key":
        return "key #1";
      case "foreignKey":
        return `foreign-key #${Number(n.key.slice(n.key.lastIndexOf("/") + 1)) + 1}`;
      case "index":
        return n.index.name;
      case "message":
        return n.text;
    }
  };

  /** Grey text after the label: counts, column types, key columns. */
  const detail = (n: Node): string | undefined => {
    switch (n.kind) {
      case "source": {
        const id = n.source.id ?? "";
        if (listsDatabases(n.source)) {
          const d = st.databases[id];
          return d?.status === "ok" ? String(shownDatabases(id, d.value).length) : undefined;
        }
        const s = st.schemas[id];
        return s?.status === "ok" ? String(shownSchemas(id, s.value).length) : undefined;
      }
      case "database": {
        const s = st.schemas[n.id];
        return s?.status === "ok" ? String(shownSchemas(n.id, s.value).length) : undefined;
      }
      case "folder":
        return String(folderSize(n.id, n.schema, n.folder));
      case "routine":
        return `(${n.routine.arguments})${n.routine.returns ? `: ${n.routine.returns}` : ""}`;
      case "sequence":
        return n.sequence.dataType;
      case "trigger":
        return `${n.trigger.timing} ${n.trigger.events}`.trim();
      case "group": {
        const d = detailsOf(n.id, n.schema, n.table);
        return d ? String(groupSize(d, n.group)) : undefined;
      }
      case "column":
        return n.column.dataType;
      case "key":
        return `(${n.columns.join(", ")})`;
      case "foreignKey":
        return `(${n.fk.columns.join(", ")}) → ${n.fk.refTable} (${n.fk.refColumns.join(", ")})`;
      case "index":
        return `${n.index.unique ? "unique " : ""}(${n.index.columns.join(", ")})`;
      default:
        return undefined;
    }
  };

  const icon = (n: Node): string | undefined => {
    switch (n.kind) {
      case "source":
        return sourceIcon(n.source);
      case "database":
        return "database";
      case "schema":
        return "db-schema";
      case "folder":
      case "group":
        return "db-folder";
      case "table":
        return n.table.kind === "view" ? "db-view" : n.table.kind === "materializedView" ? "db-matview" : "db-table";
      case "routine":
        return "db-routine";
      case "sequence":
        return "db-sequence";
      case "trigger":
        return "db-trigger";
      case "column":
        return n.column.primaryKey ? "db-column-key" : n.foreignKey ? "db-column-fk" : "db-column";
      case "key":
        return "db-key";
      case "foreignKey":
        return "db-foreign-key";
      case "index":
        return "db-index";
      case "message":
        return n.error ? "error" : undefined;
    }
  };

  if (st.loaded && !st.sources.length)
    return (
      <div className={styles.dbView}>
        <DatabaseToolbar />
        <EmptyState title="No data sources">
          <Button variant="ghost" onClick={() => void executeAction("db.newDataSource")}>
            <T>New Data Source…</T>
          </Button>
        </EmptyState>
      </div>
    );

  return (
    <div className={styles.dbView}>
      <DatabaseToolbar />
      <div
        className={styles.treeHost}
        onFocus={(e) => setContext(DB_VIEW_FOCUS, (e.target as HTMLElement).getAttribute("role") === "tree")}
        onBlur={() => setContext(DB_VIEW_FOCUS, false)}
      >
        <Tree<Node>
          aria-label="Data sources"
          roots={roots}
          handleRef={tree}
          expanded={st.treeExpanded}
          onExpandedChange={(treeExpanded) => useDatabase.setState({ treeExpanded })}
          getKey={(n) => n.key}
          getLabel={label}
          getChildren={children}
          isExpandable={(n) =>
            n.kind === "source" ||
            n.kind === "database" ||
            n.kind === "schema" ||
            n.kind === "folder" ||
            n.kind === "table" ||
            n.kind === "group"
          }
          loadChildren={load}
          getIcon={(n) => icon(n)}
          getDetail={detail}
          getColor={(n) => (n.kind === "message" && n.error ? "var(--danger)" : undefined)}
          renderNode={(n: Node) => {
            const i = icon(n);
            const d = detail(n);
            const counted = n.kind === "source" || n.kind === "database" || n.kind === "folder" || n.kind === "group";
            const labelClass =
              n.kind === "message" && n.error
                ? styles.treeError
                : n.kind === "key" || n.kind === "foreignKey"
                  ? styles.keyLabel
                  : styles.nodeLabel;
            const live = n.kind === "source" && [...st.connected].some((t) => splitTarget(t).id === n.source.id);
            const target = nodeTarget(n);
            // IDEA tints every row of a coloured data source.
            const tint = colorVar(target ? sourceOf(target)?.color : null);
            return (
              <span
                className={tint ? `${styles.nodeRow} ${styles.tinted}` : styles.nodeRow}
                style={tint ? ({ "--db-tint": tint } as CSSProperties) : undefined}
                title={n.kind === "source" && n.source.comment ? n.source.comment : undefined}
              >
                {i && (
                  <span className={styles.nodeIcon}>
                    <Icon name={i} size={16} />
                    {/* IDEA: a green dot on the data source icon while connected. */}
                    {live && <span className={styles.connectedDot} title="Connected" />}
                  </span>
                )}
                <span className={labelClass}>{label(n)}</span>
                {d && (
                  <span
                    className={
                      n.kind === "source"
                        ? styles.treeBadge
                        : counted
                          ? styles.treeCount
                          : n.kind === "column"
                            ? styles.treeType
                            : styles.treeDetail
                    }
                  >
                    {d}
                  </span>
                )}
              </span>
            );
          }}
          onSelectionChange={(_, lead) =>
            useDatabase.setState({ selectedSource: lead ? nodeTarget(lead) : null, selectedNode: lead })
          }
          onActivate={(n) => {
            if (n.kind === "table") openTableData(n.id, n.schema, n.table.name);
            else if (n.kind === "source") void openConsole(n.source.id ?? "");
            else if (n.kind === "database") void openConsole(n.id);
            else {
              const o = schemaObjectOf(n);
              if (o) void openObjectDdl(o.id, o.schema, o.kind, o.name);
            }
          }}
          activateExpandable={(n) => n.kind === "table"}
          onContextMenu={(n, _sel, e) => {
            const items = nodeMenu(n);
            if (items.length) showContextMenu(e, items);
          }}
          speedSearch
        />
      </div>
    </div>
  );
}

/**
 * The toolbar row of IDEA's Database tool window, always shown under the
 * title: New ▸, Properties | Refresh, Deactivate | Jump to Query Console,
 * Edit Data, DDL.
 */
function DatabaseToolbar() {
  const node = useDatabase((s) => s.selectedNode);
  const connected = useDatabase((s) => s.connected);
  const sources = useDatabase((s) => s.sources);
  const plus = useRef<HTMLButtonElement>(null);
  const newOpen = useDatabase((s) => s.newMenuOpen);
  const setNewOpen = (v: boolean) => useDatabase.setState({ newMenuOpen: v });
  const table = node?.kind === "table" || node?.kind === "column" || node?.kind === "group";
  const target = node ? nodeTarget(node) : sources.length === 1 ? (sources[0]!.id ?? null) : null;
  const active = !!target && [...connected].some((t) => splitTarget(t).id === splitTarget(target).id);
  const button = { size: "small", iconSize: 16 } as const;
  return (
    <div className={styles.dbToolbar} role="toolbar" aria-label="Database actions">
      <IconButton
        ref={plus}
        {...button}
        icon="db-add"
        title="New"
        shortcut={shortcutLabel("db.new")}
        aria-haspopup="menu"
        aria-expanded={newOpen}
        onClick={() => setNewOpen(!newOpen)}
      />
      <Menu
        open={newOpen}
        anchor={plus}
        items={newMenu()}
        placement="bottom-start"
        onClose={() => setNewOpen(false)}
        aria-label="New"
      />
      <IconButton {...button} icon="db-properties" action="db.properties" disabled={!sources.length} />
      <span className={styles.dbToolbarSep} />
      <IconButton {...button} icon="refresh" action="db.refresh" disabled={!sources.length} />
      <IconButton {...button} icon="db-disconnect" action="db.disconnect" disabled={node ? !active : !connected.size} />
      <span className={styles.dbToolbarSep} />
      <IconButton {...button} icon="db-console" action="db.jumpToConsole" disabled={!target} />
      <IconButton {...button} icon="db-table" action="db.editData" disabled={!table} />
      {/* IDEA labels this one with text. */}
      <button
        type="button"
        className={styles.textTool}
        aria-label="Go to DDL"
        disabled={!table}
        onClick={() => void executeAction("db.goToDdl")}
        {...tooltipAttrs("Go to DDL", shortcutLabel("db.goToDdl"))}
      >
        <T>DDL</T>
      </button>
    </div>
  );
}

/** Header controls (shown on hover, like IDEA's): Collapse All. */
export function DatabaseHeaderActions() {
  return <IconButton icon="collapse-all" action="db.collapseAll" size="small" iconSize={16} />;
}
