import { describe, expect, it } from "vitest";
import type { DbCompletion, DbCompletionColumn } from "@/platform/ipc";
import { lex } from "./sql/lexer";
import {
  workspaceJoinColumnOptions,
  workspaceJoinColumnTarget,
  workspaceJoinQuery,
  workspaceSourceAliasError,
  workspaceSourceNames,
  workspaceStatementRanges,
} from "./workspaceQuery";

describe("workspace table references", () => {
  it("runs the JOIN at the caret across quoted semicolons and nested comments", () => {
    const first = 'SELECT * FROM #left.public."odd;name" a JOIN #right.db.t b ON a.id=b.id';
    const second = "SELECT * FROM #left.public.other a /* outer /* ; */ still ; */ JOIN #right.db.t b ON a.id=b.id";
    const text = first + ";\n" + second + ";\n";
    for (const [caret, table] of [
      [first.indexOf("odd"), "odd;name"],
      [text.indexOf("outer"), "other"],
      [text.length, "other"],
    ] as const) {
      expect(workspaceJoinQuery(text, undefined, undefined, caret)[0].table).toBe(table);
    }
    expect(() => workspaceJoinQuery(text)).toThrow(/one direct equality JOIN/);
  });

  it("uses exact UTF-16 console ranges and ignores delimiters inside comments and names", () => {
    const first = '-- 👋 ;\nSELECT * FROM #left.public."customer;orders" a JOIN #right.db.t b ON a.id=b.id';
    const second = "SELECT * FROM #left.public.next a JOIN #right.events.t b ON a.id=b.id";
    const text = "  " + first + " ;\n\n  " + second + ";\n-- comment only";
    const from = text.indexOf(second);
    const spans = workspaceStatementRanges(text);
    expect(spans).toEqual([
      { from: 2, to: 2 + first.length },
      { from, to: from + second.length },
    ]);
    expect(workspaceStatementRanges(text, text.indexOf(" ;") + 2)).toEqual([spans[0]]);
    expect(workspaceStatementRanges(text, from - 1)).toEqual([spans[1]]);
    expect(workspaceStatementRanges(text, text.length)).toEqual([spans[1]]);
    expect(workspaceStatementRanges("-- nothing;\n;; ")).toEqual([]);
  });

  it("completes the current JOIN after another statement", () => {
    const prefix = "SELECT * FROM #left.public.t a JOIN #right.db.t b ON a.id=b.id;\n";
    const sql = prefix + "SELECT * FROM #right.events.orders AS o JOIN #left.public.users AS u ON u.";
    expect(workspaceJoinColumnTarget(sql)).toMatchObject({
      source: "left",
      schema: "public",
      table: "users",
      from: sql.length,
    });
  });

  it("keeps quoted dots, embedded quotes and reversed join keys", () => {
    const result = workspaceJoinQuery(
      'SELECT * FROM #left."odd.schema"."a""b" AS a JOIN #right.events.lookup b ON b."Key" = a.id;',
    );
    expect(result).toEqual([
      { source: "left", schema: "odd.schema", table: 'a"b', alias: "a", key: "id" },
      { source: "right", schema: "events", table: "lookup", alias: "b", key: "Key" },
    ]);
  });
  it("allows comments and the source name as the default alias", () => {
    expect(
      workspaceJoinQuery("select * from #left.public.t /* first */ inner join #right.db.t on left.id=right.id").map(
        (x) => x.key,
      ),
    ).toEqual(["id", "id"]);
  });
  it("joins explicitly selected sources by their quoted display names", () => {
    const names = workspaceSourceNames('Sales "EU"', "events");
    const refs = workspaceJoinQuery(
      'SELECT * FROM #events.logs.orders e JOIN #"Sales ""EU""".public.users u ON u.id=e.id',
      names,
    );
    expect(refs.map((ref) => ref.source)).toEqual(["right", "left"]);
    expect(() =>
      workspaceJoinQuery("SELECT * FROM #other.logs.orders e JOIN #left.public.users u ON u.id=e.id", names),
    ).toThrow();
    expect(() =>
      workspaceJoinQuery("SELECT * FROM #events.logs.t a JOIN #right.logs.t b ON a.id=b.id", names),
    ).toThrow();
  });
  it("keeps stable references for blank, conflicting, or reserved display names", () => {
    expect(workspaceSourceNames("Sales", "sales")).toEqual({ left: "left", right: "right" });
    expect(workspaceSourceNames("right", "warehouse")).toEqual({ left: "left", right: "warehouse" });
    expect(workspaceSourceNames("  ", "LEFT")).toEqual({ left: "left", right: "right" });
  });
  it("resolves optional aliases alongside existing names and positional drafts", () => {
    const names = workspaceSourceNames("Sales EU", "events");
    const aliases = { left: "crm", right: "logs" };
    for (const [first, second] of [
      ["crm", "logs"],
      ['"Sales EU"', "events"],
      ["left", "right"],
      ["CRM", "events"],
    ]) {
      const sql = `SELECT * FROM #${first}.public.t a JOIN #${second}.public.t b ON a.id=b.id`;
      expect(workspaceJoinQuery(sql, names, aliases).map((x) => x.source)).toEqual(["left", "right"]);
    }
    expect(workspaceSourceAliasError(names, { left: "  ", right: "события" })).toBeNull();
  });
  it("never binds an empty quoted reference to a blank alias", () => {
    const names = workspaceSourceNames("Sales", "Events");
    expect(() =>
      workspaceJoinQuery('SELECT * FROM #"".public.t a JOIN #right.public.t b ON a.id=b.id', names, { left: "" }),
    ).toThrow();
  });
  it.each([
    { left: "events" },
    { right: "left" },
    { left: "one", right: "One" },
    { left: "two words" },
    { left: "a.b" },
    { left: "#crm" },
    { left: "1crm" },
  ])("rejects ambiguous or malformed aliases before running the query: %o", (aliases) => {
    const names = workspaceSourceNames("sales", "Events");
    expect(workspaceSourceAliasError(names, aliases)).toBeTruthy();
    expect(() =>
      workspaceJoinQuery("SELECT * FROM #left.public.t a JOIN #right.public.t b ON a.id=b.id", names, aliases),
    ).toThrow();
  });
  it.each([
    "left.id = left.id",
    "missing.id = right.id",
    "left.id = right.id; select 1",
    "left.id = right.id OR true",
    'left.id = right."oops',
  ])("rejects the incomplete or unsupported predicate %s", (predicate) => {
    expect(() => workspaceJoinQuery("select * from #left.public.t join #right.db.t on " + predicate)).toThrow();
  });
});

