import { registerActions, type ActionContext } from "@/platform/actions";
import { setContext } from "@/platform/context";

export interface CellActions {
  canToggle(): boolean;
  canSetNull(): boolean;
  canSetDefault(): boolean;
  toggle(): void;
  setNull(): void;
  setDefault(): void;
}

const grids = new WeakMap<Element, CellActions>();
let active: CellActions | null = null;

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
  ]);
  return () => {
    dispose();
    document.removeEventListener("focusin", onFocus);
    active = null;
    setContext("dbCellGridFocus", false);
  };
}
