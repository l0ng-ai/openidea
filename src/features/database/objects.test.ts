import { describe, expect, it } from "vitest";
import type { DbColumnInfo } from "@/platform/ipc";
import {
  alterTableSql,
  canDrop,
  canModifyTable,
  createTableSql,
  draftOf,
  dropSql,
  ident,
  reference,
  renameSql,
  scriptSql,
  truncateSql,
  quoteIdent,
  type ColumnDraft,
} from "./objects";

const col = (name: string, dataType: string, extra: Partial<DbColumnInfo> = {}): DbColumnInfo => ({
  name,
  dataType,
  nullable: true,
  default: null,
  primaryKey: false,
  ...extra,
});

const users = [
  col("id", "INTEGER", { primaryKey: true, nullable: false }),
  col("email", "TEXT", { nullable: false }),
  col("name", "TEXT"),
];

describe("database object SQL", () => {
  it("uses ClickHouse object syntax and escapes identifiers", () => {
    expect(quoteIdent("clickhouse", 'a\\b"c')).toBe('"a\\\\b\\"c"');
    expect(ident("clickhouse", "price$usd")).toBe('"price$usd"');
    expect(renameSql("clickhouse", { kind: "table", schema: "default", name: "users" }, "people")).toBe(
      'rename table "default".users to "default".people;',
    );
    expect(
      dropSql("clickhouse", { kind: "schema", schema: "", name: "analytics" }, { ifExists: true, cascade: true }),
    ).toBe("drop database if exists analytics;");
    expect(
      dropSql(
        "clickhouse",
        { kind: "materializedView", schema: "default", name: "totals" },
        { ifExists: true, cascade: true },
      ),
    ).toBe('drop table if exists "default".totals;');
    expect(truncateSql("clickhouse", "default", "users", { restartIdentity: true, cascade: true })).toBe(
      'truncate table "default".users;',
    );
    expect(canDrop("clickhouse", { kind: "index", schema: "default", name: "ix" })).toBe(false);
    expect(canModifyTable("clickhouse")).toBe(false);
    expect(alterTableSql("clickhouse", "default", "users", "people", users.map(draftOf))).toEqual([]);
  });

  it("creates ClickHouse MergeTree tables without a relational primary key", () => {
    const drafts = [col("id", "UInt64", { primaryKey: true, nullable: false }), col("name", "Nullable(String)")].map(
      draftOf,
    );
    expect(createTableSql("clickhouse", "default", "people", drafts)).toBe(
      'create table "default".people\n(\n    id UInt64,\n    name Nullable(String)\n)\nengine = MergeTree\norder by tuple();\n',
    );
  });

  it("writes guarded ClickHouse mutation templates without unique key assumptions", () => {
    expect(scriptSql("clickhouse", "update", "default", "users", users)).toBe(
      'alter table "default".users\nupdate email = ?,\n       name = ?\nwhere 1 = 0;\n',
    );
    expect(scriptSql("clickhouse", "delete", "default", "users", users)).toBe(
      'alter table "default".users\ndelete\nwhere 1 = 0;\n',
    );
    expect(() => scriptSql("clickhouse", "update", "default", "users", users.slice(0, 1))).toThrow(
      "ClickHouse sorting key columns cannot be updated.",
    );
  });

  it("quotes only when needed", () => {
    expect(ident("postgres", "users")).toBe("users");
    expect(ident("postgres", "Users")).toBe('"Users"');
    expect(ident("sqlite", "order")).toBe('"order"');
    expect(ident("mysql", "my table")).toBe("`my table`");
  });

  it("copies references", () => {
    expect(reference("sqlite", { kind: "table", schema: "main", name: "users" })).toBe("users");
    expect(reference("postgres", { kind: "column", schema: "public", name: "users", column: "email" })).toBe(
      "public.users.email",
    );
  });

  it("renames per dialect", () => {
    expect(renameSql("sqlite", { kind: "table", schema: "main", name: "users" }, "people")).toBe(
      "alter table users rename to people;",
    );
    expect(renameSql("mysql", { kind: "table", schema: "app", name: "users" }, "people")).toBe(
      "rename table app.users to app.people;",
    );
    expect(renameSql("postgres", { kind: "column", schema: "public", name: "users", column: "email" }, "mail")).toBe(
      "alter table public.users rename column email to mail;",
    );
  });

  it("drops with IF EXISTS / CASCADE", () => {
    const t = { kind: "table" as const, schema: "public", name: "users" };
    expect(dropSql("postgres", t, { ifExists: true, cascade: true })).toBe(
      "drop table if exists public.users cascade;",
    );
    expect(dropSql("sqlite", { ...t, schema: "main" }, { ifExists: false, cascade: true })).toBe("drop table users;");
    expect(
      dropSql(
        "mysql",
        { kind: "index", schema: "app", name: "ix", table: "users" },
        { ifExists: false, cascade: false },
      ),
    ).toBe("drop index ix on app.users;");
    expect(
      dropSql(
        "sqlite",
        { kind: "column", schema: "main", name: "users", column: "name" },
        { ifExists: true, cascade: false },
      ),
    ).toBe("alter table users drop column name;");
  });

  it("truncates (SQLite deletes)", () => {
    expect(truncateSql("sqlite", "main", "users", { restartIdentity: true, cascade: true })).toBe("delete from users;");
    expect(truncateSql("postgres", "public", "users", { restartIdentity: true, cascade: false })).toBe(
      "truncate table public.users restart identity;",
    );
  });

  it("writes script templates keyed by the primary key", () => {
    expect(scriptSql("sqlite", "selectFirst", "main", "users", users)).toBe("select *\nfrom users\nlimit 10;\n");
    expect(scriptSql("sqlite", "insert", "main", "users", users)).toBe(
      "insert into users (id, email, name)\nvalues (?, ?, ?);\n",
    );
    expect(scriptSql("sqlite", "update", "main", "users", users)).toBe(
      "update users\nset email = ?,\n    name = ?\nwhere id = ?;\n",
    );
    expect(scriptSql("sqlite", "delete", "main", "users", users)).toBe("delete\nfrom users\nwhere id = ?;\n");
  });

  it("creates tables", () => {
    const drafts: ColumnDraft[] = users.map(draftOf);
    expect(createTableSql("sqlite", "main", "people", drafts)).toBe(
      "create table people\n(\n    id INTEGER not null,\n    email TEXT not null,\n    name TEXT,\n    primary key (id)\n);\n",
    );
  });

  it("alters tables: SQLite renames / adds / drops, PostgreSQL also changes columns", () => {
    const d = users.map(draftOf);
    d[1] = { ...d[1]!, name: "mail" };
    d[2] = { ...d[2]!, dropped: true };
    d.push({
      key: 9,
      original: null,
      name: "age",
      dataType: "INTEGER",
      notNull: false,
      default: "0",
      primaryKey: false,
      dropped: false,
    });
    expect(alterTableSql("sqlite", "main", "users", "people", d)).toEqual([
      "alter table users rename column email to mail;",
      "alter table users drop column name;",
      "alter table users add column age INTEGER default 0;",
      "alter table users rename to people;",
    ]);
    const p = users.map(draftOf);
    p[2] = { ...p[2]!, dataType: "varchar(40)", notNull: true, default: "''" };
    expect(alterTableSql("postgres", "public", "users", "users", p)).toEqual([
      "alter table public.users alter column name type varchar(40);",
      "alter table public.users alter column name set not null;",
      "alter table public.users alter column name set default '';",
    ]);
    expect(alterTableSql("mysql", "app", "users", "users", p)).toEqual([
      "alter table app.users change column name name varchar(40) default '' not null;",
    ]);
  });
});

