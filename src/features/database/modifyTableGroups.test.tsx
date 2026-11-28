import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ObjectDialogs } from "./ObjectDialogs";
import { detailsKey, openDialog, useDatabase } from "./store";

const column = (name: string, dataType: string, primaryKey = false) => ({
  name,
  dataType,
  nullable: !primaryKey,
  default: null,
  primaryKey,
});

function open() {
  useDatabase.setState({
    details: {
      [detailsKey("db", "main", "orders")]: {
        status: "ok",
        value: {
          columns: [column("id", "integer", true), column("customer_id", "integer"), column("note", "text")],
          indexes: [{ name: "orders_customer", unique: false, columns: ["customer_id"] }],
          foreignKeys: [
            {
              schema: "main",
              table: "orders",
              columns: ["customer_id"],
              refSchema: "main",
              refTable: "customers",
              refColumns: ["id"],
            },
          ],
          triggers: [],
        },
      },
    },
  } as never);
  openDialog({ kind: "modifyTable", id: "db", schema: "main", table: "orders" });
  render(<ObjectDialogs />);
}

const rows = (group: string) =>
  within(screen.getByRole("group", { name: group }))
    .queryAllByRole("option")
    .map((o) => o.textContent);

afterEach(() => useDatabase.setState({ dialog: null, details: {}, sources: [] } as never));

