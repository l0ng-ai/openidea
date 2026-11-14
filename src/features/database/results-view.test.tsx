import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbDriver, DbQueryResult, DbTableDetails } from "@/platform/ipc";
import { installKeyboardDispatcher, useKeymap } from "@/platform/keymap";
import { installCellActions } from "./cellActions";
import { getContext } from "@/platform/context";
import { ResultsView } from "./ResultsView";
import { executeConsole, explainConsole, pinResult, rerunResult, useDatabase, type ResultTab } from "./store";
import { registerResultTabActions } from "./resultTabActions";
import { activeTableEditor, installTableEditorFocus } from "./tableEditorFocus";

const backend = vi.hoisted(() => ({
  driver: "postgres" as DbDriver,
  readOnly: false,
  details: vi.fn(),
  applyEdits: vi.fn(),
  execute: vi.fn(),
  statements: vi.fn(),
  explain: vi.fn(),
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    commands: {
      ...actual.commands,
      dbTableDetails: backend.details,
      dbApplyEdits: backend.applyEdits,
      dbExecute: backend.execute,
      dbStatements: backend.statements,
      dbExplain: backend.explain,
    },
  };
});

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 24,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 24, key: index })),
    scrollToIndex: () => {},
  }),
}));

const details: DbTableDetails = {
  columns: [
    { name: "id", dataType: "int4", primaryKey: true, nullable: false, default: null },
    { name: "name", dataType: "text", primaryKey: false, nullable: false, default: null },
  ],
  indexes: [],
  foreignKeys: [],
  triggers: [],
};

const result = (columns: Array<{ name: string }>, rows: (string | null)[][]): DbQueryResult => ({
  statement: "select",
  columns: columns.map((c) => ({ ...c, typeName: "text" })),
  rows,
  affected: null,
  hasMore: false,
  elapsedMs: 1,
  executionMs: 1,
});

let nextId = 1;

function show(text: string, columns: Array<{ name: string }>, rows: (string | null)[][]) {
  const outcome = { statement: { from: 0, to: text.length, text }, result: result(columns, rows), error: null };
  const tab: ResultTab = {
    id: nextId++,
    title: "Result 1",
    path: "console.sql",
    sourceId: "pg",
    outcome,
    page: 0,
    pageSize: 500,
  };
  useDatabase.setState({
    sources: [{ id: "pg", name: "Local", driver: backend.driver, readOnly: backend.readOnly }],
    completion: {
      pg: {
        defaultSchema: "public",
        tables: [{ schema: "public", name: "users", kind: "table", columns: [] }],
        foreignKeys: [],
      },
    },
    results: [tab],
    activeResult: tab.id,
    output: [],
    details: {},
    consoleSchemas: {},
  });
  return tab;
}

beforeEach(() => {
  vi.clearAllMocks();
  backend.statements.mockImplementation((_id: unknown, text: string) =>
    Promise.resolve({ status: "ok", data: [{ from: 0, to: text.length, text }] }),
  );
  backend.driver = "postgres";
  backend.readOnly = false;
  backend.details.mockResolvedValue({ status: "ok", data: details });
  backend.applyEdits.mockResolvedValue({ status: "ok", data: 1 });
  backend.execute.mockImplementation((_request: unknown, _id: unknown, statements: Array<{ text: string }>) => {
    const st = statements[0]!;
    const r = result(
      [{ name: "id" }, { name: "name" }],
      [
        ["1", "Ann"],
        ["2", "Bob"],
      ],
    );
    return Promise.resolve({
      status: "ok",
      data: [{ statement: st, result: { ...r, statement: st.text }, error: null }],
    });
  });
});

