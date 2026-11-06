import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbDriver, DbTablePage } from "@/platform/ipc";
import { getContext } from "@/platform/context";
import { TableEditor } from "./TableEditor";
import { activeTableEditor, installTableEditorFocus } from "./tableEditorFocus";
import { tableInput } from "./tableInput";

const backend = vi.hoisted(() => ({
  driver: "clickhouse" as DbDriver,
  page: vi.fn(),
  applyEdits: vi.fn(),
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...actual, commands: { ...actual.commands, dbTablePage: backend.page, dbApplyEdits: backend.applyEdits } };
});

vi.mock("./store", () => ({
  sourceById: () => ({ driver: backend.driver, readOnly: false }),
  withConnection: (_id: string, run: () => unknown) => run(),
  openDialog: vi.fn(),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 24,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 24, key: index })),
    scrollToIndex: () => {},
  }),
}));

const page: DbTablePage = {
  result: {
    statement: "select * from users",
    columns: [
      { name: "id", typeName: "UInt64" },
      { name: "name", typeName: "String" },
    ],
    rows: [["1", "Ann"]],
    affected: null,
    hasMore: false,
    elapsedMs: 1,
    executionMs: 1,
  },
  details: {
    columns: [
      { name: "id", dataType: "UInt64", primaryKey: true, nullable: false, default: null },
      { name: "name", dataType: "String", primaryKey: false, nullable: false, default: null },
    ],
    indexes: [],
    foreignKeys: [],
    triggers: [],
  },
  offset: 0,
};

beforeEach(() => {
  backend.driver = "clickhouse";
  backend.page.mockResolvedValue({ status: "ok", data: page });
  backend.applyEdits.mockClear();
});

describe("table editor capabilities", () => {
  it("keeps ClickHouse rows read-only even when metadata marks a primary key", async () => {
    await act(async () => {
      render(<TableEditor input={tableInput("source", "default", "users")} />);
    });
    const cell = await screen.findByRole("gridcell", { name: "Ann" });
    fireEvent.doubleClick(cell);
    expect(screen.queryByRole("textbox", { name: "Edit name" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add Row" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
    expect(screen.getByText("Use the query console to change ClickHouse data.")).toBeTruthy();
    fireEvent.mouseDown(cell, { button: 0 });
    fireEvent.paste(screen.getByRole("grid"), { clipboardData: { getData: () => "Changed" } });
    expect(screen.getByRole("gridcell", { name: "Ann" })).toBeTruthy();
    expect(backend.applyEdits).not.toHaveBeenCalled();
  });

  it("keeps keyed PostgreSQL rows editable", async () => {
    backend.driver = "postgres";
    await act(async () => {
      render(<TableEditor input={tableInput("source", "public", "users")} />);
    });
    fireEvent.doubleClick(await screen.findByRole("gridcell", { name: "Ann" }));
    expect(screen.getByRole("textbox", { name: "Edit name" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add Row" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Submit" })).toBeTruthy();
  });

  it("offers Submit and Revert to the keyboard while the grid has focus and edits are pending (#1549)", async () => {
    backend.driver = "postgres";
    backend.applyEdits.mockResolvedValue({ status: "ok", data: 1 });
    const uninstall = installTableEditorFocus();
    try {
      await act(async () => {
        render(<TableEditor input={tableInput("source", "public", "users")} />);
      });
      const grid = screen.getByRole("grid");
      act(() => grid.focus());
      expect(getContext()).toMatchObject({ dbTableEditorFocus: true, dbTableEditorChanges: false });

      fireEvent.doubleClick(await screen.findByRole("gridcell", { name: "Ann" }));
      const input = screen.getByRole("textbox", { name: "Edit name" });
      // A text field keeps ⌘↩ for its own edit.
      expect(getContext().dbTableEditorFocus).toBe(false);
      fireEvent.change(input, { target: { value: "Bob" } });
      fireEvent.keyDown(input, { key: "Enter" });
      act(() => grid.focus());
      expect(getContext()).toMatchObject({ dbTableEditorFocus: true, dbTableEditorChanges: true });

      act(() => activeTableEditor()!.revert());
      expect(screen.getByRole("gridcell", { name: "Ann" })).toBeTruthy();
      expect(getContext().dbTableEditorChanges).toBe(false);

      fireEvent.doubleClick(screen.getByRole("gridcell", { name: "Ann" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Edit name" }), { target: { value: "Bob" } });
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Edit name" }), { key: "Enter" });
      act(() => grid.focus());
      await act(async () => activeTableEditor()!.submit());
      expect(backend.applyEdits).toHaveBeenCalledTimes(1);
    } finally {
      uninstall();
    }
  });
});
