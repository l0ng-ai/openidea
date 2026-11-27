import { describe, expect, it } from "vitest";
import type { DbCompletion, DbCompletionColumn } from "@/platform/ipc";
import { lex } from "./sql/lexer";
import {
  workspaceJoinColumnOptions,
  workspaceJoinColumnTarget,
  workspaceJoinQuery,
  workspaceSourceAliasError,
  workspaceSourceResolver,
  workspaceStatementRanges,
} from "./workspaceQuery";

const refs = [
  { id: "pg", name: 'Sales "EU"', alias: "crm", legacy: "left" },
  { id: "ch", name: "events", alias: "logs", legacy: "right" },
] as const;
const resolve = workspaceSourceResolver(refs);
const basic = "SELECT * FROM #left.public.users a JOIN #right.events.users b ON ";
const pair = (a: string, b: string) => `SELECT * FROM #${a}.public.users a JOIN #${b}.db.log b ON b.id=a.id`;

describe("saved workspace references", () => {
  it("uses a saved name without setup, optional aliases and migrated shortcuts", () => {
    for (const [a, b] of [
      ['"Sales ""EU"""', "events"],
      ["CRM", "logs"],
      ["left", "right"],
    ]) {
      expect(workspaceJoinQuery(pair(a!, b!), resolve).tables.map((t) => t.sourceId)).toEqual(["pg", "ch"]);
    }
    const fresh = [
      { id: "a", name: "left" },
      { id: "b", name: "logs" },
    ];
    expect(workspaceSourceResolver(fresh)("left")?.id).toBe("a");
    expect(workspaceSourceResolver(fresh)("right")).toBeUndefined();
    expect(() => workspaceJoinQuery(pair('""', "logs"), resolve)).toThrow();
  });
  it("never rebinds a deleted source's saved alias or old positional name", () => {
    const available = [
      { id: "new", name: "left" },
      { id: "fresh", name: "crm" },
    ];
    const resolve = workspaceSourceResolver(available, {
      legacySources: { left: "removed", right: "" },
      sourceAliases: { removed: "crm" },
    });
    expect(resolve("left")).toBeUndefined();
    expect(resolve("CRM")).toBeUndefined();
    expect(resolve("left", true)).toBeUndefined();
    expect(resolve("crm", true)).toBeUndefined();
    expect(resolve("CRM", true)).toBeUndefined();
  });
  it("keeps quoted positional references bound when a source is renamed", () => {
    const resolve = workspaceSourceResolver([
      { id: "old", name: "Renamed", legacy: "left" },
      { id: "new", name: "left", alias: "replacement" },
    ]);
    expect(resolve("left", true)?.id).toBe("old");
    expect(resolve("replacement")?.id).toBe("new");
  });
  it("resolves quoted display names exactly and rejects ambiguous bare names", () => {
    const sources = [
      { id: "a", name: "Sales", alias: "europe" },
      { id: "b", name: "SALES", alias: "asia" },
    ];
    expect(workspaceSourceResolver(sources)("sales")).toBeNull();
    expect(workspaceSourceResolver(sources)("Sales", true)?.id).toBe("a");
    expect(workspaceSourceAliasError(sources)).toBeNull();
    expect(workspaceSourceResolver(sources)("ASIA")?.id).toBe("b");
    expect(() => workspaceJoinQuery(pair("sales", "asia"), workspaceSourceResolver(sources))).toThrow(
      /Multiple sources/,
    );
  });
  it.each(["events", "right", "two words", "a.b", "#crm", "1crm"])(
    "rejects conflicting or invalid optional alias %s",
    (alias) => {
      expect(workspaceSourceAliasError([{ ...refs[0], alias }, refs[1]])).toBeTruthy();
      expect(workspaceSourceAliasError([{ ...refs[0], alias: "события" }, refs[1]])).toBeNull();
    },
  );
  it("uses table names by default, preserving old source-qualified drafts", () => {
    for (const predicate of ["users.pk=log.pk", "left.pk=right.pk"]) {
      const plan = workspaceJoinQuery(
        "select * from #left.users /* first */ inner join #right.db.log on " + predicate,
        resolve,
      );
      expect(plan.joins).toEqual([{ left: { relation: 0, column: "pk" }, rightColumn: "pk" }]);
      expect(plan.tables[0]).toEqual({ sourceId: "pg", database: "", schema: "", table: "users" });
    }
  });
  it("keeps old unaliased same-table-name drafts bound by source", () => {
    const sql = "SELECT * FROM #left.public.t JOIN #right.logs.t ON left.id=right.id";
    expect(workspaceJoinQuery(sql, resolve).joins[0]?.left.relation).toBe(0);
    expect(() => workspaceJoinQuery(sql.replace("left.id", "t.id"), resolve)).toThrow();
  });
  it("preserves quoted identifiers and reversed keys", () => {
    const q = 'SELECT * FROM #left."odd.schema"."a""b" AS a JOIN #right.events.lookup b ON b."Key"=a.id;';
    const plan = workspaceJoinQuery(q, resolve);
    expect(plan.tables[0]).toMatchObject({ sourceId: "pg", schema: "odd.schema", table: 'a"b' });
    expect(plan.joins).toEqual([{ left: { relation: 0, column: "id" }, rightColumn: "Key" }]);
    expect(plan.projection).toBeNull();
  });
  it.each(["a.id = a.id", "missing.id = b.id", "a.id = b.id; select 1", "a.id = b.id OR true", 'a.id = b."oops'])(
    "rejects unsupported predicates %s",
    (predicate) => {
      expect(() => workspaceJoinQuery(basic + predicate, resolve)).toThrow();
    },
  );
  it("bounds relations and rejects a projection referencing an unknown qualifier", () => {
    const chain = (n: number) =>
      "SELECT * FROM #left.s.t a0" +
      Array.from({ length: n - 1 }, (_, i) => ` JOIN #right.s.t a${i + 1} ON a0.id=a${i + 1}.id`).join("");
    expect(workspaceJoinQuery(chain(8), resolve).tables).toHaveLength(8);
    expect(() => workspaceJoinQuery(chain(9), resolve)).toThrow(/eight/);
    expect(() => workspaceJoinQuery(chain(2).replace("*", "other.id"), resolve)).toThrow();
  });
  it("uses only the statement at the caret and ignores escaped delimiters and nested comments", () => {
    const first = '-- 👋 ;\nSELECT * FROM #left.public."odd;name" a JOIN #right.db.t b ON a.id=b.id';
    const second = "SELECT * FROM #left.public.other a /* nested /* ; */ still ; */ JOIN #right.db.t b ON a.id=b.id";
    const text = "  " + first + " ;\n\n  " + second + ";\n-- comment only";
    const start = text.indexOf(second);
    expect(workspaceStatementRanges(text)).toEqual([
      { from: 2, to: first.length + 2 },
      { from: start, to: start + second.length },
    ]);
    expect(workspaceJoinQuery(text, resolve, text.indexOf("odd")).tables[0]?.table).toBe("odd;name");
    expect(workspaceJoinQuery(text, resolve, text.indexOf("nested")).tables[0]?.table).toBe("other");
    expect(workspaceJoinQuery(text, resolve, text.length).tables[0]?.table).toBe("other");
    expect(workspaceStatementRanges("-- nothing;\n;; ")).toEqual([]);
    expect(() => workspaceJoinQuery(text, resolve)).toThrow();
  });
});