describe("oracle object SQL", () => {
  const emp = [col("ID", "NUMBER", { primaryKey: true, nullable: false }), col("NAME", "VARCHAR2(40)")];
  const d = emp.map(draftOf);

  it("keeps unquoted names that the server folds to upper case", () => {
    expect(ident("oracle", "EMPLOYEES")).toBe("EMPLOYEES");
    expect(ident("oracle", "employees")).toBe('"employees"');
    expect(reference("oracle", { kind: "table", schema: "HR", name: "EMPLOYEES" })).toBe("HR.EMPLOYEES");
  });

  it("generates Oracle DDL and DML", () => {
    expect(truncateSql("oracle", "HR", "EMPLOYEES", { restartIdentity: true, cascade: true })).toBe(
      "truncate table HR.EMPLOYEES;",
    );
    expect(scriptSql("oracle", "selectFirst", "HR", "EMPLOYEES", emp)).toContain("fetch first 10 rows only;");
    expect(scriptSql("oracle", "selectFirst", "HR", "EMPLOYEES", emp)).not.toContain("limit");
    expect(dropSql("oracle", { kind: "index", schema: "HR", name: "E_IDX" }, { ifExists: true, cascade: false })).toBe(
      "drop index HR.E_IDX;",
    );
    expect(dropSql("oracle", { kind: "schema", schema: "", name: "APP" }, { ifExists: false, cascade: false })).toBe(
      "drop user APP cascade;",
    );
    expect(renameSql("oracle", { kind: "view", schema: "HR", name: "V_EMP" }, "V_STAFF")).toBe(
      "rename HR.V_EMP to V_STAFF;",
    );
    expect(createTableSql("oracle", "HR", "T", d)).toContain("primary key (ID)");
  });

  it("alters columns with MODIFY and parenthesised ADD", () => {
    const p = emp.map(draftOf);
    p[1] = { ...p[1]!, dataType: "VARCHAR2(80)", notNull: true, name: "FULL_NAME" };
    p.push({
      key: 99,
      original: null,
      name: "HIRED",
      dataType: "DATE",
      notNull: false,
      default: "SYSDATE",
      primaryKey: false,
      dropped: false,
    } satisfies ColumnDraft);
    expect(alterTableSql("oracle", "HR", "EMPLOYEES", "EMPLOYEES", p)).toEqual([
      "alter table HR.EMPLOYEES modify (NAME VARCHAR2(80) not null);",
      "alter table HR.EMPLOYEES modify (NAME not null);",
      "alter table HR.EMPLOYEES rename column NAME to FULL_NAME;",
      "alter table HR.EMPLOYEES add (HIRED DATE default SYSDATE);",
    ]);
  });
});