describe("editable result grid", () => {
  it("keeps every cell of a pasted row in the submitted edits", async () => {
    show("SELECT * FROM users", [{ name: "id" }, { name: "name" }], [["1", "Ann"]]);
    await act(async () => render(<ResultsView />));
    fireEvent.click(screen.getByRole("button", { name: "Add Row" }));
    const cells = screen.getAllByRole("gridcell");
    fireEvent.mouseDown(cells[2]!, { button: 0 });
    fireEvent.paste(screen.getByRole("grid"), { clipboardData: { getData: () => "3\tCara" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Submit" })));
    expect(backend.applyEdits).toHaveBeenCalledWith("pg", "public", "users", [
      {
        kind: "insert",
        values: [
          { column: "id", value: "3" },
          { column: "name", value: "Cara" },
        ],
      },
    ]);
  });

  it("makes a single-table select with its primary key editable and submits in one transaction", async () => {
    const tab = show("SELECT * FROM users WHERE id < 10", [{ name: "id" }, { name: "name" }], [["1", "Ann"]]);
    await act(async () => render(<ResultsView />));
    expect(screen.queryByRole("note")).toBeNull();
    fireEvent.doubleClick(await screen.findByRole("gridcell", { name: "Ann" }));
    const input = screen.getByRole("textbox", { name: "Edit name" });
    fireEvent.change(input, { target: { value: "Bob" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("gridcell", { name: "Bob" })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    });
    expect(backend.applyEdits).toHaveBeenCalledWith("pg", "public", "users", [
      { kind: "update", key: [{ column: "id", value: "1" }], values: [{ column: "name", value: "Bob" }] },
    ]);
    // The generated statement is in the console's Output log, and the grid refreshed.
    const output = useDatabase.getState().output.map((l) => l.text);
    expect(output).toContain("UPDATE public.users SET name = 'Bob' WHERE id = '1'");
    await screen.findByRole("gridcell", { name: "Ann" });
    expect(useDatabase.getState().results[0]!.id).toBe(tab.id);
  });

  it("keeps navigation focus after leaving an inline cell editor and releases it outside Results", async () => {
    const first = show("SELECT * FROM users", [{ name: "id" }, { name: "name" }], [["1", "Ann"]]);
    useDatabase.setState({ results: [first, { ...first, id: nextId++, title: "Result 2" }] });
    const keymap = useKeymap.getState();
    useKeymap.setState({ preset: "intellij-macos", overrides: {}, extensions: {} });
    const dispose = registerResultTabActions();
    const uninstall = installKeyboardDispatcher(window);
    try {
      await act(async () =>
        render(
          <>
            <ResultsView />
            <button>Outside results</button>
          </>,
        ),
      );
      fireEvent.doubleClick(await screen.findByRole("gridcell", { name: "Ann" }));
      const input = screen.getByRole("textbox", { name: "Edit name" });
      fireEvent.change(input, { target: { value: "Bob" } });
      await act(async () => {
        fireEvent.keyDown(input, { key: "}", code: "BracketRight", metaKey: true, shiftKey: true });
      });
      expect(screen.getByRole("tab", { name: "Result 2" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("tab", { name: "Result 2" })).toHaveFocus();
      await act(async () => {
        fireEvent.keyDown(document.activeElement!, { key: "{", code: "BracketLeft", metaKey: true, shiftKey: true });
      });
      expect(screen.getByRole("tab", { name: "Result 1" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("tab", { name: "Result 1" })).toHaveFocus();
      act(() => screen.getByRole("button", { name: "Outside results" }).focus());
      await act(async () => {
        fireEvent.keyDown(document.activeElement!, { key: "}", code: "BracketRight", metaKey: true, shiftKey: true });
      });
      expect(screen.getByRole("tab", { name: "Result 1" })).toHaveAttribute("aria-selected", "true");
      expect(backend.applyEdits).not.toHaveBeenCalled();
    } finally {
      uninstall();
      dispose();
      useKeymap.setState(keymap, true);
    }
  });

  it.each(["s2", ""])("records the selected schema or connection default: %s", async (schema) => {
    show("SELECT * FROM users", [{ name: "id" }, { name: "name" }], [["1", "Ann"]]);
    useDatabase.setState({ consoles: { "console.sql": "pg" }, consoleSchemas: { "console.sql": schema } });
    await executeConsole("console.sql", "SELECT * FROM users", 0, 0);
    const expected = schema || "public";
    expect(backend.execute.mock.calls.at(-1)?.at(-1)).toBe(expected);
    expect(useDatabase.getState().results.at(-1)?.schema).toBe(expected);
  });

  it("prevents repeated submission while edits are being applied", async () => {
    let finish!: (value: { status: string; data: number }) => void;
    backend.applyEdits.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    show("SELECT * FROM users", [{ name: "id" }, { name: "name" }], [["1", "Ann"]]);
    await act(async () => render(<ResultsView />));
    fireEvent.click(screen.getByRole("button", { name: "Add Row" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Submit" })));
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add Row" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(backend.applyEdits).toHaveBeenCalledTimes(1);
    await act(async () => finish({ status: "ok", data: 1 }));
  });

  it("keeps a submission in flight from being repeated after switching result tabs", async () => {
    let finish!: (value: { status: string; data: number }) => void;
    backend.applyEdits.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    backend.execute.mockImplementation(() => new Promise(() => {}));
    const first = show("SELECT * FROM users", [{ name: "id" }, { name: "name" }], [["1", "Ann"]]);
    const second: ResultTab = {
      ...first,
      id: nextId++,
      title: "Result 2",
      outcome: { ...first.outcome, result: { ...first.outcome.result! } },
    };
    useDatabase.setState((s) => ({ results: [...s.results, second] }));
    await act(async () => render(<ResultsView />));
    fireEvent.click(screen.getByRole("button", { name: "Add Row" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Submit" })));

    await act(async () => useDatabase.setState({ activeResult: second.id }));
    await act(async () => useDatabase.setState({ activeResult: first.id }));
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(backend.applyEdits).toHaveBeenCalledTimes(1);

    await act(async () => finish({ status: "ok", data: 1 }));
    // The applied row is not offered again while the result re-runs.
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
  });

  it("blocks paging while a remounted result is applying edits", async () => {
    let finish!: (value: { status: string; data: number }) => void;
    const applying = new Promise((resolve) => {
      finish = resolve;
    });
    backend.applyEdits.mockReturnValue(applying);
    const first = show("SELECT * FROM users", [{ name: "id" }, { name: "name" }], [["1", "Ann"]]);
    first.outcome.result!.hasMore = true;
    useDatabase.setState({
      results: [
        first,
        {
          ...first,
          id: nextId++,
          title: "Result 2",
          outcome: { ...first.outcome, result: { ...first.outcome.result! } },
        },
      ],
    });
    await act(async () => render(<ResultsView />));
    fireEvent.click(screen.getByRole("button", { name: "Add Row" }));
    const cells = screen.getAllByRole("gridcell");
    fireEvent.mouseDown(cells[2]!, { button: 0 });
    fireEvent.paste(screen.getByRole("grid"), { clipboardData: { getData: () => "3\tCara" } });
    try {
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Submit" })));
      fireEvent.click(screen.getByRole("tab", { name: "Result 2" }));
      fireEvent.click(screen.getByRole("tab", { name: "Result 1" }));
      expect(screen.getByRole("gridcell", { name: "Cara" })).toBeTruthy();
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Next Page" })));
      expect(backend.execute).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Add Row" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Rerun Query" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Last Page" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Page size" })).toBeDisabled();
      expect(backend.applyEdits).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => finish({ status: "ok", data: 1 }));
    }
  });

  it("finishes an apply after its result closes without refreshing another tab", async () => {
    let finish!: (value: { status: string; data: number }) => void;
    backend.applyEdits.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const first = show("SELECT * FROM users", [{ name: "id" }, { name: "name" }], [["1", "Ann"]]);
    useDatabase.setState({
      results: [
        first,
        {
          ...first,
          id: nextId++,
          title: "Result 2",
          outcome: { ...first.outcome, result: { ...first.outcome.result! } },
        },
      ],
    });
    await act(async () => render(<ResultsView />));
    fireEvent.click(screen.getByRole("button", { name: "Add Row" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Submit" })));
    fireEvent.keyDown(screen.getByRole("tab", { name: "Result 1" }), { key: "Delete" });
    expect(screen.getByRole("tab", { name: "Result 2" })).toHaveAttribute("aria-selected", "true");
    await act(async () => finish({ status: "ok", data: 1 }));
    expect(screen.queryByRole("tab", { name: "Result 1" })).toBeNull();
    expect(screen.getByRole("gridcell", { name: "Ann" })).toBeTruthy();
    expect(backend.execute).not.toHaveBeenCalled();
    expect(backend.applyEdits).toHaveBeenCalledTimes(1);
    expect(useDatabase.getState().output.map((line) => line.text)).toContain("users: 1 row(s) changed");
  });

  it("does not offer accepted edits again when refresh fails after a remount", async () => {
    let finish!: (value: { status: string; data: number }) => void;
    backend.applyEdits.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const first = show("SELECT * FROM users", [{ name: "id" }, { name: "name" }], [["1", "Ann"]]);
    backend.execute.mockResolvedValue({
      status: "ok",
      data: [{ statement: first.outcome.statement, result: null, error: "Refresh denied" }],
    });
    useDatabase.setState({
      results: [
        first,
        {
          ...first,
          id: nextId++,
          title: "Result 2",
          outcome: { ...first.outcome, result: { ...first.outcome.result! } },
        },
      ],
    });
    await act(async () => render(<ResultsView />));
    fireEvent.doubleClick(screen.getByRole("gridcell", { name: "Ann" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit name" }), { target: { value: "Cara" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Edit name" }), { key: "Enter" });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Submit" })));
    fireEvent.click(screen.getByRole("tab", { name: "Result 2" }));
    fireEvent.click(screen.getByRole("tab", { name: "Result 1" }));
    await act(async () => finish({ status: "ok", data: 1 }));
    expect(backend.execute).toHaveBeenCalledTimes(1);
    const output = useDatabase.getState().output;
    expect(output.some((line) => line.kind === "result" && line.text === "users: 1 row(s) changed")).toBe(true);
    expect(output.some((line) => line.kind === "error" && line.text.includes("Refresh denied"))).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: "Result 1" }));
    expect(screen.getByRole("gridcell", { name: "Ann" })).toBeTruthy();
    expect(screen.queryByRole("gridcell", { name: "Cara" })).toBeNull();
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(backend.applyEdits).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Rerun Query" })).toBeEnabled();
  });

  it("uses the execution schema even after the console selection changes", async () => {
    const tab = show("SELECT * FROM users", [{ name: "id" }, { name: "name" }], [["1", "Ann"]]);
    Object.assign(tab, { schema: "s2" });
    useDatabase.setState({ consoleSchemas: { "console.sql": "s1" } });
    await act(async () => render(<ResultsView />));
    expect(backend.details).toHaveBeenCalledWith("pg", "s2", "users");
    fireEvent.doubleClick(await screen.findByRole("gridcell", { name: "Ann" }));
    const input = screen.getByRole("textbox", { name: "Edit name" });
    fireEvent.change(input, { target: { value: "Changed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Submit" })));
    expect(backend.applyEdits).toHaveBeenCalledWith("pg", "s2", "users", [
      { kind: "update", key: [{ column: "id", value: "1" }], values: [{ column: "name", value: "Changed" }] },
    ]);
    expect(backend.execute.mock.calls.at(-1)?.at(-1)).toBe("s2");
  });

  it("preserves pending edits and shows the error when submit fails", async () => {
    backend.applyEdits.mockResolvedValue({ status: "error", error: { kind: "invalid", message: "Duplicate key" } });
    show("SELECT * FROM users", [{ name: "id" }, { name: "name" }], [["1", "Ann"]]);
    await act(async () => render(<ResultsView />));
    fireEvent.doubleClick(await screen.findByRole("gridcell", { name: "Ann" }));
    const input = screen.getByRole("textbox", { name: "Edit name" });
    fireEvent.change(input, { target: { value: "Changed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Submit" })));
    expect(screen.getByRole("gridcell", { name: "Changed" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled();
    expect(useDatabase.getState().output.some((line) => line.kind === "error" && line.text === "Duplicate key")).toBe(
      true,
    );
    expect(backend.execute).not.toHaveBeenCalled();
  });

  it("highlights the edit and reverts it", async () => {
    show("SELECT * FROM users WHERE id < 10", [{ name: "id" }, { name: "name" }], [["1", "Ann"]]);
    await act(async () => render(<ResultsView />));
    fireEvent.doubleClick(await screen.findByRole("gridcell", { name: "Ann" }));
    const input = screen.getByRole("textbox", { name: "Edit name" });
    fireEvent.change(input, { target: { value: "Bob" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    });
    expect(screen.getByRole("gridcell", { name: "Ann" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")).toBe(true);
    expect(backend.applyEdits).not.toHaveBeenCalled();
  });

  it("keeps unsubmitted edits while another result tab is shown", async () => {
    const first = show("SELECT * FROM users WHERE id < 10", [{ name: "id" }, { name: "name" }], [["1", "Ann"]]);
    const second: ResultTab = {
      ...first,
      id: nextId++,
      title: "Result 2",
      outcome: { ...first.outcome, result: { ...first.outcome.result! } },
    };
    useDatabase.setState((s) => ({ results: [...s.results, second] }));
    await act(async () => render(<ResultsView />));
    fireEvent.doubleClick(await screen.findByRole("gridcell", { name: "Ann" }));
    const input = screen.getByRole("textbox", { name: "Edit name" });
    fireEvent.change(input, { target: { value: "Bob" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await act(async () => useDatabase.setState({ activeResult: second.id }));
    expect(screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")).toBe(true);
    await act(async () => useDatabase.setState({ activeResult: first.id }));

    expect(screen.getByRole("gridcell", { name: "Bob" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")).toBe(false);
  });

  it("keeps an aliased column read-only while the plain ones stay editable", async () => {
    show("SELECT id, name AS n FROM users", [{ name: "id" }, { name: "n" }], [["1", "Ann"]]);
    await act(async () => render(<ResultsView />));
    expect(screen.queryByRole("note")).toBeNull();
    fireEvent.doubleClick(await screen.findByRole("gridcell", { name: "Ann" }));
    const input = screen.getByRole("textbox", { name: "Edit n" });
    fireEvent.change(input, { target: { value: "Bob" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // The aliased column ignores the edit; Submit stays out of reach.
    expect(screen.getByRole("gridcell", { name: "Ann" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")).toBe(true);
    expect(backend.applyEdits).not.toHaveBeenCalled();
  });
});

describe("read-only results with a reason", () => {
  it.each([
    ["SELECT * FROM a JOIN b ON a.id = b.id", [{ name: "id" }], [["1"]], "Read-only: the query joins several tables."],
    [
      "SELECT count(*) FROM users",
      [{ name: "count" }],
      [["2"]],
      "Read-only: the result is aggregated (DISTINCT, GROUP BY or an aggregate function).",
    ],
    [
      "SELECT id FROM a UNION SELECT id FROM b",
      [{ name: "id" }],
      [["1"]],
      "Read-only: the result combines several queries (UNION / INTERSECT / EXCEPT).",
    ],
    [
      "SELECT name FROM users",
      [{ name: "name" }],
      [["Ann"]],
      "Read-only: the result has no primary key of public.users.",
    ],
  ])("explains %s", async (text, columns, rows, expected) => {
    show(text, columns, rows);
    await act(async () => render(<ResultsView />));
    expect(await screen.findByRole("note")).toHaveTextContent(expected);
    fireEvent.doubleClick(screen.getByRole("gridcell", { name: String(rows[0]![0]) }));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
    expect(backend.applyEdits).not.toHaveBeenCalled();
  });

  it("keeps an unresolved SQL Server table schema read-only", async () => {
    backend.driver = "sqlServer";
    show("SELECT * FROM users", [{ name: "id" }, { name: "name" }], [["1", "Ann"]]);
    await act(async () => render(<ResultsView />));
    expect(await screen.findByRole("note")).toHaveTextContent(
      "Read-only: the table schema could not be identified in the result database.",
    );
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
    expect(backend.details).not.toHaveBeenCalled();
  });

  it.each(["postgres", "sqlServer"] as const)("matches case-sensitive key columns exactly for %s", async (driver) => {
    backend.driver = driver;
    show('SELECT "ID", name FROM public.users', [{ name: "ID" }, { name: "name" }], [["1", "Ann"]]);
    await act(async () => render(<ResultsView />));
    expect(await screen.findByRole("note")).toHaveTextContent(
      "Read-only: the result has no primary key of public.users.",
    );
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
  });

  it("keeps ClickHouse read-only", async () => {
    backend.driver = "clickhouse";
    show("SELECT * FROM users", [{ name: "id" }, { name: "name" }], [["1", "Ann"]]);
    await act(async () => render(<ResultsView />));
    expect(await screen.findByRole("note")).toHaveTextContent("Use the query console to change ClickHouse data.");
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
  });

  it("keeps a read-only data source read-only", async () => {
    backend.readOnly = true;
    show("SELECT * FROM users", [{ name: "id" }, { name: "name" }], [["1", "Ann"]]);
    await act(async () => render(<ResultsView />));
    expect(await screen.findByRole("note")).toHaveTextContent("Read-only data source.");
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
  });

  it("keeps a table without a primary key read-only", async () => {
    backend.details.mockResolvedValue({
      status: "ok",
      data: { ...details, columns: details.columns.map((c) => ({ ...c, primaryKey: false })) },
    });
    show("SELECT * FROM users", [{ name: "id" }, { name: "name" }], [["1", "Ann"]]);
    await act(async () => render(<ResultsView />));
    expect(await screen.findByRole("note")).toHaveTextContent(
      "Read-only: the table has no primary key to identify rows.",
    );
  });
});

describe("result grid keyboard Submit / Revert (#2332)", () => {
  it("confirms the cell being edited, then submits; reverts pending edits", async () => {
    const uninstall = installTableEditorFocus();
    try {
      show("SELECT * FROM users", [{ name: "id" }, { name: "name" }], [["1", "Ann"]]);
      await act(async () => render(<ResultsView />));
      const submit = await screen.findByRole("button", { name: "Submit" });
      expect(submit.getAttribute("data-tooltip-shortcut")).toBeTruthy();
      const grid = screen.getByRole("grid");
      act(() => grid.focus());
      expect(getContext()).toMatchObject({ dbTableEditorFocus: true, dbTableEditorChanges: false });

      fireEvent.doubleClick(screen.getByRole("gridcell", { name: "Ann" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Edit name" }), { target: { value: "Bob" } });
      // Still the grid while a cell is being edited: ⌘↩ confirms the cell, then submits.
      expect(getContext()).toMatchObject({ dbTableEditorFocus: true, dbTableEditorChanges: true });
      await act(async () => activeTableEditor()!.submit());
      expect(backend.applyEdits).toHaveBeenCalledWith("pg", "public", "users", [
        { kind: "update", key: [{ column: "id", value: "1" }], values: [{ column: "name", value: "Bob" }] },
      ]);

      fireEvent.doubleClick(await screen.findByRole("gridcell", { name: "Ann" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Edit name" }), { target: { value: "Cara" } });
      act(() => activeTableEditor()!.revert());
      expect(screen.queryByRole("textbox", { name: "Edit name" })).toBeNull();
      expect(screen.getByRole("gridcell", { name: "Ann" })).toBeTruthy();
      expect(getContext().dbTableEditorChanges).toBe(false);
    } finally {
      uninstall();
    }
  });
});

describe("Tab in the results (IDEA: Tab enters the table and moves between its cells)", () => {
  const selectedCells = () =>
    screen
      .getAllByRole("gridcell")
      .filter((cell) => cell.getAttribute("aria-selected") === "true")
      .map((cell) => cell.textContent);
  const rows = [
    ["1", "Ann"],
    ["2", "Bob"],
  ];

  it("goes from the result tab to the first cell, cell by cell, and back through the toolbar's one stop", async () => {
    const user = userEvent.setup();
    show("SELECT * FROM users", [{ name: "id" }, { name: "name" }], rows);
    await act(async () => render(<ResultsView />));
    await screen.findByRole("button", { name: "Add Row" });
    act(() => screen.getByRole("tab", { name: "Result 1" }).focus());
    await user.tab();
    expect(screen.getByRole("grid")).toHaveFocus();
    expect(selectedCells()).toEqual(["1"]);
    await user.tab();
    expect(selectedCells()).toEqual(["Ann"]);
    await user.tab();
    expect(selectedCells()).toEqual(["2"]);
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    expect(selectedCells()).toEqual(["1"]);
    await user.tab({ shift: true });
    expect(screen.getByRole("toolbar", { name: "Result actions" })).toContainElement(
      document.activeElement as HTMLElement,
    );
    await user.tab({ shift: true });
    expect(screen.getByRole("tab", { name: "Result 1" })).toHaveFocus();
  });

  it("leaves the grid after the last cell", async () => {
    const user = userEvent.setup();
    show("SELECT * FROM users", [{ name: "id" }, { name: "name" }], rows);
    await act(async () => render(<ResultsView />));
    fireEvent.mouseDown(screen.getByRole("gridcell", { name: "Bob" }), { button: 0 });
    await user.tab();
    expect(screen.getByRole("grid")).not.toHaveFocus();
    expect(selectedCells()).toEqual(["Bob"]);
  });

  it("commits the cell editor with Tab and selects the next cell", async () => {
    show("SELECT * FROM users", [{ name: "id" }, { name: "name" }], rows);
    await act(async () => render(<ResultsView />));
    fireEvent.doubleClick(await screen.findByRole("gridcell", { name: "Ann" }));
    const input = screen.getByRole("textbox", { name: "Edit name" });
    fireEvent.change(input, { target: { value: "Cara" } });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(screen.getByRole("gridcell", { name: "Cara" })).toBeTruthy();
    expect(selectedCells()).toEqual(["2"]);
    expect(screen.getByRole("grid")).toHaveFocus();
  });

  it("goes from the Output tab to the log, past its toolbar", async () => {
    const user = userEvent.setup();
    show("SELECT * FROM users", [{ name: "id" }, { name: "name" }], rows);
    useDatabase.setState({ output: [{ id: 1, time: 0, kind: "statement", text: "SELECT * FROM users" }] });
    await act(async () => render(<ResultsView />));
    fireEvent.click(screen.getByRole("tab", { name: "Output" }));
    act(() => screen.getByRole("tab", { name: "Output" }).focus());
    await user.tab();
    expect(screen.getByRole("log", { name: "Database output" })).toHaveFocus();
  });
});

it("omits a reset inserted cell from Submit instead of writing SQL NULL", async () => {
  show("SELECT * FROM users", [{ name: "id" }, { name: "name" }], [["1", "Ann"]]);
  useKeymap.setState({ preset: "intellij-macos", overrides: {} });
  const disposeActions = installCellActions();
  const disposeKeys = installKeyboardDispatcher();
  try {
    await act(async () => {
      render(<ResultsView />);
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Row" }));
    const cells = screen.getAllByRole("gridcell");
    fireEvent.mouseDown(cells[2]!, { button: 0 });
    fireEvent.paste(screen.getByRole("grid"), { clipboardData: { getData: () => "3\tCara" } });
    fireEvent.mouseDown(cells[3]!, { button: 0 });
    fireEvent.keyDown(screen.getByRole("grid"), { key: "Backspace", metaKey: true, shiftKey: true });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    });
    expect(backend.applyEdits.mock.calls[0]?.[3]).toEqual([{ kind: "insert", values: [{ column: "id", value: "3" }] }]);
  } finally {
    disposeKeys();
    disposeActions();
  }
});

describe("result tab reuse (IDEA: new results replace the console's unpinned tabs)", () => {
  const runIn = (path: string, text: string) => executeConsole(path, text, 0, text.length);
  const strip = () => useDatabase.getState().results.map((r) => `${r.path}:${r.outcome.statement.text}`);
  const titles = () => useDatabase.getState().results.map((r) => r.title);
  const ids = () => useDatabase.getState().results.map((r) => r.id);
  const runNumber = (title: string) => Number(/^Result (\d+)/.exec(title)![1]);

  beforeEach(() => {
    useDatabase.setState({
      sources: [{ id: "pg", name: "Local", driver: "postgres", readOnly: false }],
      completion: { pg: { defaultSchema: "public", tables: [], foreignKeys: [] } },
      consoles: { "a.sql": "pg", "b.sql": "pg" },
      consoleSchemas: {},
      results: [],
      activeResult: null,
      output: [],
      details: {},
      running: {},
    });
    backend.statements.mockImplementation((_id: unknown, text: string) => {
      let from = 0;
      const statements = text.split(";").flatMap((part) => {
        const start = from + part.length - part.trimStart().length;
        from += part.length + 1;
        const st = part.trim();
        return st ? [{ from: start, to: start + st.length, text: st }] : [];
      });
      return Promise.resolve({ status: "ok", data: statements });
    });
    backend.execute.mockImplementation((_r: unknown, _id: unknown, statements: Array<{ text: string }>) =>
      Promise.resolve({
        status: "ok",
        data: statements.map((st) =>
          /^bad/i.test(st.text)
            ? { statement: st, result: null, error: "syntax error" }
            : /^update/i.test(st.text)
              ? { statement: st, result: { ...result([], []), affected: 1, statement: st.text }, error: null }
              : { statement: st, result: { ...result([{ name: "v" }], [[st.text]]), statement: st.text }, error: null },
        ),
      }),
    );
  });

  it("replaces the console's result in place with a fresh tab, leaving other consoles' results", async () => {
    await runIn("a.sql", "SELECT 1");
    await runIn("b.sql", "SELECT b");
    const [first, other] = ids();
    await runIn("a.sql", "SELECT 2");
    expect(strip()).toEqual(["a.sql:SELECT 2", "b.sql:SELECT b"]);
    expect(ids()[0]).not.toBe(first);
    expect(ids()[1]).toBe(other);
    expect(useDatabase.getState().activeResult).toBe(ids()[0]);
    expect(runNumber(titles()[0]!)).toBe(runNumber(titles()[1]!) + 1);
  });

  it("opens one tab per result set of a batch, numbered per execution, and a single run replaces them all", async () => {
    await runIn("a.sql", "SELECT 1; SELECT 2; SELECT 3");
    const n = runNumber(titles()[0]!);
    expect(titles()).toEqual([`Result ${n}`, `Result ${n}-2`, `Result ${n}-3`]);
    expect(useDatabase.getState().activeResult).toBe(ids()[2]);
    await runIn("a.sql", "SELECT 4");
    expect(strip()).toEqual(["a.sql:SELECT 4"]);
    expect(titles()).toEqual([`Result ${n + 1}`]);
    await runIn("a.sql", "SELECT 5; SELECT 6");
    expect(titles()).toEqual([`Result ${n + 2}`, `Result ${n + 2}-2`]);
  });

  it("leaves a pinned result alone and replaces only the newer unpinned one", async () => {
    await runIn("a.sql", "SELECT 1");
    const pinned = ids()[0]!;
    pinResult(pinned, true);
    await runIn("a.sql", "SELECT 2");
    await runIn("a.sql", "SELECT 3");
    expect(strip()).toEqual(["a.sql:SELECT 1", "a.sql:SELECT 3"]);
    expect(ids()[0]).toBe(pinned);
    pinResult(pinned, false);
    await runIn("a.sql", "SELECT 4");
    expect(strip()).toEqual(["a.sql:SELECT 4"]);
  });

  it("keeps the previous results when a run returns no result set or fails", async () => {
    await runIn("a.sql", "SELECT 1");
    const before = useDatabase.getState().results;
    await runIn("a.sql", "UPDATE t SET v = 1");
    expect(useDatabase.getState().results).toBe(before);
    expect(useDatabase.getState().activeResult).toBe(0);
    await runIn("a.sql", "bad sql");
    expect(useDatabase.getState().results).toBe(before);
  });

  it("never replaces the Query Plan from a run, and appends a new plan beside a pinned one", async () => {
    backend.explain.mockResolvedValue({ status: "ok", data: [] });
    await explainConsole("a.sql", "SELECT 1", 0, 0);
    await runIn("a.sql", "SELECT 2");
    const plan = ids()[0]!;
    expect(useDatabase.getState().results.map((r) => !!r.plan)).toEqual([true, false]);
    await runIn("a.sql", "SELECT 3");
    expect(ids()[0]).toBe(plan);
    pinResult(plan, true);
    await explainConsole("a.sql", "SELECT 4", 0, 0);
    expect(
      useDatabase
        .getState()
        .results.filter((r) => r.plan)
        .map((r) => r.outcome.statement.text),
    ).toEqual(["SELECT 1", "SELECT 4"]);
  });

  it("drops the oldest unpinned results beyond 12 but never pinned or new ones", async () => {
    const paths = Array.from({ length: 12 }, (_, i) => `c${i}.sql`);
    useDatabase.setState((s) => ({ consoles: { ...s.consoles, ...Object.fromEntries(paths.map((p) => [p, "pg"])) } }));
    for (const path of paths) await runIn(path, "SELECT 0");
    pinResult(ids()[0]!, true);
    await runIn("a.sql", "SELECT 1; SELECT 2");
    // c1 and c2 go (oldest unpinned); pinned c0 and both new results stay.
    expect(strip()).toEqual([
      "c0.sql:SELECT 0",
      ...paths.slice(3).map((p) => `${p}:SELECT 0`),
      "a.sql:SELECT 1",
      "a.sql:SELECT 2",
    ]);
    for (const r of useDatabase.getState().results) pinResult(r.id, true);
    await runIn("b.sql", "SELECT b");
    expect(strip()).toHaveLength(13);
    expect(strip().at(-1)).toBe("b.sql:SELECT b");
  });

  it("stays on the new result when a replaced tab's rerun fails afterwards", async () => {
    await runIn("a.sql", "SELECT 1");
    const old = ids()[0]!;
    let fail!: () => void;
    backend.execute.mockImplementationOnce(
      (_r: unknown, _id: unknown, statements: Array<{ text: string }>) =>
        new Promise((resolve) => {
          fail = () => resolve({ status: "ok", data: [{ statement: statements[0], result: null, error: "gone" }] });
        }),
    );
    const rerun = rerunResult(old);
    await runIn("a.sql", "SELECT 2");
    const fresh = ids()[0]!;
    fail();
    await rerun;
    expect(useDatabase.getState().activeResult).toBe(fresh);
  });
});
