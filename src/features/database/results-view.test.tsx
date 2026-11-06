import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbDriver, DbQueryResult, DbTableDetails } from "@/platform/ipc";
import { ResultsView } from "./ResultsView";
import { useDatabase, type ResultTab } from "./store";

const backend = vi.hoisted(() => ({
  driver: "postgres" as DbDriver,
  readOnly: false,
  details: vi.fn(),
  applyEdits: vi.fn(),
  execute: vi.fn(),
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
  });
  return tab;
}

beforeEach(() => {
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