describe("Modify Table's list (DataGrip)", () => {
  it("groups the columns, keys, foreign keys and indexes, and filters them by name or type", () => {
    open();
    expect(rows("Columns")).toEqual(["idinteger", "customer_idinteger", "notetext"]);
    expect(rows("Keys")).toEqual(["PRIMARY KEY(id)"]);
    expect(rows("Foreign Keys")).toEqual(["(customer_id)→ customers (id)"]);
    expect(rows("Indexes")).toEqual(["orders_customer(customer_id)"]);
    // No triggers: no group.
    expect(screen.queryByRole("group", { name: "Triggers" })).toBeNull();

    // A group collapses from its header.
    fireEvent.mouseDown(within(screen.getByRole("group", { name: "Indexes" })).getByText("Indexes"));
    expect(rows("Indexes")).toEqual([]);

    fireEvent.change(screen.getByRole("textbox", { name: "Filter columns" }), { target: { value: "TEXT" } });
    expect(rows("Columns")).toEqual(["notetext"]);
    expect(screen.queryByRole("group", { name: "Foreign Keys" })).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "Filter columns" }), { target: { value: "customer" } });
    expect(rows("Columns")).toEqual(["customer_idinteger"]);
    expect(rows("Foreign Keys")).toEqual(["(customer_id)→ customers (id)"]);
  });

  it("keeps Keys on the primary key as edited in Create Table", () => {
    openDialog({ kind: "modifyTable", id: "db", schema: "main", table: null });
    render(<ObjectDialogs />);
    expect(rows("Keys")).toEqual(["PRIMARY KEY(id)"]);
    fireEvent.click(screen.getByRole("button", { name: "Add Column" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Primary key" }));
    expect(rows("Keys")).toEqual(["PRIMARY KEY(id, column_2)"]);
  });

  it("reads and edits the table's and the columns' comments where the engine keeps them", () => {
    useDatabase.setState({
      sources: [{ id: "pg", name: "pg", driver: "postgres" }],
      details: {
        [detailsKey("pg", "public", "orders")]: {
          status: "ok",
          value: {
            comment: "Customer orders",
            columns: [column("id", "integer", true), { ...column("note", "text"), comment: "Free text" }],
            indexes: [],
            foreignKeys: [],
            triggers: [],
          },
        },
      },
    } as never);
    openDialog({ kind: "modifyTable", id: "pg", schema: "public", table: "orders", focusColumn: "note" });
    render(<ObjectDialogs />);
    expect(screen.getByLabelText("Comment:")).toHaveProperty("value", "Customer orders");
    expect(screen.getByLabelText("Column comment")).toHaveProperty("value", "Free text");
    fireEvent.change(screen.getByLabelText("Column comment"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Comment:"), { target: { value: "Orders" } });
    const preview = document.body.textContent ?? "";
    expect(preview).toContain("comment on table public.orders is 'Orders';");
    expect(preview).toContain("comment on column public.orders.note is null;");
  });

  it("shows a PostgreSQL table's properties and previews the statements changing them", () => {
    useDatabase.setState({
      sources: [{ id: "pg", name: "pg", driver: "postgres" }],
      details: {
        [detailsKey("pg", "public", "events")]: {
          status: "ok",
          value: {
            columns: [column("id", "integer")],
            indexes: [],
            foreignKeys: [],
            triggers: [],
            owner: "postgres",
            tablespace: "pg_default",
            storageOptions: [["fillfactor", "70"]],
            partitioning: "RANGE (at)",
            persistence: "unlogged",
          },
        },
      },
    } as never);
    openDialog({ kind: "modifyTable", id: "pg", schema: "public", table: "events" });
    render(<ObjectDialogs />);
    fireEvent.click(screen.getByRole("tab", { name: "Properties" }));
    expect(screen.getByLabelText("Owner")).toHaveProperty("value", "postgres");
    expect(screen.getByLabelText("Partitioning")).toHaveProperty("value", "RANGE (at)");
    expect(screen.getByLabelText("Partitioning")).toHaveProperty("disabled", true);
    // A partitioned table has no access method of its own: no field.
    expect(screen.queryByLabelText("Access method")).toBeNull();

    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "loader" } });
    fireEvent.change(screen.getByLabelText("Tablespace"), { target: { value: "fast" } });
    fireEvent.change(screen.getByLabelText("Storage options"), { target: { value: "fillfactor=50" } });
    fireEvent.click(screen.getByRole("button", { name: "Persistence" }));
    fireEvent.click(within(screen.getByRole("listbox")).getByText("Logged"));
    expect(screen.getByLabelText("Preview SQL").textContent).toBe(
      [
        "alter table public.events set logged;",
        "alter table public.events set (fillfactor = 50);",
        "alter table public.events set tablespace fast;",
        "alter table public.events owner to loader;",
      ].join("\n"),
    );
    // The edits stay when switching tabs.
    fireEvent.click(screen.getByRole("tab", { name: "Columns" }));
    expect(screen.getByLabelText("Preview SQL").textContent).toContain("owner to loader;");
  });

  it("has no Properties tab where the engine reports none", () => {
    open();
    expect(screen.queryByRole("tab", { name: "Properties" })).toBeNull();
    expect(screen.queryByLabelText("Owner")).toBeNull();
  });

  it("adds and drops the primary key, unique keys and indexes of an existing table, previewing each statement", () => {
    useDatabase.setState({
      sources: [{ id: "pg", name: "pg", driver: "postgres" }],
      details: {
        [detailsKey("pg", "public", "orders")]: {
          status: "ok",
          value: {
            columns: [column("id", "integer", true), column("code", "text"), column("note", "text")],
            indexes: [
              { name: "orders_pkey", unique: true, columns: ["id"], key: "primary" },
              { name: "orders_code_key", unique: true, columns: ["code"], key: "unique" },
              { name: "orders_note", unique: false, columns: ["note"] },
            ],
            foreignKeys: [],
            triggers: [],
          },
        },
      },
    } as never);
    openDialog({ kind: "modifyTable", id: "pg", schema: "public", table: "orders", focusColumn: "code" });
    render(<ObjectDialogs />);
    const preview = () => screen.getByLabelText("Preview SQL").textContent;
    expect(rows("Keys")).toEqual(["PRIMARY KEY(id)", "orders_code_keyUNIQUE (code)"]);
    expect(rows("Indexes")).toEqual(["orders_note(note)"]);

    // The primary key moves to `code`: dropped by its name, added again.
    fireEvent.click(screen.getByRole("checkbox", { name: "Primary key" }));
    fireEvent.mouseDown(within(screen.getByRole("group", { name: "Columns" })).getByText("id"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Primary key" }));
    expect(rows("Keys")[0]).toBe("PRIMARY KEY(code)");

    // A new index on the selected column and `note`, made unique.
    fireEvent.click(screen.getByRole("button", { name: "Add Index" }));
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "orders_index");
    fireEvent.click(within(screen.getByRole("group", { name: "Key columns" })).getByRole("checkbox", { name: "note" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Unique" }));

    // The existing unique key is dropped.
    fireEvent.mouseDown(within(screen.getByRole("group", { name: "Keys" })).getByText("orders_code_key"));
    fireEvent.click(screen.getByRole("button", { name: "Drop Key" }));

    expect(preview()).toBe(
      [
        "alter table public.orders drop constraint orders_pkey;",
        "alter table public.orders drop constraint orders_code_key;",
        "alter table public.orders alter column code set not null;",
        "alter table public.orders add constraint orders_pk primary key (code);",
        "create unique index orders_index on public.orders (id, note);",
      ].join("\n"),
    );
  });

  it("keeps existing keys and indexes as they are when a column is renamed, and names a new one's columns as renamed", () => {
    useDatabase.setState({
      sources: [{ id: "pg", name: "pg", driver: "postgres" }],
      details: {
        [detailsKey("pg", "public", "orders")]: {
          status: "ok",
          value: {
            columns: [column("id", "integer", true), column("code", "text")],
            indexes: [
              { name: "orders_pkey", unique: true, columns: ["id"], key: "primary" },
              { name: "orders_code", unique: false, columns: ["code"] },
            ],
            foreignKeys: [],
            triggers: [],
          },
        },
      },
    } as never);
    openDialog({ kind: "modifyTable", id: "pg", schema: "public", table: "orders", focusColumn: "code" });
    render(<ObjectDialogs />);
    fireEvent.click(screen.getByRole("button", { name: "Add Index" }));
    fireEvent.mouseDown(within(screen.getByRole("group", { name: "Columns" })).getByText("code"));
    // Through another column's name and on: the new index keeps to its own column.
    for (const name of ["id", "sku"]) fireEvent.change(screen.getByLabelText("Name"), { target: { value: name } });
    expect(screen.getByLabelText("Preview SQL").textContent).toBe(
      [
        "alter table public.orders rename column code to sku;",
        "create index orders_index on public.orders (sku);",
      ].join("\n"),
    );
    // An existing index can be dropped, not edited.
    fireEvent.mouseDown(within(screen.getByRole("group", { name: "Indexes" })).getByText("orders_code"));
    expect(screen.getByLabelText("Name")).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Drop Index" })).toHaveProperty("disabled", false);
  });

  it("offers SQLite indexes but not keys on an existing table", () => {
    useDatabase.setState({
      details: {
        [detailsKey("db", "main", "codes")]: {
          status: "ok",
          value: {
            columns: [column("code", "text", true), column("label", "text")],
            indexes: [{ name: "sqlite_autoindex_codes_2", unique: true, columns: ["label"], key: "unique" }],
            foreignKeys: [],
            triggers: [],
          },
        },
      },
    } as never);
    openDialog({ kind: "modifyTable", id: "db", schema: "main", table: "codes" });
    render(<ObjectDialogs />);
    expect(screen.queryByRole("checkbox", { name: "Primary key" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add Unique Key" })).toBeNull();
    fireEvent.mouseDown(within(screen.getByRole("group", { name: "Keys" })).getByText("sqlite_autoindex_codes_2"));
    expect(screen.getByRole("button", { name: "Drop Key" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Add Index" }));
    expect(screen.getByLabelText("Preview SQL").textContent).toBe("-- no changes");
    fireEvent.click(
      within(screen.getByRole("group", { name: "Key columns" })).getByRole("checkbox", { name: "label" }),
    );
    expect(screen.getByLabelText("Preview SQL").textContent).toBe("create index codes_index on codes (label);");
  });

  it("has no comment fields on an engine without comments", () => {
    open();
    expect(screen.queryByLabelText("Comment:")).toBeNull();
    expect(screen.queryByLabelText("Column comment")).toBeNull();
  });
});