describe("completion in workspace join keys", () => {
  const names = workspaceSourceNames('Sales "EU"', "events");
  const aliases = { left: "crm" };
  const join = 'SELECT * FROM #events."Log DB"."Event.Table" AS "b.Name" ' + 'JOIN #crm."odd.schema"."a""b" AS a ON ';
  const positional = "SELECT * FROM #left.public.users a JOIN #right.events.users b ON ";

  it("resolves both qualified sides from the execution grammar, even when sources are reversed", () => {
    const first = join + "a.";
    expect(workspaceJoinColumnTarget(first, names, aliases, lex(first, "postgres"))).toEqual({
      source: "left",
      schema: "odd.schema",
      table: 'a"b',
      from: first.length,
      prefix: "",
      quoted: false,
    });
    const second = join + 'a."User ID" /* key */ = "b.Name"."Cust';
    expect(workspaceJoinColumnTarget(second, names, aliases)).toEqual({
      source: "right",
      schema: "Log DB",
      table: "Event.Table",
      from: second.indexOf('"Cust'),
      prefix: "Cust",
      quoted: true,
    });
  });

  it("keeps the same source-side rules for inherited and explicitly quoted aliases", () => {
    const text = 'SELECT * FROM #"Sales ""EU""".public.users JOIN #events.db.t ON "Sales ""EU""".';
    expect(workspaceJoinColumnTarget(text, names)?.source).toBe("left");
    const renamed = workspaceSourceNames("New Sales", "events");
    expect(workspaceJoinColumnTarget(text, renamed)).toBeNull();
    expect(workspaceJoinColumnTarget(positional + "a.", renamed)?.source).toBe("left");
  });

  it.each([
    "a. -- b.",
    "a. /* b.",
    "a.id = 'b.",
    "a.id = $q$b.",
    "no_such_alias.",
    "a.id = a.",
    "a.id OR b.",
    "a.id = b.id; SELECT x.",
    "a.id = b.id ",
  ])("offers no completion in unsupported, literal or ambiguous context %s", (predicate) => {
    expect(workspaceJoinColumnTarget(positional + predicate)).toBeNull();
  });

  it("does not offer columns inside a PostgreSQL nested block comment", () => {
    const nested = positional + "/* outer /* inner */ a.";
    expect(workspaceJoinColumnTarget(nested)).toBeNull();
    expect(workspaceJoinColumnTarget(nested + " */ b.")?.source).toBe("right");
  });

  it("does not execute join keys hidden in a PostgreSQL nested block comment", () => {
    const nested = positional + "/* outer /* inner */ a.id = b.id";
    expect(() => workspaceJoinQuery(nested)).toThrow();
    expect(workspaceJoinQuery(nested + " */ a.id = b.id").map((r) => r.key)).toEqual(["id", "id"]);
  });

  it.each(["sqlite", "mysql", "clickhouse"] as const)("preserves non-nested %s block comments", (driver) => {
    expect(lex("/* outer /* inner */ value", driver).tokens.map((token) => token.text)).toEqual(["value"]);
  });

  it("declines unknown or empty sources and duplicate aliases", () => {
    for (const left of ['#""', "#obsolete"]) {
      expect(workspaceJoinColumnTarget("SELECT * FROM " + left + ".public.t a JOIN #right.db.t b ON a.")).toBeNull();
    }
    expect(workspaceJoinColumnTarget("SELECT * FROM #left.public.t a JOIN #right.db.t a ON a.")).toBeNull();
    expect(workspaceJoinColumnTarget("SELECT * FROM #left.public.t a JOIN #left.db.t b ON a.")).toBeNull();
    expect(workspaceJoinColumnTarget(positional + "a." + " ".repeat(65_536))).toBeNull();
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
    const target = workspaceJoinColumnTarget(positional + "a.")!;
    expect(workspaceJoinColumnOptions(target, catalog).map(({ label, apply }) => [label, apply])).toEqual([
      ["id", "id"],
      ["ID", '"ID"'],
      ["User ID", '"User ID"'],
      ['a"b', '"a""b"'],
      ["select", '"select"'],
    ]);
    expect(
      workspaceJoinColumnOptions(workspaceJoinColumnTarget(positional + "a.i")!, catalog).map((x) => x.label),
    ).toEqual(["id", "ID"]);
    expect(
      workspaceJoinColumnOptions(workspaceJoinColumnTarget(positional + 'a."I')!, catalog).map((x) => x.label),
    ).toEqual(["ID"]);
    expect(workspaceJoinColumnOptions({ ...target, table: "unknown" }, catalog)).toEqual([]);
  });
});
