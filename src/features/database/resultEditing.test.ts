import { describe, expect, it } from "vitest";
import type { DbCompletion, DbDriver, DbRowEdit } from "@/platform/ipc";
import {
  editStatements,
  pkResultColumns,
  resolveTarget,
  resultColumnSources,
  resultEditability,
} from "./resultEditing";

const editable = (text: string, driver: DbDriver = "postgres") => {
  const e = resultEditability(text, driver);
  expect(e.kind, JSON.stringify(e)).toBe("editable");
  return e as Extract<ReturnType<typeof resultEditability>, { kind: "editable" }>;
};

const readonly = (text: string, driver: DbDriver = "postgres") => {
  const e = resultEditability(text, driver);
  expect(e.kind, JSON.stringify(e)).toBe("readonly");
  return (e as Extract<ReturnType<typeof resultEditability>, { kind: "readonly" }>).reason;
};

const eq = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

describe("resultEditability", () => {
  it("accepts a plain select of one table", () => {
    const e = editable("SELECT * FROM users WHERE id < 10 ORDER BY id LIMIT 5");
    expect(e.schema).toBeNull();
    expect(e.table).toBe("users");
    expect(e.alias).toBeNull();
    expect(e.items).toEqual([{ kind: "star", qualifier: null }]);
  });

  it("accepts a schema-qualified table, aliases and plain column references", () => {
    const e = editable("select u.id, u.name\nfrom public.users as u\nwhere u.id > 1\norder by u.id");
    expect(e.schema).toBe("public");
    expect(e.table).toBe("users");
    expect(e.alias).toBe("u");
    expect(e.items).toEqual([
      { kind: "column", qualifier: "u", name: "id" },
      { kind: "column", qualifier: "u", name: "name" },
    ]);
  });

  it("accepts qualified stars and FOR UPDATE", () => {
    expect(editable("SELECT u.* FROM users u FOR UPDATE").items).toEqual([{ kind: "star", qualifier: "u" }]);
    expect(editable("SELECT id FROM users").items).toEqual([{ kind: "column", qualifier: null, name: "id" }]);
  });

  it("keeps a quoted identifier a column reference", () => {
    expect(editable('SELECT "name", "user id" FROM "my table"', "sqlite").items).toEqual([
      { kind: "column", qualifier: null, name: "name" },
      { kind: "column", qualifier: null, name: "user id" },
    ]);
  });

  it("rejects joins, comma lists and derived tables as joined / plain", () => {
    expect(readonly("SELECT * FROM a JOIN b ON a.id = b.id")).toBe("joined");
    expect(readonly("SELECT * FROM a LEFT OUTER JOIN b ON a.id = b.id")).toBe("joined");
    expect(readonly("SELECT * FROM a, b WHERE a.id = b.id")).toBe("joined");
    expect(readonly("SELECT * FROM a CROSS JOIN b")).toBe("joined");
    expect(readonly("SELECT * FROM (SELECT id FROM a) x")).toBe("plain");
  });

  it("rejects aggregates, DISTINCT, GROUP BY, HAVING and windows as aggregated", () => {
    expect(readonly("SELECT count(*) FROM users")).toBe("aggregated");
    expect(readonly("SELECT max(id) + 1 FROM users")).toBe("aggregated");
    expect(readonly("SELECT DISTINCT name FROM users")).toBe("aggregated");
    expect(readonly("SELECT name FROM users GROUP BY name")).toBe("aggregated");
    expect(readonly("SELECT name FROM users GROUP BY name HAVING count(*) > 1")).toBe("aggregated");
    expect(readonly("SELECT name, row_number() OVER () FROM users")).toBe("aggregated");
    // A column called `min` (no call parens) is not an aggregate.
    expect(editable("SELECT min FROM mins").items).toEqual([{ kind: "column", qualifier: null, name: "min" }]);
  });

  it("rejects set operations", () => {
    expect(readonly("SELECT id FROM a UNION SELECT id FROM b")).toBe("setOp");
    expect(readonly("SELECT id FROM a INTERSECT SELECT id FROM b")).toBe("setOp");
    expect(readonly("SELECT id FROM a EXCEPT SELECT id FROM b")).toBe("setOp");
  });

  it("rejects anything that is not a plain single-table select", () => {
    expect(readonly("WITH t AS (SELECT 1) SELECT * FROM t")).toBe("plain");
    expect(readonly("SELECT 1")).toBe("plain");
    expect(readonly("SELECT *")).toBe("plain");
    expect(readonly("SELECT * INTO copy FROM users")).toBe("plain");
    expect(readonly("INSERT INTO users VALUES (1)")).toBe("plain");
    expect(readonly("UPDATE users SET id = 1")).toBe("plain");
    expect(readonly("DELETE FROM users")).toBe("plain");
    expect(readonly("TABLE users", "postgres")).toBe("plain");
  });

  it.each([
    "SELECT id, (SELECT name FROM logs LIMIT 1) FROM users",
    "SELECT * FROM users WHERE id IN (SELECT id FROM logs)",
    "SELECT id, coalesce(sum(id), 0) FROM users",
    "SELECT id, (row_number() OVER ()) FROM users",
    "SELECT * FROM db.public.users",
    "SELECT * FROM users WHERE id > 0; SELECT * FROM logs",
    "SELECT id FROM ONLY users",
    "SELECT id /* outer /* inner */ FROM wrong WHERE 1=1 */ FROM users",
    String.raw`SELECT id, E'ignored\' FROM wrong WHERE 1=1 --' FROM users`,
  ])("refuses ambiguous provenance: %s", (sql) => {
    expect(resultEditability(sql, "postgres").kind).toBe("readonly");
  });

  it.each([
    "SELECT id, name FROM users /*!50000 UNION SELECT id, name FROM admins */",
    "SELECT id, name FROM users /*M! UNION SELECT id, name FROM admins */",
  ])("rejects executable comments: %s", (sql) => {
    expect(resultEditability(sql, "mysql").kind).toBe("readonly");
  });

  it("folds unquoted identifiers per dialect and preserves quoted case", () => {
    expect(editable("SELECT ID FROM PUBLIC.USERS").table).toBe("users");
    expect(editable('SELECT "ID" FROM "Users"').table).toBe("Users");
    expect(editable("SELECT id FROM users", "oracle").table).toBe("USERS");
  });

  it("keeps aliased columns and expressions read-only per column", () => {
    expect(editable("SELECT id, name AS n FROM users").items).toEqual([
      { kind: "column", qualifier: null, name: "id" },
      { kind: "expression" },
    ]);
    expect(editable("SELECT id, name n FROM users").items).toEqual([
      { kind: "column", qualifier: null, name: "id" },
      { kind: "expression" },
    ]);
    expect(editable("SELECT id || '-x', id::text, 'k', 5 FROM users").items).toEqual([
      { kind: "expression" },
      { kind: "expression" },
      { kind: "expression" },
      { kind: "expression" },
    ]);
  });

  it("reads the table of a statement with trailing semicolon and comments", () => {
    const e = editable("SELECT id FROM users; -- latest");
    expect(e.table).toBe("users");
  });
});

