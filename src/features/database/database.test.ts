import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DataSource } from "@/platform/ipc";
import { exportData, type ExportData } from "./export";
import { isNumericColumn } from "./Grid";
import {
  activeSchema,
  buildRowEdits,
  colorVar,
  connectRemedy,
  emptyEdits,
  hasEdits,
  idleTargets,
  matchesPattern,
  parseSourceUrl,
  passesTreeFilter,
  schemaSwitchable,
  shownNames,
  sourceLabel,
  splitTarget,
  sshLabel,
  targetOf,
  toCsv,
  toTsv,
} from "./model";
import { OUTPUT_TAB, closeResult, listsDatabases, useDatabase, type ResultTab } from "./store";
import { VENDORS, sourceUrl, vendorById, vendorOf, vendorPreset } from "./vendors";

describe("clipboard formats", () => {
  it("copies TSV with NULL as empty and whitespace flattened", () => {
    expect(
      toTsv(
        ["a", "b"],
        [
          ["1", null],
          ["x\ty", "line\nbreak"],
        ],
      ),
    ).toBe("a\tb\n1\t\nx y\tline break");
    expect(toTsv(null, [["1"]])).toBe("1");
  });

  it("copies RFC 4180 CSV", () => {
    expect(
      toCsv(
        ["id", "note"],
        [
          ["1", 'say "hi", ok'],
          ["2", null],
        ],
      ),
    ).toBe('id,note\r\n1,"say ""hi"", ok"\r\n2,');
  });
});

describe("table edits", () => {
  const columns = ["id", "name", "note"];
  const rows = [
    ["1", "ann", null],
    ["2", "bob", "x"],
  ];

  it("turns pending changes into keyed updates, deletes and inserts", () => {
    const e = emptyEdits();
    expect(hasEdits(e)).toBe(false);
    e.updates.set(0, new Map([["note", "hello"]]));
    e.updates.set(1, new Map([["name", "bobby"]]));
    e.deletes.add(1);
    e.inserts.push(new Map([["name", "cy"]]));
    expect(hasEdits(e)).toBe(true);
    expect(buildRowEdits(columns, rows, ["id"], e)).toEqual([
      { kind: "update", key: [{ column: "id", value: "1" }], values: [{ column: "note", value: "hello" }] },
      { kind: "delete", key: [{ column: "id", value: "2" }] },
      { kind: "insert", values: [{ column: "name", value: "cy" }] },
    ]);
  });
});

describe("labels", () => {
  it("labels data sources", () => {
    expect(sourceLabel({ name: "app", driver: "postgres" })).toBe("app (PostgreSQL)");
  });
});

describe("export formats", () => {
  const data: ExportData = {
    columns: [
      { name: "id", type: "INTEGER" },
      { name: "name", type: "TEXT" },
    ],
    rows: [
      ["1", "O'Hara"],
      ["2", null],
    ],
    table: "order items",
    driver: "postgres",
  };

  it("writes JSON with numbers and nulls", () => {
    expect(JSON.parse(exportData("json", data))).toEqual([
      { id: 1, name: "O'Hara" },
      { id: 2, name: null },
    ]);
  });

  it("writes SQL inserts with quoted names and literals", () => {
    expect(exportData("sql", data)).toBe(
      `INSERT INTO "order items" (id, name) VALUES (1, 'O''Hara');\nINSERT INTO "order items" (id, name) VALUES (2, NULL);`,
    );
  });

  it("preserves backslashes in ClickHouse SQL exports", () => {
    expect(exportData("sql", { ...data, driver: "clickhouse", rows: [["1", "C:\\new\\file's"]] })).toBe(
      `INSERT INTO "order items" (id, name) VALUES (1, 'C:\\\\new\\\\file''s');`,
    );
  });

  it("doubles quotes and backslashes in Snowflake SQL exports", () => {
    const columns = [
      { name: "ID", type: "NUMBER(38,0)" },
      { name: "name", type: "VARCHAR(100)" },
    ];
    expect(exportData("sql", { columns, table: "ORDERS", driver: "snowflake", rows: [["1", "C:\\new\\file's"]] })).toBe(
      `INSERT INTO ORDERS (ID, "name") VALUES (1, 'C:\\\\new\\\\file''s');`,
    );
  });

  it("right-aligns Snowflake number types", () => {
    for (const type of ["NUMBER(38,0)", "FIXED", "DECFLOAT", "FLOAT"])
      expect(isNumericColumn(type, []), type).toBe(true);
    for (const type of ["VARCHAR(100)", "TIMESTAMP_NTZ(9)", "BOOLEAN", "VARIANT", "FixedString(10)"])
      expect(isNumericColumn(type, []), type).toBe(false);
  });

  it("writes a Markdown table, numbers right-aligned", () => {
    expect(exportData("markdown", { ...data, rows: [["1", "a|b"]] })).toBe(
      "| id | name |\n| --: | --- |\n| 1 | a\\|b |",
    );
  });
});

