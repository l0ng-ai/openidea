/**
 * Opening navigation targets: a file position in the editor, a table in the
 * Database tool window (with the project's data source, a chooser when there
 * are several, a hint when there is none), and the chooser over several targets.
 */
import { locationItems, navigateTo } from "@/editor/lsp/navigation";
import { openPopup, type ListPopupItem, type PopupPoint } from "@/editor/lsp/popupStore";
import { tx } from "@/platform/i18n";
import { notifications, toolWindowService } from "@/workbench/contributions";
import { DB_TOOL_WINDOW, useDatabase } from "../database/store";
import { openTableData } from "../database/treeActions";
import { defaultSchemaOf, targetLabel, targetLocation, type NavTarget } from "./model";

/** Opens `table` in the Database tool window with the project's data source. */
export function openTable(table: string, schema: string | null | undefined, anchor: PopupPoint): void {
  const { sources, completion } = useDatabase.getState();
  const usable = sources.filter((s) => s.id);
  const openIn = (id: string) => {
    const source = usable.find((s) => s.id === id)!;
    openTableData(id, schema || defaultSchemaOf(source, completion[id]?.defaultSchema), table);
    toolWindowService().show(DB_TOOL_WINDOW, false);
  };
  if (!usable.length) {
    notifications().notify({
      level: "info",
      title: "No data source configured",
      body: tx`Add a data source to open the table ${table}.`,
      key: "code-navigation:no-data-source",
      group: "tools",
      actions: [{ label: "Open Database", run: () => toolWindowService().show(DB_TOOL_WINDOW, true) }],
    });
    return;
  }
  if (usable.length === 1) return openIn(usable[0]!.id!);
  openPopup({
    kind: "list",
    anchor,
    title: tx`Choose Data Source`,
    items: usable.map((s) => ({
      id: s.id!,
      label: s.name ?? s.id!,
      icon: "toolwindow-database",
      run: () => openIn(s.id!),
    })),
  });
}

export async function openTarget(t: NavTarget, anchor: PopupPoint): Promise<void> {
  const loc = targetLocation(t);
  if (loc) await navigateTo(loc);
  else if (t.table) openTable(t.table, t.schema, anchor);
}

/** Chooser rows for `targets`, in order: file rows like the declaration chooser's, table rows after the table. */
export async function targetItems(targets: readonly NavTarget[], anchor: PopupPoint): Promise<ListPopupItem[]> {
  const files = await locationItems(targets.map(targetLocation).filter((l) => l !== null));
  let next = 0;
  return targets.map((t, i) => {
    if (t.file) {
      const item = files[next++]!;
      return { ...item, id: `${i}`, label: t.title ?? item.label };
    }
    return {
      id: `${i}`,
      label: targetLabel(t),
      detail: t.title && t.table ? (t.schema ? `${t.schema}.${t.table}` : t.table) : undefined,
      icon: "db-table",
      run: () => openTable(t.table!, t.schema, anchor),
    };
  });
}

/** Opens the single target, or the chooser over several (none: nothing). */
export async function openTargets(targets: readonly NavTarget[], anchor: PopupPoint, title?: string | null) {
  if (!targets.length) return;
  if (targets.length === 1) return openTarget(targets[0]!, anchor);
  openPopup({ kind: "list", anchor, title: title || tx`Choose Target`, items: await targetItems(targets, anchor) });
}
