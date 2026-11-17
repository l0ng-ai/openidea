import { describe, expect, it } from "vitest";
import type { DataSource, DbTableInfo } from "@/platform/ipc";
import {
  DEFAULT_DUMP,
  DEFAULT_RESTORE,
  baseName,
  dumpMismatch,
  dumpOptions,
  dumpScope,
  formatElapsed,
  majorOf,
  outputPath,
  pickInstall,
  restoreOptions,
  restoreToolFor,
  versionFit,
  withExtension,
} from "./dumpTools";

const pg = { id: "s1", name: "Shop / dev", driver: "postgres", host: "localhost", user: "app" } as DataSource;

describe("forms", () => {
  it("keep quoted names whole", () => {
    const options = dumpOptions({
      ...DEFAULT_DUMP,
      schemas: '"My Schema", audit',
      tables: 'public."Order Items" "a,""b"".c"',
      excludeTables: "",
    });
    expect(options.schemas).toEqual(['"My Schema"', "audit"]);
    expect(options.tables).toEqual(['public."Order Items"', '"a,""b"".c"']);
  });

  it("send the typed name lists as lists", () => {
    const options = dumpOptions({
      ...DEFAULT_DUMP,
      schemas: "public, audit",
      tables: " public.orders ",
      excludeTables: "",
    });
    expect([options.schemas, options.tables, options.excludeTables]).toEqual([
      ["public", "audit"],
      ["public.orders"],
      [],
    ]);
    expect(restoreOptions({ ...DEFAULT_RESTORE, schemas: "a b" }).schemas).toEqual(["a", "b"]);
  });
});

describe("restore", () => {
  it("picks psql for .sql files and pg_restore for the rest", () => {
    expect(restoreToolFor("/tmp/a.SQL")).toBe("psql");
    expect(restoreToolFor("/tmp/a.dump")).toBe("pgRestore");
    expect(restoreToolFor("/tmp/dir")).toBe("pgRestore");
  });

  it("trusts the dump's header over its extension", () => {
    expect(restoreToolFor("/tmp/a.backup", "postgresSql")).toBe("psql");
    expect(restoreToolFor("/tmp/a.sql", "postgresArchive")).toBe("pgRestore");
  });

  it("refuses a dump the tool cannot read", () => {
    expect(dumpMismatch("psql", "mysqlSql")).toBe("mysqlIntoPostgres");
    expect(dumpMismatch("psql", "postgresArchive")).toBe("archiveIntoPsql");
    expect(dumpMismatch("pgRestore", "postgresSql")).toBe("sqlIntoPgRestore");
    expect(dumpMismatch("psql", "postgresSql")).toBeNull();
    expect(dumpMismatch("psql", "unknown")).toBeNull();
    expect(dumpMismatch("pgRestore", null)).toBeNull();
  });
});

describe("paths", () => {
  it("fills the patterns with file-safe values", () => {
    const now = new Date(2026, 2, 7, 9, 5, 2);
    expect(
      outputPath("/tmp/{data_source}-{database}-{timestamp}.sql", { dataSource: "Shop / dev", database: "shop", now }),
    ).toBe("/tmp/Shop_dev-shop-2026-03-07_09-05-02.sql");
  });

  it("follows the format's extension", () => {
    expect(withExtension("/tmp/x-{timestamp}.sql", "custom")).toBe("/tmp/x-{timestamp}.dump");
    expect(withExtension("/tmp/x.dump", "directory")).toBe("/tmp/x");
    expect(withExtension("/tmp/x", "plain")).toBe("/tmp/x.sql");
  });
});

describe("dumpScope", () => {
  const table = { name: "Orders", kind: "table" } as DbTableInfo;

  it("applies to PostgreSQL sources, databases, schemas and tables", () => {
    const shop = { ...pg, database: "shop" };
    expect(dumpScope({ kind: "source", key: "s1", source: shop }, shop)).toEqual({ target: "s1", database: "shop" });
    expect(dumpScope({ kind: "database", key: "k", id: "s1:crm", name: "crm", current: false }, pg)).toEqual({
      target: "s1:crm",
      database: "crm",
    });
    expect(dumpScope({ kind: "schema", key: "k", id: "s1:crm", schema: "public" }, pg)).toMatchObject({
      schemas: "public",
    });
    expect(dumpScope({ kind: "table", key: "k", id: "s1:crm", schema: "public", table }, pg)).toMatchObject({
      tables: 'public."Orders"',
    });
  });

  it("does not apply to other drivers or views", () => {
    const mysql = { ...pg, driver: "mysql" } as DataSource;
    expect(dumpScope({ kind: "source", key: "s1", source: mysql }, mysql)).toBeNull();
    const view = { ...table, kind: "view" } as DbTableInfo;
    expect(dumpScope({ kind: "table", key: "k", id: "s1", schema: "public", table: view }, pg)).toBeNull();
  });
});

describe("client and server versions", () => {
  const installs = [
    { path: "/opt/homebrew/bin/pg_dump", version: "pg_dump (PostgreSQL) 18.4 (Homebrew)" },
    { path: "/opt/homebrew/opt/postgresql@15/bin/pg_dump", version: "pg_dump (PostgreSQL) 15.13 (Homebrew)" },
  ];

  it("reads the major version", () => {
    expect(majorOf("pg_dump (PostgreSQL) 18.4 (Homebrew)")).toBe(18);
    expect(majorOf("psql (PostgreSQL) 9.6.24")).toBe(9);
    expect(majorOf("unknown")).toBeNull();
  });

  it("flags a pg_dump older than the server, and dumps an older server cannot load", () => {
    expect(versionFit("pgDump", 14, 15)).toBe("tooOld");
    expect(versionFit("pgDump", 18, 15)).toBe("newer");
    expect(versionFit("pgRestore", 18, 15)).toBe("newer");
    expect(versionFit("pgRestore", 14, 15)).toBe("ok");
    expect(versionFit("psql", 18, 15)).toBe("ok");
    expect(versionFit("pgDump", 15, null)).toBe("ok");
  });

  it("preselects the server's version, else the last used, else the newest", () => {
    expect(pickInstall(installs, 15, "/usr/bin/pg_dump")).toBe("/opt/homebrew/opt/postgresql@15/bin/pg_dump");
    expect(pickInstall(installs, 16, "/usr/bin/pg_dump")).toBe("/usr/bin/pg_dump");
    expect(pickInstall(installs, 16, null)).toBe("/opt/homebrew/bin/pg_dump");
    expect(pickInstall([], null, null)).toBe("");
  });
});

describe("run summaries", () => {
  it("formats how long a run took", () => {
    expect(formatElapsed(350)).toBe("< 1 s");
    expect(formatElapsed(4_200)).toBe("4 s");
    expect(formatElapsed(724_000)).toBe("12 min 4 s");
    expect(formatElapsed(7_500_000)).toBe("2 h 5 min");
  });

  it("shortens paths to their file name", () => {
    expect(baseName("/tmp/dumps/shop.sql")).toBe("shop.sql");
    expect(baseName("C:\\dumps\\shop.dump")).toBe("shop.dump");
    expect(baseName("/tmp/dir/")).toBe("dir");
  });
});
