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

  it("has no comment fields on an engine without comments", () => {
    open();
    expect(screen.queryByLabelText("Comment:")).toBeNull();
    expect(screen.queryByLabelText("Column comment")).toBeNull();
  });
});
