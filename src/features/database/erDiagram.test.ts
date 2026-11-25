import { describe, expect, it } from "vitest";
import type { DbColumnInfo, DbForeignKey } from "@/platform/ipc";
import { erDiagram, type DiagramTable } from "./erDiagram";

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
): DiagramTable => ({ id, schema, name, details: { columns, indexes: [], foreignKeys, triggers: [] } });

const users = table("users", [col("id", "integer", { primaryKey: true }), col("name", "text")]);
const orders = table(
  "orders",
  [col("id", "integer", { primaryKey: true }), col("user_id"), col("coupon_id", "integer", { nullable: true })],
  [fk("orders", ["user_id"], "users"), fk("orders", ["coupon_id"], "coupons")],
);

describe("erDiagram", () => {
  it("lists the columns with PK / FK markers and links the selected tables by their foreign keys", () => {
    expect(erDiagram([users, orders])).toBe(
      [
        "erDiagram",
        '  t0["users"] {',
        "    `integer` `id` PK",
        "    `text` `name`",
        "  }",
        '  t1["orders"] {',
        "    `integer` `id` PK",
        "    `integer` `user#95;id` FK",
        "    `integer` `coupon#95;id` FK",
        "  }",
        '  t0 ||--o{ t1 : "user#95;id"',
      ].join("\n"),
    );
  });

  it("draws no relationship to a table that is not selected", () => {
    expect(erDiagram([orders])).not.toContain("--");
  });

  it("makes the parent optional when a referencing column is nullable", () => {
    const coupons = table("coupons", [col("id", "integer", { primaryKey: true })]);
    expect(erDiagram([coupons, orders])).toContain('t0 |o--o{ t1 : "coupon#95;id"');
  });

  it("draws one relationship per composite foreign key, and one to the table itself", () => {
    const lines = table(
      "lines",
      [col("order_id"), col("n")],
      [{ ...fk("lines", ["order_id", "n"], "lines"), refColumns: ["order_id", "n"] }],
    );
    expect(
      erDiagram([lines])
        .split("\n")
        .filter((l) => l.includes("--")),
    ).toEqual(['  t0 ||--o{ t0 : "order#95;id#44; n"']);
  });

  it("matches a referenced table spelled in another case (SQLite keeps the DDL's spelling)", () => {
    const child = table("child", [col("p")], [fk("child", ["p"], "USERS")]);
    expect(erDiagram([users, child])).toContain('t0 ||--o{ t1 : "p"');
  });

  it("keeps tables of different schemas or data sources apart and qualifies their names", () => {
    const archived = table("users", [col("id")], [], "archive");
    const other = table("users", [col("id")], [], "public", "mysql");
    const diagram = erDiagram([users, archived, other]);
    expect(diagram).toContain('t0["public#46;users"]');
    expect(diagram).toContain('t1["archive#46;users"]');
    expect(diagram).toContain('t2["public#46;users"]');
    const child = table("child", [col("u")], [fk("child", ["u"], "users", "archive")]);
    expect(erDiagram([users, archived, child])).toContain('t1 ||--o{ t2 : "u"');
  });

  it.each([
    ["spaces", "order items", "order items"],
    ["a double quote", 'say "hi"', "say #34;hi#34;"],
    ["a backtick", "a`b", "a#96;b"],
    ["percent and backslash", "50%\\off", "50#37;#92;off"],
    ["an entity-like name", "a#35;b", "a#35;35#59;b"],
    ["markdown and HTML", "*x* <b>_y_</b>", "#42;x#42; #60;b#62;#95;y#95;#60;#47;b#62;"],
    ["braces and a newline", "a{b}\nc", "a#123;b#125;#10;c"],
    ["non-ASCII letters", "Заказы_2024", "Заказы#95;2024"],
  ])("escapes %s in table, column and type names", (_, name, escaped) => {
    const diagram = erDiagram([table(name, [col(name, name)], [fk(name, [name], name)])]);
    expect(diagram.split("\n")).toEqual([
      "erDiagram",
      `  t0["${escaped}"] {`,
      `    \`${escaped}\` \`${escaped}\` FK`,
      "  }",
      `  t0 ||--o{ t0 : "${escaped}"`,
    ]);
  });

  it("stays valid Mermaid whatever the names", async () => {
    const mermaid = (await import("mermaid")).default;
    const names = [
      "order items",
      'say "hi"',
      "a`b",
      "50%\\off",
      "a#35;b",
      "*x* <b>_y_</b>",
      "a{b}\nc",
      "numeric(10,2)",
      "",
    ];
    const tables = names.map((name, i) =>
      table(name || `t${i}`, [col(name || "c", name)], [fk(name, [name || "c"], names[0]!)]),
    );
    await expect(mermaid.parse(erDiagram(tables))).resolves.toBeTruthy();
  });

  it("gives a column without a declared type (SQLite) a placeholder type, and an unnamed one a placeholder name", () => {
    expect(erDiagram([table("t", [col("x", "")])])).toContain("    `#63;` `x`");
    expect(erDiagram([table("t", [col("")])])).toContain("    `integer` `#63;`");
  });
});
