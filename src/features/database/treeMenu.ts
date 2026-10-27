/** Menus of the Database tool window, laid out like IDEA's (New ▸, Copy/Paste ▸, SQL Scripts ▸ …). */
import type { MenuItem } from "@/ui";
import { notifications } from "@/workbench/contributions";
import { fileSourceName, parseSourceUrl } from "./model";
import { VENDORS, vendorPreset } from "./vendors";
import { nodeTarget, objectOf, tableOf, type DbNode } from "./nodes";
import { SCRIPT_LABELS, canDrop, canRename, type ScriptKind } from "./objects";
import { connectedTargets, openDialog, openSourceDialog, sourceById, useDatabase } from "./store";

const act = (
  action: string,
  node: DbNode | null,
  extra: Partial<{ label: string; disabled: boolean; icon: string }> = {},
): MenuItem => ({
  kind: "action",
  action,
  arg: node ?? undefined,
  ...extra,
});

const sep: MenuItem = { kind: "separator" };

async function sqliteFromFile() {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const file = await open({ multiple: false, directory: false, title: "SQLite Database File" });
  if (typeof file === "string") openSourceDialog(null, { driver: "sqlite", file, name: fileSourceName(file) });
}

/** New ▸ Data Source ▸ — the drivers the backend speaks and wire-compatible products, A–Z like IDEA's. */
function dataSourceItems(): MenuItem[] {
  return [
    {
      label: "Data Source",
      icon: "database",
      submenu: VENDORS.map((v) => ({
        label: v.label,
        icon: v.icon,
        run: () => openSourceDialog(null, vendorPreset(v)),
      })),
    },
    { label: "Data Source from File…", icon: "folder", run: () => void sqliteFromFile() },
    { label: "Data Source from URL…", icon: "external-link", run: () => openDialog({ kind: "sourceUrl" }) },
    { label: "Import from Clipboard", icon: "paste", run: () => void sourceFromClipboard() },
  ];
}

/** New ▸ Import from Clipboard: a connection URL (JDBC or native) on the clipboard becomes a new data source. */
async function sourceFromClipboard() {
  let text = "";
  try {
    text = (await navigator.clipboard?.readText()) ?? "";
  } catch {
    // Unreadable clipboard: reported below like an unknown one.
  }
  const parsed = text.trim() ? parseSourceUrl(text.trim()) : null;
  if (parsed) openSourceDialog(null, parsed.source, parsed.password);
  else
    notifications().notify({
      level: "info",
      title: "No data source on the clipboard",
      body: "Copy a connection URL such as postgresql://user@host:5432/db or jdbc:sqlite:/path/app.db.",
      key: "db-clipboard",
    });
}

/** The toolbar's "+" menu (IDEA: New). */
export function newMenu(): MenuItem[] {
  return [{ kind: "action", action: "db.openConsole", label: "Query Console" }, sep, ...dataSourceItems()];
}

function sqlScripts(n: DbNode, table: boolean): MenuItem {
  const scripts: MenuItem[] = table
    ? (Object.keys(SCRIPT_LABELS) as ScriptKind[]).map((kind) => ({
        kind: "action",
        action: "db.sqlScript",
        arg: { node: n, kind },
        label: SCRIPT_LABELS[kind],
      }))
    : [act("db.runSqlScript", n)];
  return { label: "SQL Scripts", submenu: [act("db.ddlToClipboard", n), act("db.ddlToConsole", n), sep, ...scripts] };
}