describe("resolveTarget", () => {
  const model: DbCompletion = {
    defaultSchema: "public",
    tables: [
      { schema: "public", name: "users", kind: "table", columns: [] },
      { schema: "other", name: "public", kind: "table", columns: [] },
    ],
    foreignKeys: [],
  };

  it("keeps a known schema.table", () => {
    const e = editable("SELECT * FROM public.users");
    expect(resolveTarget(e, model)).toEqual({ schema: "public", table: "users", alias: null });
  });

  it("preserves explicit qualification even with incomplete completion metadata", () => {
    const e = editable("SELECT * FROM public.users");
    expect(resolveTarget(e, { ...model, tables: model.tables.slice(1) })).toEqual({
      schema: "public",
      table: "users",
      alias: null,
    });
  });

  it.each(["postgres", "mysql", "oracle"] as const)("uses the execution schema for %s", (driver) => {
    const e = editable("SELECT * FROM users u", driver);
    expect(resolveTarget(e, model, "s2")?.schema).toBe("s2");
    expect(resolveTarget(e, model)?.schema).toBe("public");
  });

  it("passes an unknown schema.table through", () => {
    const e = editable("SELECT * FROM nope.missing");
    expect(resolveTarget(e, model)).toEqual({ schema: "nope", table: "missing", alias: null });
  });

  it("refuses unresolved defaults and SQL Server database/schema ambiguity", () => {
    expect(resolveTarget(editable("SELECT * FROM users"), model, "")).toBeNull();
    expect(resolveTarget(editable("SELECT * FROM users"), model, "public", "sqlServer")).toBeNull();
    const explicit = editable("SELECT * FROM dbo.users");
    expect(resolveTarget(explicit, model, "other_database", "sqlServer")).toBeNull();
    expect(resolveTarget(explicit, model, "public", "sqlServer")).toEqual({
      schema: "dbo",
      table: "users",
      alias: null,
    });
  });

  it("does not touch unqualified or explicitly aliased names", () => {
    const e = editable("SELECT * FROM users u");
    expect(resolveTarget(e, null)).toEqual({ schema: null, table: "users", alias: "u" });
  });
});

