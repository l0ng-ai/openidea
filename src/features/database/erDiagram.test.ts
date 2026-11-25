import { describe, expect, it } from "vitest";
import type { DbColumnInfo, DbForeignKey, DbIndexInfo } from "@/platform/ipc";
import { diagramInput, diagramKey, diagramModel, type DiagramTable } from "./erDiagram";

const col = (name: string, dataType = "integer", extra: Partial<DbColumnInfo> = {}): DbColumnInfo => ({
  name,
  dataType,
  nullable: false,
  default: null,
  primaryKey: false,
  ...extra,
});
const fk = (table: string, columns: string[], refTable: string, refSchema = "public"): DbForeignKey => ({
  schema: "public",
  table,
  columns,
  refSchema,
  refTable,
  refColumns: ["id"],
});
const table = (
  name: string,
  columns: DbColumnInfo[],
  foreignKeys: DbForeignKey[] = [],
  schema = "public",
  id = "pg",
  indexes: DbIndexInfo[] = [],
): DiagramTable => ({ id, schema, name, details: { columns, indexes, foreignKeys, triggers: [] } });

const users = table("users", [col("id", "integer", { primaryKey: true }), col("name", "text")]);
const orders = table(
  "orders",
  [col("id", "integer", { primaryKey: true }), col("user_id"), col("coupon_id", "integer", { nullable: true })],
  [fk("orders", ["user_id"], "users"), fk("orders", ["coupon_id"], "coupons")],
);

describe("diagramModel", () => {
  it("marks primary and foreign key columns and links the given tables by their foreign keys", () => {
    const { nodes, edges } = diagramModel([users, orders]);
    expect(nodes.map((n) => n.label)).toEqual(["users", "orders"]);
    expect(nodes[1]!.columns.map((c) => [c.name, c.type, c.primaryKey, c.foreignKey])).toEqual([
      ["id", "integer", true, false],
      ["user_id", "integer", false, true],
      ["coupon_id", "integer", false, true],
    ]);
    expect(edges).toEqual([{ from: 1, fromColumns: ["user_id"], to: 0, toColumns: ["id"], optional: false }]);
  });

  it("draws no link to a table that is not shown", () => {
    expect(diagramModel([orders]).edges).toEqual([]);
  });

  it("makes a link optional when a referencing column is nullable", () => {
    const coupons = table("coupons", [col("id", "integer", { primaryKey: true })]);
    expect(diagramModel([coupons, orders]).edges).toContainEqual(
      expect.objectContaining({ from: 1, fromColumns: ["coupon_id"], to: 0, optional: true }),
    );
  });

  it("draws one link per composite foreign key, and one to the table itself", () => {
    const lines = table(
      "lines",
      [col("order_id"), col("n")],
      [{ ...fk("lines", ["order_id", "n"], "lines"), refColumns: ["order_id", "n"] }],
    );
    expect(diagramModel([lines]).edges).toEqual([
      { from: 0, fromColumns: ["order_id", "n"], to: 0, toColumns: ["order_id", "n"], optional: false },
    ]);
  });

  it("matches a referenced table spelled in another case (SQLite keeps the DDL's spelling)", () => {
    const child = table("child", [col("p")], [fk("child", ["p"], "USERS")]);
    expect(diagramModel([users, child]).edges).toEqual([expect.objectContaining({ from: 1, to: 0 })]);
  });

  it("keeps tables of different schemas or data sources apart and qualifies their names", () => {
    const archived = table("users", [col("id")], [], "archive");
    const other = table("users", [col("id")], [], "public", "mysql");
    expect(diagramModel([users, archived, other]).nodes.map((n) => n.label)).toEqual([
      "public.users",
      "archive.users",
      "public.users",
    ]);
    const child = table("child", [col("u")], [fk("child", ["u"], "users", "archive")]);
    expect(diagramModel([users, archived, child]).edges).toEqual([expect.objectContaining({ from: 2, to: 1 })]);
    expect(diagramModel([users]).nodes[0]!.label).toBe("users");
  });

  describe("unique keys and indexes", () => {
    const index = (name: string, columns: string[], unique = false): DbIndexInfo => ({ name, unique, columns });
    const marks = (t: DiagramTable) =>
      Object.fromEntries(
        diagramModel([t]).nodes[0]!.columns.map((c) => [
          c.name,
          [c.primaryKey && "PK", c.unique && "UK", c.indexed && "IX", ...c.indexes].filter(Boolean).join(" "),
        ]),
      );
    const people = (indexes: DbIndexInfo[]) =>
      table(
        "people",
        [col("id", "integer", { primaryKey: true }), col("email", "text"), col("org"), col("team"), col("note")],
        [],
        "public",
        "pg",
        indexes,
      );

    it("marks the members of unique keys and of other indexes, with their names", () => {
      expect(
        marks(
          people([
            index("people_email_key", ["email"], true),
            index("people_org_team_key", ["org", "team"], true),
            index("people_team_idx", ["team"]),
          ]),
        ),
      ).toEqual({
        id: "PK",
        email: "UK people_email_key",
        org: "UK people_org_team_key",
        team: "UK IX people_org_team_key people_team_idx",
        note: "",
      });
    });

    it("leaves out the primary key's own index, but not another index on its columns", () => {
      expect(marks(people([index("people_pkey", ["id"], true)])).id).toBe("PK");
      expect(marks(people([index("people_id_idx", ["id"])])).id).toBe("PK IX people_id_idx");
      expect(marks(people([index("people_id_email_key", ["id", "email"], true)]))).toMatchObject({
        id: "PK UK people_id_email_key",
        email: "UK people_id_email_key",
      });
    });

    it("ignores index members that aren't columns (expressions)", () => {
      expect(marks(people([index("people_lower_idx", ["lower(email)"])]))).toMatchObject({ email: "", note: "" });
    });
  });
});

describe("diagramKey", () => {
  it("is the same set of tables in any order, and differs by data source or schema", () => {
    expect(diagramKey([users, orders])).toBe(diagramKey([orders, users]));
    expect(diagramInput({ title: "a", tables: [users, orders] }).key).toBe(
      diagramInput({ title: "b", tables: [orders, users] }).key,
    );
    expect(diagramKey([users])).not.toBe(diagramKey([{ ...users, id: "mysql" }]));
    expect(diagramKey([users])).not.toBe(diagramKey([{ ...users, schema: "archive" }]));
    expect(diagramKey([users])).not.toBe(diagramKey([users, orders]));
  });
});