describe("connection errors", () => {
  const ssh = (auth: "password" | "keyPair" | "openSsh") => ({ ssh: { enabled: true, host: "bastion", auth } });

  it("asks for what the failed connection needs", () => {
    expect(connectRemedy("protocol", "Unknown SSH host key for bastion:22 (ssh-ed25519 SHA256:abc)")).toBe(
      "trustHostKey",
    );
    expect(connectRemedy("permissionDenied", "SSH password required for me@bastion:22", ssh("password"))).toBe(
      "sshSecret",
    );
    expect(connectRemedy("permissionDenied", "SSH key passphrase required for /k", ssh("keyPair"))).toBe("sshSecret");
    expect(connectRemedy("permissionDenied", "SSH authentication failed for me@bastion:22", ssh("password"))).toBe(
      "sshSecret",
    );
    expect(connectRemedy("permissionDenied", "SSH authentication failed for me@bastion:22", ssh("openSsh"))).toBeNull();
    expect(connectRemedy("permissionDenied", "[28P01] password authentication failed")).toBe("password");
    expect(connectRemedy("io", "connection refused")).toBeNull();
  });

  it("never offers to trust a changed host key", () => {
    expect(
      connectRemedy("permissionDenied", "SSH host key of bastion:22 has changed (known_hosts line 3); possible attack"),
    ).toBeNull();
  });

  it("labels the SSH host", () => {
    expect(sshLabel({ ssh: { host: "bastion", user: "ops", port: 2222 } })).toBe("ops@bastion:2222");
    expect(sshLabel({ ssh: null })).toBe("");
  });
});

describe("connection targets", () => {
  it("names the default database by the source id alone", () => {
    expect(targetOf("pg", null, "app")).toBe("pg");
    expect(targetOf("pg", "app", "app")).toBe("pg");
    expect(targetOf("pg", "other", "app")).toBe("pg:other");
  });

  it("splits a target back into source and database", () => {
    expect(splitTarget("pg")).toEqual({ id: "pg", database: null });
    expect(splitTarget("pg:my:db")).toEqual({ id: "pg", database: "my:db" });
  });

  it("lists databases under PostgreSQL and SQL Server hosts unless single-database mode", () => {
    expect(listsDatabases({ driver: "postgres" })).toBe(true);
    expect(listsDatabases({ driver: "sqlServer" })).toBe(true);
    expect(listsDatabases({ driver: "postgres", options: { singleDatabase: true } })).toBe(false);
    expect(listsDatabases({ driver: "sqlServer", options: { singleDatabase: true } })).toBe(false);
    expect(listsDatabases({ driver: "mysql" })).toBe(false);
    expect(listsDatabases(undefined)).toBe(false);
  });
});

