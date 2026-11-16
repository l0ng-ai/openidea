import { describe, expect, it } from "vitest";
import type { DbColumnInfo } from "@/platform/ipc";
import { diffSchemas, differenceKeys, migrationSql, type TableSnapshot } from "./schemaCompare";

const col = (name: string, dataType: string, extra: Partial<DbColumnInfo> = {}): DbColumnInfo => ({
  name,
  dataType,
  nullable: true,
  default: null,
  primaryKey: false,
  ...extra,
});

const users = (columns: DbColumnInfo[], indexes: TableSnapshot["indexes"] = []): TableSnapshot => ({
  name: "users",
  kind: "table",
  columns,
  indexes,
  foreignKeys: [],
});

const SOURCE: TableSnapshot[] = [
  users(
    [
      col("id", "int", { nullable: false, primaryKey: true }),
      col("email", "varchar(255)", { nullable: false }),
      col("age", "int", { default: "0" }),
    ],
    [
      { name: "PRIMARY", unique: true, columns: ["id"] },
      { name: "users_email", unique: true, columns: ["email"] },
    ],
  ),
  {
    name: "orders",
    kind: "table",
    columns: [col("id", "int", { nullable: false, primaryKey: true }), col("user_id", "int")],
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["id"] },
      { name: "orders_user", unique: false, columns: ["user_id"] },
    ],
    foreignKeys: [
      { schema: "app", table: "orders", columns: ["user_id"], refSchema: "app", refTable: "users", refColumns: ["id"] },
    ],
  },
];

const TARGET: TableSnapshot[] = [
  users(
    [col("ID", "INT", { nullable: false, primaryKey: true }), col("email", "varchar(100)"), col("nickname", "text")],
    [{ name: "PRIMARY", unique: true, columns: ["id"] }],
  ),
  { name: "legacy", kind: "table", columns: [col("x", "int")], indexes: [], foreignKeys: [] },
];

describe("Compare Structure", () => {
  const diffs = diffSchemas(SOURCE, TARGET);

  it("lists added, removed and changed tables with their column and index differences", () => {
    expect(diffs.map((d) => `${d.name}:${d.state}`)).toEqual(["legacy:removed", "orders:added", "users:changed"]);
    const u = diffs.find((d) => d.name === "users")!;
    expect(u.columns.map((c) => `${c.name}:${c.state}:${c.changes.join("+")}`)).toEqual([
      "id:same:",
      "email:changed:type+nullable",
      "age:added:",
      "nickname:removed:",
    ]);
    expect(u.indexes.map((i) => `${i.name}:${i.state}`)).toEqual(["PRIMARY:same", "users_email:added"]);
  });

  it("writes the migration of the selected differences for the target's dialect", () => {
    const all = migrationSql("mysql", "app", diffs, differenceKeys(diffs));
    expect(all).toBe(
      [
        "drop table app.legacy;",
        "create table app.orders\n(\n    id int not null,\n    user_id int,\n    primary key (id)\n);",
        "alter table app.users change column email email varchar(255) not null;",
        "alter table app.users add column age int default 0;",
        "alter table app.users drop column nickname;",
        "create index orders_user on app.orders (user_id);",
        "alter table app.orders add foreign key (user_id) references app.users (id);",
        "create unique index users_email on app.users (email);",
        "",
      ].join("\n"),
    );
    // Only what is picked; identical items never produce SQL.
    const some = migrationSql("postgres", "public", diffs, new Set(["c:users.age", "c:users.id", "t:legacy"]));
    expect(some).toBe("drop table public.legacy;\nalter table public.users add column age int default 0;\n");
  });
});