describe("resultColumnSources", () => {
  it("maps plain columns positionally and stars against the table's columns", () => {
    expect(resultColumnSources([{ kind: "column", qualifier: null, name: "id" }], ["id"], ["id", "name"], eq)).toEqual([
      "id",
    ]);
    expect(resultColumnSources([{ kind: "star", qualifier: null }], ["id", "name"], ["id", "name"], eq)).toEqual([
      "id",
      "name",
    ]);
    // A `*` column the table doesn't have (a computed column of a view): read-only.
    expect(resultColumnSources([{ kind: "star", qualifier: null }], ["id", "extra"], ["id"], eq)).toEqual(["id", null]);
    // While the details are loading, the names are trusted.
    expect(resultColumnSources([{ kind: "star", qualifier: null }], ["id", "extra"], null, eq)).toEqual([
      "id",
      "extra",
    ]);
  });

  it("aligns mixed items positionally", () => {
    const items = [{ kind: "expression" }, { kind: "star", qualifier: null }] as const;
    expect(resultColumnSources(items, ["count", "id", "name"], ["id", "name"], eq)).toEqual([null, "id", "name"]);
  });

  it("honours the star qualifier only through the caller's qualifier check", () => {
    // The qualifier match against the alias / table name happens before mapping; here both pass.
    const items = [
      { kind: "star", qualifier: "u" },
      { kind: "column", qualifier: "u", name: "id" },
    ] as const;
    expect(resultColumnSources([...items], ["name", "id"], ["id", "name"], eq)).toEqual(["name", "id"]);
  });

  it("maps nothing when the items cannot line up with the result", () => {
    expect(resultColumnSources([{ kind: "column", qualifier: null, name: "a" }], ["a", "b"], null, eq)).toEqual([
      null,
      null,
    ]);
    expect(resultColumnSources([{ kind: "star", qualifier: null }], [], null, eq)).toEqual([]);
  });
});

describe("pkResultColumns", () => {
  it("refuses duplicate result labels that could shadow a primary key", () => {
    expect(pkResultColumns(["id"], [null, "id", "name"], ["id", "id", "name"], eq)).toBeNull();
    expect(pkResultColumns(["id"], ["id", "name"], ["id", "ID"], eq)).toBeNull();
  });

  it("collects the result columns of every key column, or null when one is missing", () => {
    expect(pkResultColumns(["id"], ["id", "name"], ["id", "name"], eq)).toEqual(["id"]);
    expect(pkResultColumns(["id", "tenant"], ["tenant", "name", "id"], ["tenant", "name", "id"], eq)).toEqual([
      "id",
      "tenant",
    ]);
    expect(pkResultColumns(["id"], [null, "name"], ["id", "name"], eq)).toBeNull();
    expect(pkResultColumns([], ["id"], ["id"], eq)).toBeNull();
  });
});

describe("editStatements", () => {
  it("renders the UPDATE / INSERT / DELETE the backend applies", () => {
    const edits: DbRowEdit[] = [
      { kind: "update", key: [{ column: "id", value: "1" }], values: [{ column: "name", value: "O'Brien" }] },
      { kind: "delete", key: [{ column: "id", value: "2" }] },
      {
        kind: "insert",
        values: [
          { column: "id", value: null },
          { column: "name", value: "x" },
        ],
      },
    ];
    expect(editStatements("postgres", "public", "users", edits)).toEqual([
      "UPDATE public.users SET name = 'O''Brien' WHERE id = '1'",
      "DELETE FROM public.users WHERE id = '2'",
      "INSERT INTO public.users (id, name) VALUES (NULL, 'x')",
    ]);
    expect(editStatements("mysql", "", "users", [{ kind: "insert", values: [] }])).toEqual([
      "INSERT INTO users () VALUES ()",
    ]);
    expect(editStatements("postgres", "", "users", [{ kind: "insert", values: [] }])).toEqual([
      "INSERT INTO users DEFAULT VALUES",
    ]);
    expect(editStatements("postgres", "", "users", [{ kind: "delete", key: [{ column: "id", value: null }] }])).toEqual(
      ["DELETE FROM users WHERE id IS NULL"],
    );
  });
});