describe("Snowflake sources", () => {
  const settings = { warehouse: "COMPUTE_WH", role: "ANALYST", auth: "keyPair", privateKeyFile: "" } as const;

  it("start without a host and with key-pair authentication", () => {
    expect(vendorPreset(vendorById("snowflake")!)).toEqual({
      driver: "snowflake",
      vendor: "",
      port: 443,
      host: "",
      snowflake: { warehouse: "", role: "", auth: "keyPair", privateKeyFile: "" },
    });
  });

  it("show a JDBC URL with the account's host and the session settings", () => {
    const source = {
      driver: "snowflake",
      host: "my_org-my_account",
      database: "ANALYTICS",
      options: { defaultSchema: "PUBLIC" },
      snowflake: settings,
    } as unknown as DataSource;
    expect(sourceUrl(source)).toBe(
      "jdbc:snowflake://my-org-my-account.snowflakecomputing.com/?db=ANALYTICS&schema=PUBLIC&warehouse=COMPUTE_WH&role=ANALYST",
    );
    expect(sourceUrl({ driver: "snowflake", host: "", port: 8443 } as unknown as DataSource)).toBe(
      "jdbc:snowflake://<account>.snowflakecomputing.com:8443/",
    );
    expect(
      sourceUrl({ driver: "snowflake", host: "https://acct.snowflakecomputing.com/console" } as unknown as DataSource),
    ).toBe("jdbc:snowflake://acct.snowflakecomputing.com/");
  });

  it("read the session settings of a JDBC URL", () => {
    const parsed = parseSourceUrl(
      "jdbc:snowflake://myorg-myaccount.snowflakecomputing.com:443/?warehouse=COMPUTE_WH&db=ANALYTICS&schema=PUBLIC" +
        "&role=ANALYST&user=jane&authenticator=snowflake_jwt&private_key_file=%7E%2Fkeys%2Frsa_key.p8&QUERY_TAG=ide",
    );
    expect(parsed).toEqual({
      source: {
        driver: "snowflake",
        host: "myorg-myaccount.snowflakecomputing.com",
        port: 443,
        user: "jane",
        database: "ANALYTICS",
        options: { defaultSchema: "PUBLIC" },
        snowflake: { ...settings, privateKeyFile: "~/keys/rsa_key.p8" },
        properties: [{ name: "QUERY_TAG", value: "ide" }],
      },
      password: null,
    });
    expect(
      parseSourceUrl("snowflake://acct.snowflakecomputing.com/?authenticator=externalbrowser")?.source.snowflake,
    ).toMatchObject({ auth: "browser" });
  });
});

describe("parseSourceUrl", () => {
  it("reads PostgreSQL / MySQL URLs, plain and JDBC", () => {
    expect(parseSourceUrl("postgresql://ann:s%40cret@db.local:5433/shop?sslmode=require")).toEqual({
      source: { driver: "postgres", host: "db.local", port: 5433, user: "ann", database: "shop", ssl: "require" },
      password: "s@cret",
    });
    expect(parseSourceUrl("jdbc:mysql://localhost/app?user=root")).toEqual({
      source: { driver: "mysql", host: "localhost", port: null, user: "root", database: "app" },
      password: null,
    });
  });

  it("reads SQLite and Oracle URLs and rejects other drivers", () => {
    expect(parseSourceUrl("jdbc:sqlite:C:/data/shop.db")?.source).toEqual({
      driver: "sqlite",
      file: "C:/data/shop.db",
      name: "shop",
    });
    expect(parseSourceUrl("oracle://scott:tiger@db.local:1521/ORCLPDB1")).toEqual({
      source: { driver: "oracle", host: "db.local", port: 1521, user: "scott", database: "ORCLPDB1" },
      password: "tiger",
    });
    expect(parseSourceUrl("jdbc:oracle:thin:@//db.local:1521/ORCL")?.source).toEqual({
      driver: "oracle",
      host: "db.local",
      port: 1521,
      user: "",
      database: "ORCL",
    });
    expect(parseSourceUrl("unknown://x")).toBeNull();
  });
});

