import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseView } from "./DatabaseView";
import { executeAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { registerDatabaseTreeActions } from "./treeActions";
import { tablesKey, useDatabase } from "./store";
import { tableInput } from "./tableInput";
import { useEditorRegistry } from "@/editor/api";
import { provideEditorService, provideToolWindowService, type EditorInput } from "@/workbench/contributions";
import styles from "./Database.module.css";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 24,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 24, key: index })),
    scrollToIndex: () => {},
    measure: () => {},
  }),
}));

let dispose: () => void;

beforeEach(() => {
  localStorage.removeItem("openidea.database.viewOptions");
  setContext("projectOpen", true);
  dispose = registerDatabaseTreeActions();
  useDatabase.setState({
    loaded: true,
    sources: [{ id: "pg", name: "PostgreSQL", driver: "postgres", options: { singleDatabase: true } }],
    schemas: { pg: { status: "ok", value: ["public"] } },
    tables: { [tablesKey("pg", "public")]: { status: "ok", value: [] } },
    objects: {
      [tablesKey("pg", "public")]: {
        routines: [
          { name: "calculate", kind: "function", arguments: "integer", returns: "integer" },
          { name: "calculate", kind: "function", arguments: "text", returns: "text" },
          { name: "refresh_data", kind: "procedure", arguments: "", returns: null },
        ],
        packages: [],
        sequences: [],
      },
    },
    treeFilter: "",
    separateProceduresAndFunctions: false,
    treeExpanded: new Set(["pg", "pg/public", "pg/public/routines"]),
  });
});

afterEach(() => dispose());

describe("routine grouping", () => {
  it("keeps an existing expanded routines folder and both overloads by default", () => {
    render(<DatabaseView />);
    const tree = within(screen.getByRole("tree", { name: "Data sources" }));
    expect(tree.getByText("routines").closest('[role="treeitem"]')).toHaveAttribute("aria-expanded", "true");
    expect(tree.getAllByText("calculate")).toHaveLength(2);
    expect(tree.getByText("refresh_data")).toBeInTheDocument();
    expect(tree.queryByText("procedures")).toBeNull();
    expect(tree.queryByText("functions")).toBeNull();
    fireEvent.mouseDown(tree.getAllByText("calculate")[1]!, { button: 0 });
    expect(useDatabase.getState().selectedNode?.key).toBe("pg/public/routines/calculate(text)");
    act(() => useDatabase.setState({ treeFilter: "refresh" }));
    expect(tree.queryAllByText("calculate")).toHaveLength(0);
    expect(tree.getByText("refresh_data")).toBeInTheDocument();
  });

  it("toggles through the action, persists the option, and restores the old expansion", async () => {
    expect(useDatabase.getInitialState().separateProceduresAndFunctions).toBe(false);
    render(<DatabaseView />);
    const tree = within(screen.getByRole("tree", { name: "Data sources" }));
    await act(() => executeAction("db.separateProceduresAndFunctions"));
    expect(JSON.parse(localStorage.getItem("openidea.database.viewOptions")!)).toEqual({
      separateProceduresAndFunctions: true,
    });
    expect(tree.queryByText("routines")).toBeNull();
    const procedures = tree.getByText("procedures").closest('[role="treeitem"]')!;
    const functions = tree.getByText("functions").closest('[role="treeitem"]')!;
    expect(within(procedures as HTMLElement).getByText("1")).toBeInTheDocument();
    expect(within(functions as HTMLElement).getByText("2")).toBeInTheDocument();
    fireEvent.mouseDown(functions.querySelector("[data-tree-toggle]")!, { button: 0 });
    expect(tree.getAllByText("calculate")).toHaveLength(2);
    fireEvent.mouseDown(tree.getAllByText("calculate")[1]!, { button: 0 });
    expect(useDatabase.getState().selectedNode?.key).toBe("pg/public/functions/calculate(text)");
    await act(() => executeAction("db.separateProceduresAndFunctions"));
    expect(tree.getByText("routines").closest('[role="treeitem"]')).toHaveAttribute("aria-expanded", "true");
    expect(tree.getAllByText("calculate")).toHaveLength(2);
    expect(tree.getByText("refresh_data")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("openidea.database.viewOptions")!)).toEqual({
      separateProceduresAndFunctions: false,
    });
  });

  it.each([false, true])("applies object and quick filters before grouping (separate: %s)", (separate) => {
    const source = useDatabase.getState().sources[0]!;
    useDatabase.setState({
      separateProceduresAndFunctions: separate,
      sources: [{ ...source, introspection: { objectFilter: "calculate" } }],
      treeExpanded: new Set(["pg", "pg/public", "pg/public/routines", "pg/public/functions"]),
    });
    render(<DatabaseView />);
    const tree = within(screen.getByRole("tree", { name: "Data sources" }));
    expect(tree.queryByText("procedures")).toBeNull();
    expect(tree.queryByText("refresh_data")).toBeNull();
    expect(tree.getAllByText("calculate")).toHaveLength(2);
    const folder = tree.getByText(separate ? "functions" : "routines").closest('[role="treeitem"]')!;
    expect(within(folder as HTMLElement).getByText("2")).toBeInTheDocument();
    act(() => useDatabase.setState({ treeFilter: "refresh" }));
    expect(tree.queryByText("public")).toBeNull();
    expect(tree.queryByText("routines")).toBeNull();
    expect(tree.queryByText("functions")).toBeNull();
  });
});

