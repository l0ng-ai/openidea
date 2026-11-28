import { describe, expect, it } from "vitest";
import type { DbColumnInfo, DbDriver, DbIndexInfo, DbTableDetails } from "@/platform/ipc";
import {
  canAlterIndex,
  canChangePrimaryKey,
  createIndexSql,
  createTableKeySql,
  dropIndexSql,
  indexDraftOf,
  keyName,
  keySupport,
  type IndexDraft,
  grantMatrix,
  grantsSupported,
  hasTableProperties,
  propertySupport,
  tablePropertiesOf,
  type TableProperties,
  alterTableSql,
  canDrop,
  canModifyTable,
  createDatabaseSql,
  createSchemaSql,
  commentsSupported,
  createTableCommentSql,
  createTableSql,
  draftOf,
  dropDatabaseSql,
  templateOf,
  dropSql,
  ident,
  reference,
  canRename,
  renameSql,
  renameDatabaseSql,
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

  it("drops an Oracle package with neither IF EXISTS nor CASCADE", () => {
    expect(dropSql("oracle", { kind: "package", schema: "hr", name: "pkg" }, { ifExists: true, cascade: true })).toBe(
      'drop package "hr"."pkg";',
    );
    expect(reference("oracle", { kind: "package", schema: "hr", name: "pkg" })).toBe('"hr"."pkg"');
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

  it("renames schemas and databases where the server can", () => {
    const schema = { kind: "schema" as const, schema: "sales", name: "sales" };
    expect(canRename("postgres", schema)).toBe(true);
    expect(canRename("snowflake", schema)).toBe(true);
    expect(canRename("mysql", schema)).toBe(false);
    expect(canRename("sqlServer", schema)).toBe(false);
    expect(renameSql("postgres", schema, "Old Sales")).toBe('alter schema sales rename to "Old Sales";');
    expect(renameDatabaseSql("postgres", "shop", "store")).toBe("alter database shop rename to store;");
    expect(renameDatabaseSql("sqlServer", "shop", "store")).toBe("alter database shop modify name = store;");
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
      comment: "",
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

describe("keys and indexes in Modify Table (DataGrip)", () => {
  const drivers: DbDriver[] = ["sqlite", "postgres", "mysql", "sqlServer", "clickhouse", "oracle", "snowflake", "jdbc"];
  const schemaOf: Record<DbDriver, string> = {
    sqlite: "main",
    postgres: "public",
    mysql: "app",
    sqlServer: "dbo",
    clickhouse: "default",
    oracle: "APP",
    snowflake: "APP",
    jdbc: "app",
  };
  const index = (name: string, columns: string[], extra: Partial<DbIndexInfo> = {}): DbIndexInfo => ({
    name,
    unique: false,
    columns,
    ...extra,
  });
  const fresh = (
    kind: IndexDraft["kind"],
    name: string,
    columns: string[],
    unique = kind === "unique",
  ): IndexDraft => ({
    key: 100,
    kind,
    original: null,
    name,
    columns,
    unique,
    dropped: false,
  });
  /** `orders (id, code)` without a primary key, or keyed on `id`. */
  const orders = (keyed: boolean) =>
    [col("id", "int", { nullable: false, primaryKey: keyed }), col("code", "varchar(10)")].map(draftOf);

  it("offers per engine only what its ALTER TABLE can do", () => {
    const offered = Object.fromEntries(drivers.map((d) => [d, keySupport(d)]));
    expect(offered).toEqual({
      sqlite: { primaryKey: false, uniqueKey: false, index: true },
      postgres: { primaryKey: true, uniqueKey: true, index: true },
      mysql: { primaryKey: true, uniqueKey: true, index: true },
      sqlServer: { primaryKey: true, uniqueKey: true, index: true },
      clickhouse: { primaryKey: false, uniqueKey: false, index: false },
      oracle: { primaryKey: true, uniqueKey: true, index: true },
      snowflake: { primaryKey: true, uniqueKey: false, index: false },
      jdbc: { primaryKey: false, uniqueKey: false, index: false },
    });
  });

  it("adds a primary key to an existing table", () => {
    const sql = (driver: DbDriver) => {
      const d = orders(false);
      d[0] = { ...d[0]!, primaryKey: true };
      return alterTableSql(driver, schemaOf[driver], "orders", "orders", d, undefined, { indexes: [] });
    };
    expect(Object.fromEntries(drivers.map((d) => [d, sql(d)]))).toEqual({
      sqlite: [],
      postgres: ["alter table public.orders add constraint orders_pk primary key (id);"],
      mysql: ["alter table app.orders add primary key (id);"],
      sqlServer: ["alter table dbo.orders add constraint orders_pk primary key (id);"],
      clickhouse: [],
      oracle: ['alter table APP."orders" add constraint ORDERS_PK primary key ("id");'],
      snowflake: ['alter table APP."orders" add constraint ORDERS_PK primary key ("id");'],
      jdbc: [],
    });
  });

  it("drops a primary key by name where the engine needs it, and changes one by dropping and adding it", () => {
    const sql = (driver: DbDriver, primaryKeyName?: string) => {
      const d = orders(true);
      d[0] = { ...d[0]!, primaryKey: false };
      return alterTableSql(driver, schemaOf[driver], "orders", "orders", d, undefined, { primaryKeyName, indexes: [] });
    };
    expect(sql("postgres", "orders_pkey")).toEqual(["alter table public.orders drop constraint orders_pkey;"]);
    expect(sql("sqlServer", "PK__orders__3213E83F")).toEqual([
      "alter table dbo.orders drop constraint PK__orders__3213E83F;",
    ]);
    expect(sql("mysql")).toEqual(["alter table app.orders drop primary key;"]);
    expect(sql("oracle")).toEqual(['alter table APP."orders" drop primary key;']);
    expect(sql("snowflake")).toEqual(['alter table APP."orders" drop primary key;']);
    // Without the constraint's name there is nothing to drop it by: the key stays.
    expect(sql("postgres")).toEqual([]);
    expect(canChangePrimaryKey("postgres", orders(true))).toBe(false);
    expect(canChangePrimaryKey("postgres", orders(true), "orders_pkey")).toBe(true);
    expect(canChangePrimaryKey("postgres", orders(false))).toBe(true);
    expect(canChangePrimaryKey("mysql", orders(true))).toBe(true);
    expect(canChangePrimaryKey("sqlite", orders(false))).toBe(false);

    const d = orders(true);
    d[1] = { ...d[1]!, name: "sku", primaryKey: true, notNull: true };
    expect(
      alterTableSql("postgres", "public", "orders", "orders", d, undefined, {
        primaryKeyName: "orders_pkey",
        indexes: [],
      }),
    ).toEqual([
      "alter table public.orders drop constraint orders_pkey;",
      "alter table public.orders rename column code to sku;",
      "alter table public.orders alter column sku set not null;",
      "alter table public.orders add constraint orders_pk primary key (id, sku);",
    ]);
    // Renaming a key column keeps the key.
    const renamed = orders(true);
    renamed[0] = { ...renamed[0]!, name: "order_id" };
    expect(alterTableSql("mysql", "app", "orders", "orders", renamed, undefined, { indexes: [] })).toEqual([
      "alter table app.orders change column id order_id int not null;",
    ]);
  });

  it("adds and drops unique keys", () => {
    const add = (driver: DbDriver) =>
      alterTableSql(driver, schemaOf[driver], "orders", "orders", orders(false), undefined, {
        indexes: [fresh("unique", keyName(driver, "orders", "uk"), ["code"])],
      });
    expect(Object.fromEntries(drivers.map((d) => [d, add(d)]))).toEqual({
      sqlite: [],
      postgres: ["alter table public.orders add constraint orders_uk unique (code);"],
      mysql: ["alter table app.orders add constraint orders_uk unique (code);"],
      sqlServer: ["alter table dbo.orders add constraint orders_uk unique (code);"],
      clickhouse: [],
      oracle: ['alter table APP."orders" add constraint ORDERS_UK unique ("code");'],
      snowflake: [],
      jdbc: [],
    });
    const drop = (driver: DbDriver) => {
      const d = indexDraftOf(index("orders_code_key", ["code"], { unique: true, key: "unique" }), 1)!;
      return alterTableSql(driver, schemaOf[driver], "orders", "orders", orders(false), undefined, {
        indexes: [{ ...d, dropped: true }],
      });
    };
    expect(drop("postgres")).toEqual(["alter table public.orders drop constraint orders_code_key;"]);
    expect(drop("sqlServer")).toEqual(["alter table dbo.orders drop constraint orders_code_key;"]);
    expect(drop("oracle")).toEqual(['alter table APP."orders" drop constraint "orders_code_key";']);
    // MySQL's unique key is an index.
    expect(drop("mysql")).toEqual(["alter table app.orders drop index orders_code_key;"]);
    // SQLite keeps a UNIQUE constraint's index for good.
    expect(drop("sqlite")).toEqual([]);
  });

  it("creates and drops indexes, and keeps an existing one unless dropped", () => {
    const create = (driver: DbDriver) =>
      alterTableSql(driver, schemaOf[driver], "orders", "orders", orders(false), undefined, {
        indexes: [fresh("index", "orders_code_index", ["code", "id"], true)],
      });
    expect(Object.fromEntries(drivers.map((d) => [d, create(d)]))).toEqual({
      sqlite: ["create unique index orders_code_index on orders (code, id);"],
      postgres: ["create unique index orders_code_index on public.orders (code, id);"],
      mysql: ["create unique index orders_code_index on app.orders (code, id);"],
      sqlServer: ["create unique index orders_code_index on dbo.orders (code, id);"],
      clickhouse: [],
      oracle: ['create unique index APP."orders_code_index" on APP."orders" ("code", "id");'],
      snowflake: [],
      jdbc: [],
    });
    const drop = (driver: DbDriver) => {
      const d = indexDraftOf(index("orders_code", ["code"]), 1)!;
      return alterTableSql(driver, schemaOf[driver], "orders", "orders", orders(false), undefined, {
        indexes: [{ ...d, dropped: true }],
      });
    };
    expect(Object.fromEntries(drivers.map((d) => [d, drop(d)]))).toEqual({
      sqlite: ["drop index orders_code;"],
      postgres: ["drop index public.orders_code;"],
      mysql: ["drop index orders_code on app.orders;"],
      sqlServer: ["drop index orders_code on dbo.orders;"],
      clickhouse: [],
      oracle: ['drop index APP."orders_code";'],
      snowflake: [],
      jdbc: [],
    });
    // The catalog doesn't read all of an index (predicate, expressions): an existing one is never rebuilt.
    expect(
      alterTableSql("postgres", "public", "orders", "orders", orders(false), undefined, {
        indexes: [{ ...indexDraftOf(index("orders_code", ["code"]), 1)!, name: "renamed", unique: true }],
      }),
    ).toEqual([]);
  });

  it("drops keys and indexes before the column changes and adds them after, by the columns' new names", () => {
    const d = orders(false);
    d[0] = { ...d[0]!, dropped: true };
    d[1] = { ...d[1]!, name: "sku" };
    const old = { ...indexDraftOf(index("orders_id", ["id"]), 1)!, dropped: true };
    expect(
      alterTableSql("sqlite", "main", "orders", "items", d, undefined, {
        indexes: [old, fresh("index", "items_sku", ["sku"])],
      }),
    ).toEqual([
      "drop index orders_id;",
      "alter table orders drop column id;",
      "alter table orders rename column code to sku;",
      "create index items_sku on orders (sku);",
      "alter table orders rename to items;",
    ]);
  });

  it("leaves the primary key's index to the columns, and tells which existing ones it can change", () => {
    expect(indexDraftOf(index("orders_pkey", ["id"], { unique: true, key: "primary" }), 1)).toBeNull();
    const uk = indexDraftOf(index("sqlite_autoindex_orders_1", ["code"], { unique: true, key: "unique" }), 1)!;
    expect(uk.kind).toBe("unique");
    expect(canAlterIndex("sqlite", uk)).toBe(false);
    expect(canAlterIndex("postgres", uk)).toBe(true);
    expect(canAlterIndex("sqlite", indexDraftOf(index("orders_code", ["code"]), 1)!)).toBe(true);
  });

  it("names indexes in their schema where the engine does, and drops SQL Server's within its table", () => {
    const i = { name: "ix", unique: false, columns: ["a"] };
    expect(createIndexSql("sqlite", "aux", "t", i)).toBe("create index aux.ix on t (a);");
    expect(createIndexSql("postgres", "s", "t", i)).toBe("create index ix on s.t (a);");
    expect(dropIndexSql("sqlServer", "dbo", "t", "ix")).toBe("drop index ix on dbo.t;");
    expect(
      dropSql(
        "sqlServer",
        { kind: "index", schema: "dbo", name: "ix", table: "t" },
        { ifExists: true, cascade: false },
      ),
    ).toBe("drop index if exists ix on dbo.t;");
  });

  it("adds a new table's unique keys and indexes after its create table", () => {
    expect(
      createTableKeySql("postgres", "public", "orders", [
        fresh("unique", "orders_uk", ["code"]),
        fresh("index", "orders_index", ["id"], false),
      ]),
    ).toEqual([
      "alter table public.orders add constraint orders_uk unique (code);",
      "create index orders_index on public.orders (id);",
    ]);
  });
});

describe("table and column comments", () => {
  const commented = [col("id", "INTEGER", { primaryKey: true }), col("note", "TEXT", { comment: "Free text" })];

  it("sets, changes and clears comments per engine", () => {
    const p = commented.map(draftOf);
    p[0] = { ...p[0]!, comment: "Order's id" };
    p[1] = { ...p[1]!, comment: "" };
    const table = { original: "", value: "Orders" };
    expect(alterTableSql("postgres", "public", "t", "t", p, table)).toEqual([
      "comment on table public.t is 'Orders';",
      "comment on column public.t.id is 'Order''s id';",
      "comment on column public.t.note is null;",
    ]);
    expect(alterTableSql("oracle", "HR", "T", "T", p, { original: "Old", value: "" })).toEqual([
      "comment on table HR.T is '';",
      "comment on column HR.T.\"id\" is 'Order''s id';",
      "comment on column HR.T.\"note\" is '';",
    ]);
    expect(alterTableSql("snowflake", "HR", "T", "T", p, { original: "Old", value: "" })).toEqual([
      "alter table HR.T unset comment;",
      "comment on column HR.T.\"id\" is 'Order''s id';",
      'alter table HR.T alter column "note" unset comment;',
    ]);
    // MySQL keeps a column's comment in its definition.
    expect(alterTableSql("mysql", "app", "t", "t", p, { original: "", value: "a\\b" })).toEqual([
      "alter table app.t change column id id INTEGER comment 'Order''s id';",
      "alter table app.t change column note note TEXT;",
      "alter table app.t comment = 'a\\\\b';",
    ]);
    expect(alterTableSql("sqlite", "main", "t", "t", p, table)).toEqual([]);
  });

  it("keeps an unchanged comment, and comments a renamed column by its new name", () => {
    const p = commented.map(draftOf);
    expect(alterTableSql("postgres", "public", "t", "t", p, { original: "Orders", value: "Orders" })).toEqual([]);
    // A MySQL change of type keeps the column's comment.
    p[1] = { ...p[1]!, dataType: "varchar(40)" };
    expect(alterTableSql("mysql", "app", "t", "t", p)).toEqual([
      "alter table app.t change column note note varchar(40) comment 'Free text';",
    ]);
    p[1] = { ...commented.map(draftOf)[1]!, name: "body", comment: "Body" };
    expect(alterTableSql("postgres", "public", "t", "renamed", p)).toEqual([
      "alter table public.t rename column note to body;",
      "comment on column public.t.body is 'Body';",
      "alter table public.t rename to renamed;",
    ]);
  });

  it("comments a new table", () => {
    const d = commented.map((c) => ({ ...draftOf(c, 0), original: null }));
    expect(createTableSql("mysql", "app", "t", d, "Orders")).toBe(
      "create table app.t\n(\n    id INTEGER,\n    note TEXT comment 'Free text',\n    primary key (id)\n)\ncomment = 'Orders';\n",
    );
    expect(createTableCommentSql("mysql", "app", "t", d, "Orders")).toEqual([]);
    expect(createTableCommentSql("postgres", "public", "t", d, "Orders")).toEqual([
      "comment on table public.t is 'Orders';",
      "comment on column public.t.note is 'Free text';",
    ]);
    expect(createTableCommentSql("postgres", "public", "t", d, "")).toEqual([
      "comment on column public.t.note is 'Free text';",
    ]);
    expect(commentsSupported("sqlite")).toBe(false);
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
      comment: "",
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

describe("snowflake object SQL", () => {
  const emp = [
    col("ID", "NUMBER(38,0)", { primaryKey: true, nullable: false }),
    col("NAME", "VARCHAR(40)", { default: "'x'" }),
  ];
  const drop = { ifExists: true, cascade: true };

  it("keeps unquoted names that the server folds to upper case", () => {
    expect(ident("snowflake", "EMPLOYEES")).toBe("EMPLOYEES");
    expect(ident("snowflake", "EMP_2$")).toBe("EMP_2$");
    expect(ident("snowflake", "employees")).toBe('"employees"');
    expect(ident("snowflake", "My Table")).toBe('"My Table"');
    expect(ident("snowflake", 'a"b')).toBe('"a""b"');
    expect(ident("snowflake", "QUALIFY")).toBe('"QUALIFY"');
    expect(ident("snowflake", "ORDER")).toBe('"ORDER"');
    expect(quoteIdent("snowflake", "x")).toBe('"x"');
    expect(reference("snowflake", { kind: "column", schema: "HR", name: "EMPLOYEES", column: "name" })).toBe(
      'HR.EMPLOYEES."name"',
    );
  });

  it("renames within the object's schema", () => {
    expect(renameSql("snowflake", { kind: "table", schema: "HR", name: "EMP" }, "STAFF")).toBe(
      "alter table HR.EMP rename to HR.STAFF;",
    );
    expect(renameSql("snowflake", { kind: "view", schema: "HR", name: "V_EMP" }, "V_STAFF")).toBe(
      "alter view HR.V_EMP rename to HR.V_STAFF;",
    );
    expect(renameSql("snowflake", { kind: "column", schema: "HR", name: "EMP", column: "A" }, "b")).toBe(
      'alter table HR.EMP rename column A to "b";',
    );
  });

  it("drops and truncates, and has no indexes or triggers", () => {
    expect(dropSql("snowflake", { kind: "table", schema: "HR", name: "EMP" }, drop)).toBe(
      "drop table if exists HR.EMP;",
    );
    expect(dropSql("snowflake", { kind: "view", schema: "HR", name: "V" }, drop)).toBe("drop view if exists HR.V;");
    expect(dropSql("snowflake", { kind: "materializedView", schema: "HR", name: "MV" }, drop)).toBe(
      "drop materialized view if exists HR.MV;",
    );
    expect(dropSql("snowflake", { kind: "sequence", schema: "HR", name: "S" }, drop)).toBe(
      "drop sequence if exists HR.S;",
    );
    expect(
      dropSql("snowflake", { kind: "function", schema: "HR", name: "F", arguments: "NUMBER, VARCHAR" }, drop),
    ).toBe("drop function if exists HR.F(NUMBER, VARCHAR);");
    expect(dropSql("snowflake", { kind: "procedure", schema: "HR", name: "P" }, { ...drop, ifExists: false })).toBe(
      "drop procedure HR.P();",
    );
    expect(dropSql("snowflake", { kind: "column", schema: "HR", name: "EMP", column: "NAME" }, drop)).toBe(
      "alter table HR.EMP drop column NAME;",
    );
    expect(dropSql("snowflake", { kind: "schema", schema: "", name: "HR" }, drop)).toBe("drop schema if exists HR;");
    expect(truncateSql("snowflake", "HR", "EMP", { restartIdentity: true, cascade: true })).toBe(
      "truncate table HR.EMP;",
    );
    expect(canDrop("snowflake", { kind: "index", schema: "HR", name: "I" })).toBe(false);
    expect(canDrop("snowflake", { kind: "trigger", schema: "HR", name: "T" })).toBe(false);
    expect(canDrop("snowflake", { kind: "table", schema: "HR", name: "EMP" })).toBe(true);
    expect(canModifyTable("snowflake")).toBe(true);
  });

  it("creates tables and script templates", () => {
    const d = emp.map(draftOf);
    d.push({ ...d[1]!, key: 9, original: null, name: "note", dataType: "", default: "", notNull: true });
    expect(createTableSql("snowflake", "HR", "T", d)).toBe(
      "create table HR.T\n(\n    ID NUMBER(38,0) not null,\n    NAME VARCHAR(40) default 'x',\n" +
        '    "note" VARCHAR not null,\n    primary key (ID)\n);\n',
    );
    expect(scriptSql("snowflake", "selectFirst", "HR", "EMP", emp)).toBe("select *\nfrom HR.EMP\nlimit 10;\n");
  });

  it("alters columns with ALTER COLUMN and never sets a default on an existing column", () => {
    const p = emp.map(draftOf);
    p[0] = { ...p[0]!, notNull: false, default: "1" };
    p[1] = { ...p[1]!, name: "FULL_NAME", dataType: "VARCHAR(80)", notNull: true, default: "" };
    p.push({
      key: 99,
      original: null,
      name: "HIRED",
      dataType: "DATE",
      notNull: false,
      default: "CURRENT_DATE",
      primaryKey: false,
      comment: "",
      dropped: false,
    } satisfies ColumnDraft);
    expect(alterTableSql("snowflake", "HR", "EMP", "STAFF", p)).toEqual([
      "alter table HR.EMP alter column ID drop not null;",
      "alter table HR.EMP rename column NAME to FULL_NAME;",
      "alter table HR.EMP alter column FULL_NAME set data type VARCHAR(80);",
      "alter table HR.EMP alter column FULL_NAME set not null;",
      "alter table HR.EMP alter column FULL_NAME drop default;",
      "alter table HR.EMP add column HIRED DATE default CURRENT_DATE;",
      "alter table HR.EMP rename to HR.STAFF;",
    ]);
    const dropped = emp.map(draftOf);
    dropped[1] = { ...dropped[1]!, dropped: true };
    expect(alterTableSql("snowflake", "HR", "EMP", "EMP", dropped)).toEqual(["alter table HR.EMP drop column NAME;"]);
  });
});

describe("database and schema SQL", () => {
  it("creates a PostgreSQL database with only the options given", () => {
    expect(createDatabaseSql("postgres", "shop", {})).toBe("create database shop;");
    expect(
      createDatabaseSql("postgres", "Shop Copy", {
        owner: "app",
        template: "template0",
        encoding: "UTF8",
        tablespace: " ",
      }),
    ).toBe(`create database "Shop Copy" owner app template template0 encoding 'UTF8';`);
    expect(createDatabaseSql("postgres", "shop", { encoding: "it's" })).toBe("create database shop encoding 'it''s';");
  });

  it("names the database the server copies for a new one", () => {
    expect(templateOf("postgres", {})).toBe("template1");
    expect(templateOf("postgres", { template: "template0" })).toBe("template0");
    expect(templateOf("sqlServer", { template: "ignored" })).toBe("model");
  });

  it("creates a SQL Server database with a collation", () => {
    expect(createDatabaseSql("sqlServer", "shop", { collation: "Latin1_General_CI_AS", owner: "ignored" })).toBe(
      "create database shop collate Latin1_General_CI_AS;",
    );
  });

  it("creates a schema with an owner, and a MySQL schema as a database", () => {
    expect(createSchemaSql("postgres", "sales", {})).toBe("create schema sales;");
    expect(createSchemaSql("postgres", "sales", { owner: "app" })).toBe("create schema sales authorization app;");
    expect(createSchemaSql("sqlServer", "sales", { owner: "dbo" })).toBe("create schema sales authorization dbo;");
    expect(createSchemaSql("mysql", "shop", { charset: "utf8mb4", collation: "utf8mb4_0900_ai_ci" })).toBe(
      "create database shop character set utf8mb4 collate utf8mb4_0900_ai_ci;",
    );
    expect(createSchemaSql("mysql", "shop", {})).toBe("create database shop;");
  });

  it("drops a database, forcing out other sessions when asked", () => {
    expect(dropDatabaseSql("postgres", "shop", false)).toBe("drop database shop;");
    expect(dropDatabaseSql("postgres", "shop", true)).toBe("drop database shop with (force);");
    expect(dropDatabaseSql("sqlServer", "shop", false)).toBe("drop database shop;");
    expect(dropDatabaseSql("sqlServer", "shop", true)).toBe(
      "alter database shop set single_user with rollback immediate;\ndrop database shop;",
    );
  });
});

describe("table properties in Modify Table", () => {
  const details = (extra: Partial<DbTableDetails> = {}): DbTableDetails => ({
    columns: users,
    indexes: [],
    foreignKeys: [],
    triggers: [],
    ...extra,
  });
  const bulk = details({
    owner: "loader",
    tablespace: "pg_default",
    accessMethod: "heap",
    storageOptions: [
      ["fillfactor", "70"],
      ["toast.autovacuum_enabled", "false"],
    ],
    persistence: "unlogged",
  });
  const original = tablePropertiesOf(bulk);
  const alter = (value: Partial<TableProperties>, name = "bulk", driver: DbDriver = "postgres") =>
    alterTableSql(driver, "public", "bulk", name, users.map(draftOf), undefined, undefined, {
      original,
      value: { ...original, ...value },
    });

  it("shows the properties the catalog reports", () => {
    expect(original).toEqual({
      owner: "loader",
      tablespace: "pg_default",
      storageOptions: "fillfactor=70, toast.autovacuum_enabled=false",
      persistence: "unlogged",
    });
    expect(hasTableProperties(bulk)).toBe(true);
    // SQLite reports none, so the dialog has no Properties tab and no empty Owner field.
    expect(hasTableProperties(details())).toBe(false);
    expect(hasTableProperties(undefined)).toBe(false);
  });

  it.each<[string, Partial<TableProperties>, string[]]>([
    ["nothing changed", {}, []],
    ["the owner", { owner: "Reporting" }, ['alter table public.bulk owner to "Reporting";']],
    ["the tablespace", { tablespace: "fast_ssd" }, ["alter table public.bulk set tablespace fast_ssd;"]],
    ["logged", { persistence: "permanent" }, ["alter table public.bulk set logged;"]],
    [
      "a storage option",
      { storageOptions: "fillfactor=50, toast.autovacuum_enabled=false" },
      ["alter table public.bulk set (fillfactor = 50);"],
    ],
    [
      "options removed and added",
      { storageOptions: " autovacuum_enabled = off, vacuum_truncate=true" },
      [
        "alter table public.bulk reset (fillfactor, toast.autovacuum_enabled);",
        "alter table public.bulk set (autovacuum_enabled = off, vacuum_truncate = true);",
      ],
    ],
    [
      "a quoted option value",
      { storageOptions: "fillfactor=70, x=a b" },
      ["alter table public.bulk reset (toast.autovacuum_enabled);", "alter table public.bulk set (x = 'a b');"],
    ],
    // A cleared field is left as it was: a table always has an owner and a tablespace.
    ["cleared owner and tablespace", { owner: " ", tablespace: "" }, []],
  ])("changes %s", (_, value, sql) => {
    expect(alter(value)).toEqual(sql);
  });

  it("changes the owner after a rename, the storage before it", () => {
    expect(alter({ owner: "admin", persistence: "permanent" }, "bulk_load")).toEqual([
      "alter table public.bulk set logged;",
      "alter table public.bulk rename to bulk_load;",
      "alter table public.bulk_load owner to admin;",
    ]);
  });

  it("keeps a temporary table temporary", () => {
    const temp = tablePropertiesOf(details({ persistence: "temporary" }));
    expect(
      alterTableSql("postgres", "public", "t", "t", [], undefined, undefined, {
        original: temp,
        value: { ...temp, persistence: "unlogged" },
      }),
    ).toEqual([]);
  });

  it.each<DbDriver>(["mysql", "sqlite", "oracle", "sqlServer", "snowflake", "clickhouse"])(
    "changes no property on %s",
    (driver) => {
      expect(Object.values(propertySupport(driver)).some(Boolean)).toBe(false);
      expect(
        alter({ owner: "x", tablespace: "y", storageOptions: "", persistence: "permanent" }, "bulk", driver),
      ).toEqual([]);
    },
  );
});

describe("table grants", () => {
  it("groups privileges per grantee and grantor in the standard order", () => {
    const grant = (grantee: string, privilege: string, grantable = false, grantor: string | null = "admin") => ({
      grantee,
      grantor,
      privilege,
      grantable,
    });
    const { privileges, rows } = grantMatrix([
      grant("writer", "UPDATE", true),
      grant("reader", "SELECT"),
      grant("writer", "INSERT"),
      grant("writer", "SHOW VIEW"),
      grant("writer", "MAINTAIN"),
      grant("reader", "SELECT", false, "other"),
    ]);
    expect(privileges).toEqual(["SELECT", "INSERT", "UPDATE", "MAINTAIN", "SHOW VIEW"]);
    expect(rows.map((r) => [r.grantee, r.grantor, Object.fromEntries(r.privileges)])).toEqual([
      ["writer", "admin", { UPDATE: true, INSERT: false, "SHOW VIEW": false, MAINTAIN: false }],
      ["reader", "admin", { SELECT: false }],
      ["reader", "other", { SELECT: false }],
    ]);
  });

  it("queries only the engines with per-table privileges", () => {
    expect(grantsSupported("postgres")).toBe(true);
    expect(grantsSupported("mysql")).toBe(true);
    expect(grantsSupported("sqlite")).toBe(false);
    expect(grantsSupported("clickhouse")).toBe(false);
  });
});