describe("data source types", () => {
  it("presets wire-compatible products on the existing drivers", () => {
    expect(vendorPreset(vendorById("cockroachdb")!)).toEqual({
      driver: "postgres",
      vendor: "cockroachdb",
      port: 26257,
    });
    expect(vendorPreset(vendorById("postgres")!)).toEqual({ driver: "postgres", vendor: "", port: 5432 });
    expect(vendorPreset(vendorById("supabase")!).ssl).toBe("require");
    expect(vendorPreset(vendorById("oracle")!)).toEqual({ driver: "oracle", vendor: "", port: 1521 });
    expect(
      VENDORS.every((v) =>
        ["postgres", "mysql", "sqlite", "sqlServer", "clickhouse", "oracle", "snowflake"].includes(v.driver),
      ),
    ).toBe(true);
    const labels = VENDORS.map((v) => v.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
  });

  it("adds StarRocks on the MySQL driver with the 9030 preset (#2452)", () => {
    expect(vendorPreset(vendorById("starrocks")!)).toEqual({ driver: "mysql", vendor: "starrocks", port: 9030 });
    expect(sourceUrl({ driver: "mysql", vendor: "starrocks", host: "sr", port: 9030, database: "" })).toBe(
      "jdbc:starrocks://sr:9030",
    );
    expect(parseSourceUrl("starrocks://root@sr.local:9030/test")?.source.vendor).toBe("starrocks");
  });

  it("falls back to the driver for unknown or mismatched presets", () => {
    expect(vendorOf({ driver: "mysql", vendor: "tidb" }).label).toBe("TiDB");
    expect(vendorOf({ driver: "postgres", vendor: "tidb" }).id).toBe("postgres");
    expect(vendorOf({ driver: "mysql" }).id).toBe("mysql");
    expect(sourceLabel({ name: "tidb", driver: "mysql", vendor: "tidb" })).toBe("tidb (TiDB)");
  });

  it("previews the JDBC URL of the fields", () => {
    expect(sourceUrl({ driver: "postgres", host: "localhost", port: 5432, database: "postgres" })).toBe(
      "jdbc:postgresql://localhost:5432/postgres",
    );
    expect(sourceUrl({ driver: "postgres", vendor: "redshift", host: "r", port: null, database: "" })).toBe(
      "jdbc:redshift://r:5439",
    );
    expect(sourceUrl({ driver: "mysql", vendor: "mariadb", host: "::1", port: 3307, database: "a b" })).toBe(
      "jdbc:mariadb://[::1]:3307/a%20b",
    );
    expect(sourceUrl({ driver: "sqlite", file: "app.db" })).toBe("jdbc:sqlite:app.db");
  });

  it("reads URLs of compatible products, SSL settings and driver properties", () => {
    const tidb = parseSourceUrl(
      "jdbc:tidb://root@tidb.local:4000/test?sslmode=verify-full&sslrootcert=/ca.pem&sql_mode=ANSI",
    );
    expect(tidb?.source).toEqual({
      driver: "mysql",
      vendor: "tidb",
      host: "tidb.local",
      port: 4000,
      user: "root",
      database: "test",
      ssl: "verifyFull",
      sslCaFile: "/ca.pem",
      properties: [{ name: "sql_mode", value: "ANSI" }],
    });
    expect(parseSourceUrl("redshift://r.example:5439/dev")?.source.vendor).toBe("redshift");
    expect(parseSourceUrl("postgresql://h:70000/db")).toBeNull();
  });

  it("adds ClickHouse with native HTTP defaults and HTTPS cloud URLs", () => {
    expect(vendorPreset(vendorById("clickhouse")!)).toEqual({
      driver: "clickhouse",
      vendor: "",
      port: 8123,
      user: "default",
      database: "default",
      ssl: "disable",
    });
    expect(sourceUrl({ driver: "clickhouse", host: "localhost", database: "default" })).toBe(
      "http://localhost:8123/default",
    );
    expect(sourceUrl({ driver: "clickhouse", host: "db.example", ssl: "verifyFull", database: "analytics" })).toBe(
      "https://db.example:8443/analytics",
    );
    const parsed = parseSourceUrl("https://reader:s%40cret@db.example:8443/analytics?max_execution_time=30");
    expect(parsed?.source).toMatchObject({
      driver: "clickhouse",
      host: "db.example",
      port: 8443,
      database: "analytics",
      user: "reader",
      ssl: "verifyFull",
    });
    expect(parsed?.password).toBe("s@cret");
    expect(parseSourceUrl("http://localhost/default")?.source.ssl).toBe("disable");
    expect(parseSourceUrl("jdbc:clickhouse://localhost/default")?.source.driver).toBe("clickhouse");
    expect(parseSourceUrl("https://db.example/default?sslmode=disable")?.source.ssl).toBe("verifyFull");
  });
});

describe("Schemas tab", () => {
  it("matches names and * / ? patterns", () => {
    expect(matchesPattern("app_1", "app_*")).toBe(true);
    expect(matchesPattern("app.1", "app?1")).toBe(true);
    expect(matchesPattern("apps", "app")).toBe(false);
    expect(matchesPattern("a.b", "a.b")).toBe(true);
  });

  it("shows all names, or the chosen ones and the connected database", () => {
    const names = ["app", "app_test", "billing", "postgres"];
    expect(shownNames(names, undefined, undefined)).toEqual(names);
    expect(shownNames(names, true, ["billing"])).toEqual(names);
    expect(shownNames(names, false, ["app*"], "postgres")).toEqual(["app", "app_test", "postgres"]);
    expect(shownNames(names, false, [])).toEqual([]);
  });

  it("quick-filters tree objects by a case-insensitive substring", () => {
    expect(passesTreeFilter("users", "user")).toBe(true);
    expect(passesTreeFilter("Users", "user")).toBe(true);
    expect(passesTreeFilter("order_items", "  IT  ")).toBe(true);
    expect(passesTreeFilter("users", "orders")).toBe(false);
    expect(passesTreeFilter("users", "")).toBe(true);
    expect(passesTreeFilter("users", "   ")).toBe(true);
    expect(passesTreeFilter("users", null)).toBe(true);
  });
});

describe("active schema", () => {
  it("follows the console's pick, then the connection default", () => {
    expect(activeSchema("app", "public")).toBe("app");
    expect(activeSchema(undefined, "public")).toBe("public");
    expect(activeSchema("", "public")).toBe("public");
    expect(activeSchema(undefined, undefined)).toBe("");
    expect(activeSchema(null, null)).toBe("");
  });

  it("offers the schema dropdown to multi-schema drivers only", () => {
    for (const driver of ["postgres", "mysql", "sqlServer", "oracle", "snowflake"] as const)
      expect(schemaSwitchable(driver)).toBe(true);
    for (const driver of ["sqlite", "clickhouse"] as const) expect(schemaSwitchable(driver)).toBe(false);
    expect(schemaSwitchable(undefined)).toBe(false);
  });
});

describe("Options tab", () => {
  it("finds connections idle past their auto-disconnect", () => {
    const sources = [
      { id: "a", options: { autoDisconnectSecs: 60 } },
      { id: "b", options: { autoDisconnectSecs: null } },
    ];
    const used = new Map([
      ["a", 0],
      ["a:other", 50_000],
      ["b", 0],
    ]);
    const idle = (busy: string[]) =>
      idleTargets(["a", "a:other", "b", "c"], sources, used, (t) => busy.includes(t), 60_000);
    expect(idle([])).toEqual(["a"]);
    expect(idle(["a"])).toEqual([]);
  });

  it("names the colour tokens", () => {
    expect(colorVar("red")).toBe("var(--db-color-red)");
    expect(colorVar(null)).toBeUndefined();
  });
});

describe("closing result tabs", () => {
  let previous: ReturnType<typeof useDatabase.getState>;
  const tabs = [11, 35, 72, 109].map((id): ResultTab => {
    const text = `SELECT ${id}`;
    return {
      id,
      title: `Result ${id}`,
      path: "console.sql",
      sourceId: "pg",
      outcome: {
        statement: { from: 0, to: text.length, text },
        error: null,
        result: {
          statement: text,
          columns: [{ name: "value", typeName: "int4" }],
          rows: [[String(id)]],
          affected: null,
          hasMore: false,
          elapsedMs: 1,
          executionMs: 1,
        },
      },
    };
  });

  beforeEach(() => {
    previous = useDatabase.getState();
  });

  afterEach(() => useDatabase.setState(previous, true));

  it("selects the immediate left neighbor rather than the rightmost result", () => {
    useDatabase.setState({ results: tabs, activeResult: 35 });
    closeResult(35);
    expect(useDatabase.getState().activeResult).toBe(11);
    expect(useDatabase.getState().results.map((r) => r.id)).toEqual([11, 72, 109]);
  });

  it.each([
    ["selects the right neighbor of the first result", [11, 35, 72, 109], 11, 11, 35, [35, 72, 109]],
    ["selects the left neighbor of the last result", [11, 35, 72, 109], 109, 109, 72, [11, 35, 72]],
    ["returns to Output after the only result closes", [11], 11, 11, OUTPUT_TAB, []],
    ["keeps selection when an inactive result on the left closes", [11, 35, 72, 109], 72, 35, 72, [11, 72, 109]],
    ["keeps selection when an inactive result on the right closes", [11, 35, 72, 109], 11, 109, 11, [11, 35, 72]],
    ["keeps Output selected when a result closes", [11, 35, 72, 109], OUTPUT_TAB, 35, OUTPUT_TAB, [11, 72, 109]],
    ["keeps an unset selection when a result closes", [11, 35, 72, 109], null, 11, null, [35, 72, 109]],
    ["ignores an already closed result", [11, 35, 72, 109], 35, 999, 35, [11, 35, 72, 109]],
    ["does not change a stale selection for a missing result", [11, 35, 72, 109], 999, 999, 999, [11, 35, 72, 109]],
    ["does not close Output", [11, 35, 72, 109], OUTPUT_TAB, OUTPUT_TAB, OUTPUT_TAB, [11, 35, 72, 109]],
  ] as const)("%s", (_name, ids, active, closed, expected, remaining) => {
    useDatabase.setState({ results: ids.map((id) => tabs.find((r) => r.id === id)!), activeResult: active });
    closeResult(closed);
    expect(useDatabase.getState().activeResult).toBe(expected);
    expect(useDatabase.getState().results.map((r) => r.id)).toEqual(remaining);
  });
});
