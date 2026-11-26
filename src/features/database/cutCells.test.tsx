import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbDriver, DbQueryResult, DbTableDetails } from "@/platform/ipc";
import { provideToolWindowService } from "@/workbench/contributions";
import { cellOf, cutLength, hasCutCells, hashOf, loadCells, loadPage } from "./cutCells";
import { ResultsView } from "./ResultsView";
import { CELL_LIMIT, closeResult, executeConsole, useDatabase, type ResultTab } from "./store";

const backend = vi.hoisted(() => ({
  driver: "postgres" as DbDriver,
  details: vi.fn(),
  execute: vi.fn(),
  resultRow: vi.fn(),
  release: vi.fn(),
  statements: vi.fn(),
  connected: vi.fn(),
  writeClipboardText: vi.fn(async (_text: string) => {}),
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    commands: {
      ...actual.commands,
      dbTableDetails: backend.details,
      dbExecute: backend.execute,
      dbResultRow: backend.resultRow,
      dbReleaseResult: backend.release,
      dbStatements: backend.statements,
      dbConnected: backend.connected,
    },
  };
});
vi.mock("@/platform/clipboard", () => ({ writeClipboardText: backend.writeClipboardText }));
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
    { name: "body", dataType: "text", primaryKey: false, nullable: false, default: null },
  ],
  indexes: [],
  foreignKeys: [],
  triggers: [],
};

/** Page 2 of 10 rows: row 1 of it (row 21 of the result) has a body of `whole.length` characters. */
const whole = "😀é".repeat(5000);
const start = Array.from(whole).slice(0, 4000).join("");
const shown = [start];
const length = whole.length;
const hash = hashOf(whole);

function page(): DbQueryResult {
  return {
    statement: "SELECT id, body FROM docs",
    columns: [
      { name: "id", typeName: "int4" },
      { name: "body", typeName: "text" },
    ],
    rows: [
      ["20", "short"],
      ["21", shown[0]!],
    ],
    affected: null,
    hasMore: false,
    elapsedMs: 1,
    executionMs: 1,
    truncated: [{ row: 1, column: 1, length, hash }],
  };
}

const text = "SELECT id, body FROM docs";