describe("completion in workspace join keys", () => {
  it("finds the current statement, with a quoted key prefix and escaped identifiers", () => {
    const first = pair("left", "right") + ";\n";
    const prefix = first + 'SELECT * FROM #logs."Log DB"."Event.Table" "b.Name" JOIN #crm."o.dd"."a""b" a ON ';
    const a = prefix + "a.";
    expect(workspaceJoinColumnTarget(a, resolve, lex(a, "postgres"))).toEqual({
      sourceId: "pg",
      database: "",
      schema: "o.dd",
      table: 'a"b',
      from: a.length,
      prefix: "",
      quoted: false,
    });
    const b = prefix + 'a."User ID" /* comment */ = "b.Name"."Cust';
    expect(workspaceJoinColumnTarget(b, resolve)).toEqual({
      sourceId: "ch",
      database: "",
      schema: "Log DB",
      table: "Event.Table",
      from: b.indexOf('"Cust'),
      prefix: "Cust",
      quoted: true,
    });
  });
  it.each([
    "a. -- b.",
    "a. /* b.",
    "a.id = 'b.",
    "a.id = $q$b.",
    "missing.",
    "a.id = a.",
    "a.id OR b.",
    "a.id = b.id; SELECT x.",
    "a.id = b.id ",
  ])("does not complete invalid or literal context %s", (predicate) => {
    expect(workspaceJoinColumnTarget(basic + predicate, resolve)).toBeNull();
  });
  it("rejects missing sources, duplicate table aliases, oversized SQL and unfinished nested comments", () => {
    const complete = (s: string) => workspaceJoinColumnTarget(s, resolve);
    expect(complete(basic.replace("#left", "#gone") + "a.")).toBeNull();
    expect(complete(basic.replace("users b", "users a") + "a.")).toBeNull();
    expect(complete(basic + "a." + " ".repeat(65_536))).toBeNull();
    expect(complete(basic + "/* outer /* inner */ a.")).toBeNull();
    expect(complete(basic + "/* outer /* inner */ a. */ b.")).toMatchObject({ sourceId: "ch" });
    expect(() => workspaceJoinQuery(basic + "/* outer /* inner */ a.id=b.id", resolve)).toThrow();
  });
  it.each(["sqlite", "mysql", "clickhouse"] as const)("preserves non-nested %s block comments", (driver) => {
    expect(lex("/* outer /* inner */ value", driver).tokens.map((t) => t.text)).toEqual(["value"]);
  });

  it("uses the one exact catalog table and inserts safely quoted column names", () => {
    const column = (name: string): DbCompletionColumn => ({
      name,
      dataType: "bigint",
      primaryKey: false,
      nullable: false,
      hasDefault: false,
    });
    const catalog: DbCompletion = {
      defaultSchema: "wrong",
      foreignKeys: [],
      tables: [
        { schema: "wrong", name: "users", kind: "table", columns: [column("wrong_table")] },
        { schema: "Public", name: "users", kind: "table", columns: [column("wrong_case")] },
        { schema: "public", name: "users", kind: "view", columns: [column("wrong_kind")] },
        {
          schema: "public",
          name: "users",
          kind: "table",
          columns: ["id", "ID", "User ID", 'a"b', "select"].map(column),
        },
      ],
    };
    const target = workspaceJoinColumnTarget(basic + "a.", resolve)!;
    expect(workspaceJoinColumnOptions(target, catalog).map(({ label, apply }) => [label, apply])).toEqual([
      ["id", "id"],
      ["ID", '"ID"'],
      ["User ID", '"User ID"'],
      ['a"b', '"a""b"'],
      ["select", '"select"'],
    ]);
    expect(
      workspaceJoinColumnOptions(workspaceJoinColumnTarget(basic + "a.i", resolve)!, catalog).map((x) => x.label),
    ).toEqual(["id", "ID"]);
    expect(
      workspaceJoinColumnOptions(workspaceJoinColumnTarget(basic + 'a."I', resolve)!, catalog).map((x) => x.label),
    ).toEqual(["ID"]);
    expect(workspaceJoinColumnOptions({ ...target, table: "unknown" }, catalog)).toEqual([]);
  });
});