/** Context menu of a tree node (`null`: the empty area). */
export function nodeMenu(n: DbNode | null): MenuItem[] {
  if (!n) return [{ label: "New", icon: "plus", submenu: newMenu() }];
  const id = nodeTarget(n) ?? "";
  const driver = sourceById(id)?.driver ?? "sqlite";
  const o = objectOf(n);
  const t = tableOf(n);
  const newConsole = act("db.openConsole", n, { label: "Query Console", icon: "db-console" });
  const refresh = act("db.refresh", n);
  const quickDoc = act("db.quickDoc", n);
  const rename = act("db.rename", n, { disabled: !(n.kind === "source" || (o && canRename(driver, o))) });
  const drop = act("db.drop", n, { disabled: !o || !canDrop(driver, o) });
  const copyRef = act("db.copyReference", n);
  const navigation = (extra: MenuItem[] = []): MenuItem => ({
    label: "Navigation",
    submenu: [...extra, act("db.jumpToConsole", n)],
  });

  switch (n.kind) {
    case "source": {
      const connected = connectedTargets(n.source.id ?? "").length > 0;
      return [
        act("db.properties", n, { label: "Properties" }),
        sep,
        { label: "New", icon: "plus", submenu: [newConsole, sep, ...dataSourceItems()] },
        { label: "Copy/Paste", submenu: [copyRef, act("db.duplicateSource", n)] },
        refresh,
        act("db.disconnect", n, { disabled: !connected }),
        sep,
        rename,
        sep,
        quickDoc,
        navigation(),
        sep,
        sqlScripts(n, false),
        sep,
        act("db.drop", n, { label: "Remove Data Source…" }),
      ];
    }
    case "database":
      return [
        { label: "New", icon: "plus", submenu: [newConsole] },
        { label: "Copy/Paste", submenu: [copyRef] },
        refresh,
        act("db.disconnect", n, { disabled: !useDatabase.getState().connected.has(id) || n.current }),
        sep,
        navigation(),
        sqlScripts(n, false),
      ];
    case "schema":
    case "folder":
      return [
        { label: "New", icon: "plus", submenu: [newConsole, sep, act("db.newTable", n)] },
        ...(n.kind === "schema" ? [{ label: "Copy/Paste", submenu: [copyRef] }] : []),
        refresh,
        sep,
        ...(n.kind === "schema" ? [quickDoc] : []),
        navigation(),
        sep,
        sqlScripts(n, false),
        ...(n.kind === "schema" ? [sep, drop] : []),
      ];
    case "table":
    case "column": {
      const view = !!t?.view;
      const column = n.kind === "column";
      return [
        {
          label: "New",
          icon: "plus",
          submenu: [newConsole, sep, act("db.newColumn", n, { disabled: view }), act("db.newTable", n)],
        },
        act("db.modifyTable", n, { label: column ? "Modify Column…" : "Modify Table…", disabled: view }),
        { label: "Copy/Paste", submenu: [copyRef] },
        act("db.editData", n),
        refresh,
        sep,
        rename,
        sep,
        quickDoc,
        navigation([act("db.goToDdl", n)]),
        sep,
        sqlScripts(n, true),
        ...(n.kind === "table" && !view
          ? [
              { label: "Import/Export", submenu: [act("db.importData", n)] },
              { label: "Object Actions", submenu: [act("db.truncate", n)] },
            ]
          : []),
        sep,
        drop,
      ];
    }
    case "index":
      return [
        { label: "Copy/Paste", submenu: [copyRef] },
        refresh,
        sep,
        rename,
        sep,
        navigation([act("db.goToDdl", n)]),
        sep,
        drop,
      ];
    case "foreignKey":
      return [refresh, sep, { label: "Navigation", submenu: [act("db.goToReferencedTable", n), act("db.goToDdl", n)] }];
    case "routine":
    case "sequence":
    case "trigger":
      return [
        { label: "Copy/Paste", submenu: [copyRef] },
        refresh,
        sep,
        quickDoc,
        navigation([act("db.goToDdl", n)]),
        { label: "SQL Scripts", submenu: [act("db.ddlToClipboard", n), act("db.ddlToConsole", n)] },
        sep,
        drop,
      ];
    case "group":
    case "key":
      return [
        ...(n.kind === "group" && n.group === "columns"
          ? [{ label: "New", icon: "plus", submenu: [act("db.newColumn", n)] }]
          : []),
        refresh,
        sep,
        { label: "Navigation", submenu: [act("db.goToDdl", n)] },
      ];
    default:
      return [];
  }
}