function show(): ResultTab {
  const tab: ResultTab = {
    id: 1,
    title: "Result 1",
    path: "console.sql",
    sourceId: "pg",
    outcome: { statement: { from: 0, to: text.length, text }, result: page(), error: null },
    page: 2,
    pageSize: 10,
  };
  useDatabase.setState({
    sources: [{ id: "pg", name: "Local", driver: backend.driver }],
    completion: {
      pg: {
        defaultSchema: "public",
        tables: [{ schema: "public", name: "docs", kind: "table", columns: [] }],
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

const rowReply = (body = whole) => {
  const r = page();
  return Promise.resolve({ status: "ok", data: { ...r, rows: [["21", body]], truncated: [] } });
};

beforeEach(() => {
  provideToolWindowService({ show: () => {} } as never);
  vi.clearAllMocks();
  backend.details.mockResolvedValue({ status: "ok", data: details });
  backend.resultRow.mockImplementation(() => rowReply());
  backend.release.mockResolvedValue({ status: "ok", data: null });
  backend.connected.mockResolvedValue({ status: "ok", data: ["pg"] });
  backend.statements.mockImplementation((_id: unknown, t: string) =>
    Promise.resolve({ status: "ok", data: [{ from: 0, to: t.length, text: t }] }),
  );
});

describe("cut cells", () => {
  it("read their whole value from the row of the result, not from the page", async () => {
    const tab = show();
    const r = tab.outcome.result!;
    expect(cutLength(r, 1, 1)).toBe(length);
    expect(hasCutCells(r)).toBe(true);
    const [full] = await loadCells(tab, [{ row: 1, col: 1 }]);
    expect(full).toBe(whole);
    // Page 2 of 10 rows: the second row of the page is row 21 of the result.
    expect(backend.resultRow).toHaveBeenCalledWith(expect.any(Number), "pg", tab.outcome.statement, 21, "public");
    expect(cellOf(r, 1, 1)).toBe(whole);
    expect(cutLength(r, 1, 1)).toBeNull();
    expect(hasCutCells(r)).toBe(false);
    // Read once: a second request does not ask the backend again.
    await loadCells(tab, [{ row: 1, col: 1 }]);
    expect(backend.resultRow).toHaveBeenCalledTimes(1);
  });

  it("refuse a row that is no longer the one the page showed", async () => {
    const tab = show();
    backend.resultRow.mockImplementationOnce(() => rowReply("x".repeat(length)));
    await expect(loadCells(tab, [{ row: 1, col: 1 }])).rejects.toThrow("The result changed");
    backend.resultRow.mockImplementationOnce(() => rowReply(whole + "!"));
    await expect(loadCells(tab, [{ row: 1, col: 1 }])).rejects.toThrow("The result changed");
    expect(cellOf(tab.outcome.result!, 1, 1)).toBe(shown[0]);
  });

  it("refuse a value that differs from the one that was cut anywhere, not only in its start or length", async () => {
    const tab = show();
    // Same length, same start the page shows: only the end differs.
    backend.resultRow.mockImplementationOnce(() => rowReply(whole.slice(0, -1) + "!"));
    await expect(loadCells(tab, [{ row: 1, col: 1 }])).rejects.toThrow("The result changed");
    expect(cellOf(tab.outcome.result!, 1, 1)).toBe(shown[0]);
    expect(hasCutCells(tab.outcome.result!)).toBe(true);
  });

  it("refuse a read that returns fewer rows than were asked for", async () => {
    const tab = show();
    backend.resultRow.mockImplementationOnce(() =>
      Promise.resolve({ status: "ok", data: { ...page(), rows: [], truncated: [] } }),
    );
    await expect(loadCells(tab, [{ row: 1, col: 1 }])).rejects.toThrow("The result changed");
    expect(cellOf(tab.outcome.result!, 1, 1)).toBe(shown[0]);

    const r = tab.outcome.result!;
    const many = Array.from({ length: 12 }, (_, i) => i);
    r.rows = many.map((i) => [String(i), shown[0]!]);
    r.truncated = many.map((row) => ({ row, column: 1, length, hash }));
    backend.execute.mockImplementation(() =>
      Promise.resolve({
        status: "ok",
        data: [
          {
            statement: tab.outcome.statement,
            error: null,
            result: { ...r, rows: many.slice(0, 11).map((i) => [String(i), whole]), truncated: [] },
          },
        ],
      }),
    );
    await expect(loadPage(tab)).rejects.toThrow("The result changed");
    expect(hasCutCells(r)).toBe(true);
  });

  it("hash a value as the backend does", () => {
    // The same values as the Rust test of the backend's hash.
    expect(hashOf("")).toBe(2166136261);
    expect(hashOf("a")).toBe(3826002220);
    expect(hashOf("a😀b")).toBe(2412414209);
    expect(hashOf("日本語日本語")).toBe(2778669755);
  });

  it("read a page that has many cut rows with one request", async () => {
    const tab = show();
    const r = tab.outcome.result!;
    const many = Array.from({ length: 12 }, (_, i) => i);
    r.rows = many.map((i) => [String(i), shown[0]!]);
    r.truncated = many.map((row) => ({ row, column: 1, length, hash }));
    backend.execute.mockImplementation(() =>
      Promise.resolve({
        status: "ok",
        data: [
          {
            statement: tab.outcome.statement,
            error: null,
            result: { ...r, rows: many.map((i) => [String(i), whole]), truncated: [] },
          },
        ],
      }),
    );
    await loadPage(tab);
    expect(backend.resultRow).not.toHaveBeenCalled();
    expect(backend.execute).toHaveBeenCalledTimes(1);
    // The page is read whole (no cell limit) from its own first row.
    expect(backend.execute.mock.calls[0]!.slice(3)).toEqual([20, 12, "public", null]);
    expect(hasCutCells(r)).toBe(false);
  });
});

describe("the grid", () => {
  it("marks a cut cell and copies and edits its whole value", async () => {
    show();
    await act(async () => render(<ResultsView />));
    const cells = screen.getAllByRole("gridcell");
    // id, body of the first row, then of the second.
    expect(cells[1]!.textContent).not.toContain("truncated");
    expect(cells[3]!.textContent).toContain("truncated");
    expect(cells[3]!.getAttribute("title")).toContain(`first ${shown[0]!.length} of ${length}`);

    fireEvent.mouseDown(cells[3]!, { button: 0 });
    await act(async () => fireEvent.keyDown(screen.getByRole("grid"), { key: "c", metaKey: true }));
    expect(backend.writeClipboardText).toHaveBeenCalledWith(whole);

    // Once read, the cell is whole.
    expect(screen.getAllByRole("gridcell")[3]!.textContent).not.toContain("truncated");
    expect(backend.resultRow).toHaveBeenCalledTimes(1);
  });

  it("edits the whole value of a cut cell, never its start", async () => {
    show();
    await act(async () => render(<ResultsView />));
    await act(async () => fireEvent.doubleClick(screen.getAllByRole("gridcell")[3]!));
    expect(backend.resultRow).toHaveBeenCalledTimes(1);
    const editor = (await screen.findByRole("textbox", { name: /body/ })) as HTMLTextAreaElement;
    expect(editor.value).toBe(whole);
  });

  it("does not open the editor on the start of a value it could not read", async () => {
    show();
    backend.resultRow.mockImplementation(() => rowReply("x".repeat(length)));
    await act(async () => render(<ResultsView />));
    await act(async () => fireEvent.doubleClick(screen.getAllByRole("gridcell")[3]!));
    expect(screen.queryByRole("textbox", { name: "Edit body" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getAllByRole("gridcell")[3]!.textContent).toContain("truncated");
  });
});

describe("running queries", () => {
  it("cap the cells of a query that is safe to run again, and only of such queries", async () => {
    useDatabase.setState({ sources: [{ id: "pg", name: "Local", driver: "postgres" }], consoles: { "a.sql": "pg" } });
    backend.execute.mockImplementation((_r: unknown, _id: unknown, statements: Array<{ text: string }>) =>
      Promise.resolve({ status: "ok", data: statements.map((s) => ({ statement: s, result: null, error: "x" })) }),
    );
    await executeConsole("a.sql", "SELECT 1", 0, 8);
    expect(backend.execute.mock.calls.at(-1)![6]).toBe(CELL_LIMIT);
    await executeConsole("a.sql", "DELETE FROM docs RETURNING body", 0, 30);
    expect(backend.execute.mock.calls.at(-1)![6]).toBeNull();
    await executeConsole("a.sql", "WITH d AS (DELETE FROM docs RETURNING body) SELECT * FROM d", 0, 59);
    expect(backend.execute.mock.calls.at(-1)![6]).toBeNull();
  });

  it("release the cursor of a result when its tab closes, not before", async () => {
    show();
    const other: ResultTab = { ...useDatabase.getState().results[0]!, id: 2 };
    useDatabase.setState((s) => ({ results: [...s.results, other] }));
    closeResult(2);
    // The other tab still shows the same statement.
    expect(backend.release).not.toHaveBeenCalled();
    closeResult(1);
    expect(backend.release).toHaveBeenCalledExactlyOnceWith("pg", text, "public");
  });
});
