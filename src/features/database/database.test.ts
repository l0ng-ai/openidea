import { describe, expect, it } from "vitest";
import { exportData, type ExportData } from "./export";
import {
  buildRowEdits,
  colorVar,
  connectRemedy,
  emptyEdits,
  hasEdits,
  idleTargets,
  matchesPattern,
  parseSourceUrl,
  shownNames,
  sourceLabel,
  splitTarget,
  sshLabel,
  targetOf,
  toCsv,
  toTsv,
} from "./model";
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

  it("reads SQLite files and rejects other drivers", () => {
    expect(parseSourceUrl("jdbc:sqlite:C:/data/shop.db")?.source).toEqual({
      driver: "sqlite",
      file: "C:/data/shop.db",
      name: "shop",
    });
    expect(parseSourceUrl("oracle://x")).toBeNull();
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
    expect(VENDORS.every((v) => ["postgres", "mysql", "sqlite", "sqlServer"].includes(v.driver))).toBe(true);
    const labels = VENDORS.map((v) => v.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
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