describe("saved sources in a Workspace", () => {
  const sources = [
    { id: "pg", name: "accounts" },
    { id: "ch", name: "events" },
    { id: "duck", name: "Regional data", alias: "geo" },
    { id: "sq", name: "labels" },
  ];
  const resolve = workspaceSourceResolver(sources);
  const statement = `SELECT a.*, e.*, g.region, t.channel
FROM #accounts.workspace_fixture.public.customers a
JOIN #events.events.purchases e ON e.customer_id = a.id
JOIN #geo.geo.main.region_map g ON g.id = a.id
JOIN #labels.main.tags t ON t.zone = g.zone`;

  it("compiles a real four-engine JOIN without assigning sides", () => {
    expect(workspaceJoinQuery(statement, resolve)).toEqual({
      tables: [
        { sourceId: "pg", database: "workspace_fixture", schema: "public", table: "customers" },
        { sourceId: "ch", database: "", schema: "events", table: "purchases" },
        { sourceId: "duck", database: "geo", schema: "main", table: "region_map" },
        { sourceId: "sq", database: "", schema: "main", table: "tags" },
      ],
      joins: [
        { left: { relation: 0, column: "id" }, rightColumn: "customer_id" },
        { left: { relation: 0, column: "id" }, rightColumn: "id" },
        { left: { relation: 2, column: "zone" }, rightColumn: "zone" },
      ],
      projection: [
        { relation: 0, column: null },
        { relation: 1, column: null },
        { relation: 2, column: "region" },
        { relation: 3, column: "channel" },
      ],
    });
  });
  it("completes columns for the third and fourth inputs without an assigned side", () => {
    expect(workspaceJoinColumnTarget(statement.slice(0, statement.lastIndexOf("g.zone") + 2), resolve)).toMatchObject({
      sourceId: "duck",
      database: "geo",
      schema: "main",
      table: "region_map",
    });
  });
  it("rejects a join which does not link the new table to an earlier one", () => {
    expect(() => workspaceJoinQuery(statement.replace("t.zone = g.zone", "a.id = e.customer_id"), resolve)).toThrow();
    expect(() => workspaceJoinQuery(statement.replace("g.id = a.id", "g.id = t.id"), resolve)).toThrow();
  });
});