describe("Select Opened File", () => {
  const nextFrame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  let active: EditorInput | null = null;
  const show = vi.fn();

  beforeEach(() => {
    provideEditorService({ activeInput: () => active } as never);
    provideToolWindowService({ show } as never);
    useDatabase.setState({
      tables: {
        [tablesKey("pg", "public")]: {
          status: "ok",
          value: [
            { name: "people", kind: "table" },
            { name: "adults", kind: "view" },
          ],
        },
      },
      schemas: { pg: { status: "ok", value: ["public", "audit"] } },
      treeExpanded: new Set(),
    });
  });

  afterEach(() => {
    active = null;
    useEditorRegistry.setState({ active: null });
  });

  it("selects the active table editor's view in the views folder", async () => {
    render(<DatabaseView />);
    active = tableInput("pg", "public", "adults");
    await act(() => executeAction("db.selectOpened"));
    await nextFrame();
    expect(useDatabase.getState().selectedNode?.key).toBe("pg/public/views/adults");
    expect(show).toHaveBeenCalledWith("database");
    expect(document.activeElement).toBe(screen.getByRole("tree", { name: "Data sources" }));
  });

  it("selects the nearest shown ancestor of a dropped table, and a console's schema", async () => {
    render(<DatabaseView />);
    active = tableInput("pg", "public", "dropped");
    await act(() => executeAction("db.selectOpened"));
    await nextFrame();
    expect(useDatabase.getState().selectedNode?.key).toBe("pg/public/tables");

    const path = "/project/audit.sql";
    useDatabase.setState({ consoles: { [path]: "pg" }, consoleSchemas: { [path]: "audit" } });
    active = { kind: "file", key: path, path };
    useEditorRegistry.setState({ active: { ctx: { path, language: "sql" } } as never });
    await act(() => executeAction("db.selectOpened"));
    await nextFrame();
    expect(useDatabase.getState().selectedNode?.key).toBe("pg/audit");
  });
});

describe("Expand All", () => {
  it("opens every loaded node and leaves unloaded ones closed", async () => {
    useDatabase.setState({
      sources: [
        { id: "pg", name: "PostgreSQL", driver: "postgres", options: { singleDatabase: true } },
        { id: "lite", name: "SQLite", driver: "sqlite" },
      ],
      tables: { [tablesKey("pg", "public")]: { status: "ok", value: [{ name: "users", kind: "table" }] } },
      treeExpanded: new Set(),
    });
    render(<DatabaseView />);
    await act(() => executeAction("db.expandAll"));
    expect([...useDatabase.getState().treeExpanded].sort()).toEqual([
      "pg",
      "pg/public",
      "pg/public/routines",
      "pg/public/tables",
    ]);
    const tree = within(screen.getByRole("tree", { name: "Data sources" }));
    expect(tree.getByText("refresh_data")).toBeInTheDocument();
    // Its columns aren't loaded, and neither is the SQLite source: Expand All loads nothing.
    expect(tree.getByText("users").closest('[role="treeitem"]')).toHaveAttribute("aria-expanded", "false");
    expect(tree.getByText("SQLite").closest('[role="treeitem"]')).toHaveAttribute("aria-expanded", "false");
  });
});

describe("data source colour", () => {
  it("tints the whole tree row of the source and of every node under it", () => {
    useDatabase.setState({
      sources: [
        { id: "pg", name: "PostgreSQL", driver: "postgres", color: "red", options: { singleDatabase: true } },
        { id: "lite", name: "SQLite", driver: "sqlite" },
      ],
    });
    render(<DatabaseView />);
    const tree = within(screen.getByRole("tree", { name: "Data sources" }));
    for (const name of ["PostgreSQL", "public", "routines", "refresh_data"]) {
      expect(tree.getByText(name).closest('[role="treeitem"]')).toHaveClass(styles.tintedRow!, styles.tintRed!);
    }
    expect(tree.getByText("SQLite").closest('[role="treeitem"]')).not.toHaveClass(styles.tintedRow!);
  });
});
