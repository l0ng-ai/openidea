import { registerActions, type ActionContext } from "@/platform/actions";
import { setContext } from "@/platform/context";

export type CellCopy = "tsv" | "csv" | "onerow" | "header" | "rowsTsv" | "rowsCsv";

export interface CellActions {
  canToggle(): boolean;
  canSetNull(): boolean;
  canSetDefault(): boolean;
  canFilter(): boolean;
  toggle(): void;
  setNull(): void;
  setDefault(): void;
  /** Opens the local filter of the selected cell's column. */
  filter(): void;
  canEditCell(): boolean;
  editCell(): void;
  hasSelection(): boolean;
  copy(kind: CellCopy): void;
  /** Rows of the selection, top to bottom. */
  selectedRows(): number[];
}

const grids = new WeakMap<Element, CellActions>();
let active: CellActions | null = null;

/** The focused grid (not while a text field in it has focus). */
export function activeCellGrid(): CellActions | null {
  return active;
}

const COPIES: Array<[CellCopy, string, string]> = [
  ["tsv", "db.copyAsTsv", "Copy as TSV"],
  ["csv", "db.copyAsCsv", "Copy as CSV"],
  ["onerow", "db.copyAsOneRow", "Copy as One-Row"],
  ["header", "db.copyWithHeader", "Copy with Header"],
  ["rowsTsv", "db.copyRowsAsTsv", "Copy Rows as TSV"],
  ["rowsCsv", "db.copyRowsAsCsv", "Copy Rows as CSV"],
];

export function registerCellGrid(root: Element, actions: CellActions): () => void {
  grids.set(root, actions);
  return () => {
    grids.delete(root);
    if (active === actions) {
      active = null;
      setContext("dbCellGridFocus", false);
    }
  };
}

export function installCellActions(): () => void {
  const onFocus = (event: FocusEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    const root = target?.closest("[data-db-cell-grid]");
    active =
      root && !target?.closest("input, textarea, select, [contenteditable='true']") ? (grids.get(root) ?? null) : null;
    setContext("dbCellGridFocus", !!active);
  };
  document.addEventListener("focusin", onFocus);
  const handle = ({ arg }: ActionContext) => (arg as CellActions | undefined) ?? active;
  const dispose = registerActions([
    {
      id: "db.toggleBooleanCell",
      title: "Toggle Boolean Cell",
      category: "Database",
      keyWhen: "dbCellGridFocus",
      enabled: (c) => handle(c)?.canToggle() ?? false,
      run: (c) => handle(c)?.toggle(),
    },
    {
      id: "db.setCellNull",
      title: "Set NULL",
      category: "Database",
      keyWhen: "dbCellGridFocus",
      enabled: (c) => handle(c)?.canSetNull() ?? false,
      run: (c) => handle(c)?.setNull(),
    },
    {
      id: "db.setCellDefault",
      title: "Set DEFAULT",
      category: "Database",
      keyWhen: "dbCellGridFocus",
      enabled: (c) => handle(c)?.canSetDefault() ?? false,
      run: (c) => handle(c)?.setDefault(),
    },
    {
      id: "db.localFilter",
      title: "Local Filter",
      category: "Database",
      keyWhen: "dbCellGridFocus",
      enabled: (c) => handle(c)?.canFilter() ?? false,
      run: (c) => handle(c)?.filter(),
    },
    {
      id: "db.editCell",
      title: "Edit Cell",
      category: "Database",
      keyWhen: "dbCellGridFocus",
      enabled: (c) => handle(c)?.canEditCell() ?? false,
      run: (c) => handle(c)?.editCell(),
    },
    ...COPIES.map(([kind, id, title]) => ({
      id,
      title,
      category: "Database",
      keyWhen: "dbCellGridFocus",
      enabled: (c: ActionContext) => handle(c)?.hasSelection() ?? false,
      run: (c: ActionContext) => handle(c)?.copy(kind),
    })),
  ]);
  return () => {
    dispose();
    document.removeEventListener("focusin", onFocus);
    active = null;
    setContext("dbCellGridFocus", false);
  };
}
