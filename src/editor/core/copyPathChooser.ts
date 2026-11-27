/** The Copy Path/Reference… chooser: each way to copy, with a preview of the text it copies. */
import { tx } from "@/platform/i18n";
import { shortcutLabel } from "@/platform/keymap";
import { menuGroupItems, type MenuGroupContext } from "@/workbench/contributions";
import { openPopup, type ListPopupItem, type LspPopup, type PopupPoint } from "@/editor/lsp/popupStore";
import type { CopyPathRow } from "@/editor/api";

/** The chooser's popup: `rows`, then the rows contributed to the `copyPath` menu for `ctx`. */
export function copyPathPopup(
  anchor: PopupPoint | "center",
  rows: readonly CopyPathRow[],
  ctx: MenuGroupContext,
  trailing: readonly ListPopupItem[] = [],
): Extract<LspPopup, { kind: "list" }> {
  const contributed = menuGroupItems("copyPath", ctx).flatMap((item) =>
    (item.kind ?? "item") === "item" && "run" in item && item.id && item.run && item.preview
      ? [
          {
            id: item.id,
            label: item.verbatim ? item.label : tx(item.label),
            preview: item.preview,
            shortcut: shortcutLabel(item.id),
            run: item.run,
          },
        ]
      : [],
  );
  return {
    kind: "list",
    title: tx("Copy Path/Reference…"),
    layout: "copyPath",
    anchor,
    items: [
      ...rows.flatMap((row) =>
        row.preview === null
          ? []
          : [{ id: row.id, label: tx(row.label), preview: row.preview, shortcut: shortcutLabel(row.id), run: row.run }],
      ),
      ...contributed,
      ...trailing,
    ],
  };
}

/** Opens the chooser for files outside an editor (`openCopyPathChooser` of `@/editor/api`). */
export function openCopyPathChooser(
  anchor: PopupPoint | "center",
  rows: readonly CopyPathRow[],
  ctx: MenuGroupContext,
): void {
  openPopup(copyPathPopup(anchor, rows, ctx));
}
