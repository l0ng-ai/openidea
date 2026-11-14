import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { snippet } from "@codemirror/autocomplete";
import type { DbCompletion, DbDriver } from "@/platform/ipc";
import { analyze, templateContexts, valuesSlot } from "./analyze";
import { aliasFor, quoteIdent, sqlCandidates, type SqlCandidate } from "./complete";
import { identName, inLiteral, lex } from "./lexer";
import { DATA_TYPES, statementStarters } from "./dialect";
import { bindParams, findParams } from "./params";
import { SqlResolver } from "./resolve";

const col = (name: string, dataType = "INTEGER", primaryKey = false, hasDefault = false) => ({
  name,
  dataType,
  nullable: !primaryKey,
  primaryKey,
  hasDefault,
});

const model: DbCompletion = {
  defaultSchema: "main",
  tables: [
    {
      schema: "main",
      name: "users",
      kind: "table",
      columns: [
        col("id", "INTEGER", true),
        col("email", "TEXT"),
        col("name", "TEXT"),
        col("created_at", "TEXT", false, true),
      ],
    },
    {
      schema: "main",
      name: "orders",
      kind: "table",
      columns: [col("id", "INTEGER", true), col("user_id"), col("status", "TEXT"), col("total", "NUMERIC")],
    },
    {
      schema: "main",
      name: "order_items",
      kind: "table",
      columns: [col("order_id", "INTEGER", true), col("product_id", "INTEGER", true), col("qty")],
    },
    { schema: "main", name: "products", kind: "table", columns: [col("id", "INTEGER", true), col("title", "TEXT")] },
    { schema: "main", name: "big_orders", kind: "view", columns: [col("id"), col("user_id"), col("total", "NUMERIC")] },
  ],
  foreignKeys: [
    { schema: "main", table: "orders", columns: ["user_id"], refSchema: "main", refTable: "users", refColumns: ["id"] },
    {
      schema: "main",
      table: "order_items",
      columns: ["order_id"],
      refSchema: "main",
      refTable: "orders",
      refColumns: ["id"],
    },
    {
      schema: "main",
      table: "order_items",
      columns: ["product_id"],
      refSchema: "main",
      refTable: "products",
      refColumns: ["id"],
    },
  ],
};

/** Analysis at the `|` of `sql`. */
function at(sql: string, driver: DbDriver = "sqlite") {
  const pos = sql.indexOf("|");
  const text = sql.slice(0, pos) + sql.slice(pos + 1);
  return analyze(text, pos, driver);
}

function complete(sql: string, driver: DbDriver = "sqlite", m: DbCompletion = model): SqlCandidate[] {
  return sqlCandidates({ model: m, analysis: at(sql, driver), driver, sourceName: "shop" }).sort(
    (a, b) => b.boost - a.boost,
  );
}
/** A Snowflake schema model: names as the server stores them. */
const sf: DbCompletion = {
  defaultSchema: "PUBLIC",
  tables: [
    {
      schema: "PUBLIC",
      name: "USERS",
      kind: "table",
      columns: [col("ID", "NUMBER", true), col("SRC", "VARIANT"), col("mixedCase", "VARCHAR")],
    },
    { schema: "RAW", name: "EVENTS", kind: "table", columns: [col("ID", "NUMBER", true), col("PAYLOAD", "VARIANT")] },
  ],
  foreignKeys: [],
};

const labels = (c: SqlCandidate[], kind?: string) => c.filter((x) => !kind || x.kind === kind).map((x) => x.label);

describe("lexer", () => {
  it("reads ClickHouse backticks and escaped quotes without exposing literal parameters", () => {
    const sql = String.raw`select "a\\b\"c", ` + "`my column`" + String.raw`, 'it\'s ?; text', ?`;
    const tokens = lex(sql, "clickhouse").tokens;
    expect(identName(tokens[1]!)).toBe('a\\b"c');
    expect(tokens.filter((t) => t.kind === "quoted").map(identName)).toEqual(['a\\b"c', "my column"]);
    expect(findParams(sql, "clickhouse").map((p) => p.name)).toEqual(["?1"]);
  });

  it("skips comments and knows literals", () => {
    const l = lex("select 'a;b', \"Col\" -- c\nfrom t /* x */ where a::int = $1", "postgres");
    expect(l.tokens.map((t) => t.text)).toEqual([
      "select",
      "'a;b'",
      ",",
      '"Col"',
      "from",
      "t",
      "where",
      "a",
      "::",
      "int",
      "=",
      "$1",
    ]);
    expect(inLiteral(l, 9)).toBe("string");
    expect(inLiteral(l, 23)).toBe("comment");
    expect(inLiteral(l, 0)).toBeNull();
  });

  it("handles dialect quoting", () => {
    expect(lex("select `a b` # c\n", "mysql").tokens.map((t) => t.kind)).toEqual(["word", "quoted"]);
    expect(lex("do $x$ begin; end $x$", "postgres").tokens.map((t) => t.kind)).toEqual(["word", "string"]);
    expect(inLiteral(lex("select 'abc"), 11)).toBe("string");
  });

  it("reads Snowflake dollar strings, comments, escapes, variant paths and stages", () => {
    const texts = (sql: string) => lex(sql, "snowflake").tokens.map((t) => t.text);
    const l = lex("select $$ it's; -- $$ // c ' \n, 'a\\'b' /* d */ -- e", "snowflake");
    expect(l.tokens.map((t) => t.kind)).toEqual(["word", "string", "punct", "string"]);
    expect(l.tokens[3]!.text).toBe("'a\\'b'");
    expect(l.comments).toHaveLength(3);
    expect(inLiteral(lex("select $$ open", "snowflake"), 14)).toBe("string");
    expect(texts('select src:a.b::string, "V":k, f(x):y, a[0]:z, $1, $var')).toEqual(
      ["select", "src", ":", "a", ".", "b", "::", "string", ",", '"V"', ":", "k", ","].concat([
        "f",
        "(",
        "x",
        ")",
        ":",
        "y",
        ",",
        "a",
        "[",
        "0",
        "]",
        ":",
        "z",
        ",",
        "$1",
        ",",
        "$var",
      ]),
    );
    expect(texts("from @db.sch.stg/dir/f.csv, @~/x, @%t (pattern => '.*') where a = :id")).toEqual(
      ["from", "@db.sch.stg/dir/f.csv", ",", "@~/x", ",", "@%t", "(", "pattern", "=>", "'.*'", ")"].concat([
        "where",
        "a",
        "=",
        ":id",
      ]),
    );
    // Only Snowflake reads `//` as a comment.
    expect(lex("select 1 // 2", "postgres").comments).toEqual([]);
  });
});

describe("analysis", () => {
  it("knows what is expected at the caret", () => {
    expect(at("|").context.kind).toBe("statement");
    expect(at("select 1; sel|").context.kind).toBe("statement");
    expect(at("select * from |").context).toEqual({ kind: "table", join: false });
    expect(at("select * from users u join |").context).toEqual({ kind: "table", join: true });
    expect(at("select * from users u, |").context.kind).toBe("table");
    expect(at("select | from users").context).toEqual({ kind: "column", clause: "select" });
    expect(at("select * from users where |").context).toEqual({ kind: "column", clause: "where" });
    expect(at("select * from users u |").context.kind).toBe("afterTable");
    expect(at("select * from orders o join users u on |").context.kind).toBe("joinCondition");
    expect(at("insert into users (|)").context.kind).toBe("insertColumns");
    expect(at("insert into users (id, |").context.kind).toBe("insertColumns");
    expect(at("insert into users (id) |").context.kind).toBe("afterInsertColumns");
    expect(at("select 'x|'").context.kind).toBe("none");
    expect(at("select a as |").context.kind).toBe("none");
    expect(at("create table |").context.kind).not.toBe("table");
  });

  it("resolves aliases, CTEs, derived tables and enclosing queries", () => {
    const a = at(
      "with recent as (select id, total as amount from orders) select r.| from recent r join users u on u.id = r.id",
    );
    expect(a.qualifier).toEqual(["r"]);
    const r = a.refs.find((x) => x.alias === "r")!;
    expect(r.kind).toBe("cte");
    expect(r.columns).toEqual(["id", "amount"]);

    const d = at("select x.| from (select name n, email from users) x");
    expect(d.refs[0]).toMatchObject({ kind: "derived", name: "x", columns: ["n", "email"] });

    const corr = at("select * from users u where exists (select 1 from orders o where o.user_id = |)");
    expect(corr.refs.map((x) => [x.name, x.depth])).toEqual([
      ["orders", 0],
      ["users", 1],
    ]);

    const union = at("select id from users union select | from orders");
    expect(union.refs.map((x) => x.name)).toEqual(["orders"]);
  });

  it("finds where FROM goes when a SELECT has none", () => {
    expect(at("select na|").fromInsert).toBe(9);
    expect(at("select na| from users").fromInsert).toBeNull();
  });

  it("follows the statement's keyword case", () => {
    expect(at("select * from |").lowerKeywords).toBe(true);
    expect(at("SELECT * FROM |").lowerKeywords).toBe(false);
  });
});

describe("completion candidates", () => {
  it("keeps ClickHouse schema, table and column names distinct by case", () => {
    const catalog: DbCompletion = {
      defaultSchema: "analytics",
      foreignKeys: [],
      tables: [
        { schema: "analytics", name: "Events", kind: "table", columns: [col("UpperOnly")] },
        { schema: "analytics", name: "events", kind: "table", columns: [col("Value"), col("value")] },
        { schema: "Analytics", name: "events", kind: "table", columns: [col("OtherSchema")] },
      ],
    };
    expect(labels(complete("select e.| from events e", "clickhouse", catalog))).toEqual(["Value", "value"]);
    expect(labels(complete("select e.| from Events e", "clickhouse", catalog))).toEqual(["UpperOnly"]);
    expect(labels(complete("select e.| from Analytics.events e", "clickhouse", catalog))).toEqual(["OtherSchema"]);
    const problems = (sql: string) => new SqlResolver(sql, "clickhouse", catalog).problems().map((p) => p.message);
    expect(problems("select Value, value from events")).toEqual([]);
    expect(problems("select VALUE from events")).toEqual(["Unable to resolve column 'VALUE'"]);
    expect(problems("select UpperOnly from events")).toEqual(["Unable to resolve column 'UpperOnly'"]);
    expect(problems("select OtherSchema from Analytics.events")).toEqual([]);
    expect(problems("select OtherSchema from analytics.events")).toEqual(["Unable to resolve column 'OtherSchema'"]);
    expect(
      at("with Events as (select 1 as UpperOnly) select | from events e", "clickhouse").refs.find(
        (ref) => ref.name === "events",
      )?.kind,
    ).toBe("table");
  });

  it("offers ClickHouse SQL and keeps case-sensitive function and type names", () => {
    expect(statementStarters("clickhouse")).toEqual(expect.arrayContaining(["SHOW DATABASES", "ALTER TABLE"]));
    expect(statementStarters("clickhouse")).not.toEqual(expect.arrayContaining(["BEGIN", "SET search_path TO"]));
    expect(DATA_TYPES.clickhouse).toContain("UInt64");
    expect(complete("SELECT | FROM users", "clickhouse").find((c) => c.label === "toDateTime")).toMatchObject({
      snippet: "toDateTime(${})",
    });
    expect(quoteIdent('a\\b"c', "clickhouse")).toBe('"a\\\\b\\"c"');
  });

  it("offers statement starters in the user's case", () => {
    expect(labels(complete("|"))).toContain("SELECT");
    expect(labels(complete("select 1; ins|"))).toContain("insert into");
  });

  it("offers Oracle vocabulary and quotes names the server folds to upper case", () => {
    expect(statementStarters("oracle")).toEqual(expect.arrayContaining(["MERGE INTO", "TRUNCATE TABLE"]));
    expect(statementStarters("oracle")).not.toContain("SET search_path TO");
    expect(DATA_TYPES.oracle).toEqual(expect.arrayContaining(["VARCHAR2(255)", "NUMBER", "CLOB"]));
    expect(complete("SELECT | FROM users", "oracle").find((c) => c.label === "NVL")).toMatchObject({
      snippet: "NVL(${})",
    });
    // Upper-case names are plain; lower-case ones need quotes (the server folds unquoted names).
    expect(quoteIdent("EMPLOYEES", "oracle")).toBe("EMPLOYEES");
    expect(quoteIdent("employees", "oracle")).toBe('"employees"');
    expect(quoteIdent('a"b', "oracle")).toBe('"a""b"');
  });

  it("offers Snowflake vocabulary and quotes names the server folds to upper case", () => {
    expect(statementStarters("snowflake")).toEqual(
      expect.arrayContaining([
        "COPY INTO",
        "MERGE INTO",
        "SHOW TABLES",
        "USE SCHEMA",
        "EXECUTE IMMEDIATE",
        "UNDROP TABLE",
      ]),
    );
    expect(statementStarters("snowflake")).not.toContain("CREATE INDEX");
    expect(DATA_TYPES.snowflake).toEqual(expect.arrayContaining(["VARIANT", "TIMESTAMP_NTZ", "NUMBER"]));
    expect(new Set(DATA_TYPES.snowflake).size).toBe(DATA_TYPES.snowflake.length);
    const afterTable = labels(complete("SELECT * FROM USERS U |", "snowflake", sf), "keyword");
    expect(afterTable).toEqual(
      expect.arrayContaining(["QUALIFY", "ASOF JOIN", "NATURAL JOIN", "LATERAL FLATTEN", "PIVOT"]),
    );
    expect(labels(complete("SELECT * FROM USERS WHERE |", "snowflake", sf), "keyword")).toEqual(
      expect.arrayContaining(["ILIKE", "RLIKE", "QUALIFY"]),
    );
    expect(complete("SELECT | FROM USERS", "snowflake", sf).find((c) => c.label === "IFF")).toMatchObject({
      snippet: "IFF(${})",
    });
    // Upper-case names are plain; anything else needs quotes (the server folds unquoted names).
    expect(quoteIdent("ORDERS", "snowflake")).toBe("ORDERS");
    expect(quoteIdent("ORDER_2$", "snowflake")).toBe("ORDER_2$");
    expect(quoteIdent("orders", "snowflake")).toBe('"orders"');
    expect(quoteIdent('a"b', "snowflake")).toBe('"a""b"');
    expect(quoteIdent("QUALIFY", "snowflake")).toBe('"QUALIFY"');
    expect(quoteIdent("QUALIFY", "oracle")).toBe("QUALIFY");
    const columns = complete("SELECT | FROM USERS", "snowflake", sf);
    expect(columns.find((c) => c.label === "ID")?.insert).toBe("ID");
    expect(columns.find((c) => c.label === "mixedCase")?.insert).toBe('"mixedCase"');
    const tables = complete("SELECT * FROM |", "snowflake", sf);
    expect(tables.find((c) => c.label === "USERS")?.insert).toBe("USERS");
    expect(tables.find((c) => c.label === "EVENTS")?.insert).toBe("RAW.EVENTS");
  });

  it("completes fully qualified Snowflake names through databases and schemas, in either case", () => {
    const catalog = {
      databases: ["ANALYTICS", "OTHER_DB", "Mixed Db"],
      schemas: (db: string) => (db === "OTHER_DB" ? ["RAW", "STAGING"] : db === "ANALYTICS" ? ["PUBLIC", "RAW"] : null),
      tables: (db: string, schema: string) =>
        db === "OTHER_DB" && schema.toUpperCase() === "RAW"
          ? [
              { name: "CLICKS", view: false },
              { name: "CLICKS_V", view: true },
              { name: "mixedTable", view: false },
            ]
          : null,
    };
    const run = (sql: string) =>
      sqlCandidates({ model: sf, analysis: at(sql, "snowflake"), driver: "snowflake", catalog }).sort(
        (a, b) => b.boost - a.boost,
      );
    const inserts = (sql: string, kind?: string) =>
      run(sql)
        .filter((c) => !kind || c.kind === kind)
        .map((c) => c.insert ?? c.label);

    // Databases are offered where a table may start, below the tables and schemas.
    const top = run("SELECT * FROM |");
    expect(top.filter((c) => c.tail === "(database)").map((c) => c.insert)).toEqual([
      "ANALYTICS.",
      "OTHER_DB.",
      '"Mixed Db".',
    ]);
    expect(top.find((c) => c.label === "OTHER_DB")).toMatchObject({ kind: "schema", retrigger: true });
    expect(top[0]!.label).toBe("USERS");

    // `database.` lists its schemas, `database.schema.` its tables and views.
    expect(inserts("select * from OTHER_DB.|")).toEqual(["RAW.", "STAGING."]);
    expect(run("select * from OTHER_DB.|").every((c) => c.kind === "schema" && c.retrigger)).toBe(true);
    expect(inserts("select * from OTHER_DB.RAW.|")).toEqual(["CLICKS", '"mixedTable"', "CLICKS_V"]);
    expect(run("select * from OTHER_DB.RAW.|").map((c) => c.kind)).toEqual(["table", "table", "view"]);
    expect(inserts("select * from OTHER_DB.RAW.CL|")).toContain("CLICKS");
    expect(inserts("select * from a join OTHER_DB.RAW.|")).toContain("CLICKS");

    // Lower case finds the same names and keeps what is typed in lower case.
    expect(inserts("select * from other_db.|")).toEqual(["raw.", "staging."]);
    expect(inserts("select * from other_db.raw.|")).toEqual(["clicks", '"mixedTable"', "clicks_v"]);
    expect(inserts("select * from other_db.raw.cl|")).toContain("clicks");
    expect(inserts("select * from OTHER_DB.RAW.cl|")).toContain("clicks");
    expect(inserts("select * from other_db.raw.CL|")).toContain("CLICKS");
    expect(inserts("select * from raw.|")).toEqual(["events"]);
    expect(inserts("select * from us|", "table")).toContain("users");

    // Names follow the case being typed: the prefix first, then the qualifier, then the statement's keywords.
    expect(inserts("select * from |", "table")).toEqual(expect.arrayContaining(["users", "raw.events"]));
    expect(inserts("SELECT * FROM |", "table")).toEqual(expect.arrayContaining(["USERS", "RAW.EVENTS"]));
    expect(inserts("SELECT * FROM us|", "table")).toContain("users");
    expect(inserts("select * from US|", "table")).toContain("USERS");
    expect(inserts("select | from USERS", "column")).toEqual(expect.arrayContaining(["id", "src", '"mixedCase"']));
    expect(inserts("SELECT | FROM users", "column")).toEqual(expect.arrayContaining(["ID", "SRC", '"mixedCase"']));
    expect(inserts("select u.| from USERS u")).toEqual(["id", "src", '"mixedCase"']);
    expect(
      run("select * from |")
        .filter((c) => c.tail === "(database)")
        .map((c) => c.insert),
    ).toEqual(["analytics.", "other_db.", '"Mixed Db".']);

    // Introspected tables of other databases complete by name, written fully qualified.
    const searched = sqlCandidates({
      model: sf,
      analysis: at("select * from cli|", "snowflake"),
      driver: "snowflake",
      catalog: {
        ...catalog,
        search: (prefix: string, limit: number) =>
          [
            { database: "OTHER_DB", schema: "RAW", name: "CLICKS", view: false },
            { database: "OTHER_DB", schema: "RAW", name: "CLICKS_V", view: true },
            { database: "Mixed Db", schema: "PUBLIC", name: "Clients", view: false },
          ]
            .filter((t) => t.name.toLowerCase().startsWith(prefix.toLowerCase()))
            .slice(0, limit),
      },
    });
    expect(
      searched.filter((c) => c.tail?.startsWith("(OTHER_DB") || c.tail?.startsWith("(Mixed")).map((c) => c.insert),
    ).toEqual(["other_db.raw.clicks", "other_db.raw.clicks_v", '"Mixed Db".public."Clients"']);
    // One typed letter is too little to search every database with.
    expect(
      sqlCandidates({
        model: sf,
        analysis: at("select * from c|", "snowflake"),
        driver: "snowflake",
        catalog: { ...catalog, search: () => [{ database: "OTHER_DB", schema: "RAW", name: "CLICKS", view: false }] },
      }).some((c) => c.label === "CLICKS"),
    ).toBe(false);

    // A schema of the session's database that is also a database name lists both.
    const both = sqlCandidates({
      model: sf,
      analysis: at("select * from RAW.|", "snowflake"),
      driver: "snowflake",
      catalog: { ...catalog, databases: ["RAW"], schemas: () => ["LANDING"] },
    });
    expect(both.map((c) => c.insert)).toEqual(["EVENTS", "LANDING."]);

    // Unknown databases and schemas that are not loaded offer nothing rather than something wrong.
    expect(run("select * from NO_SUCH_DB.|")).toEqual([]);
    expect(run("select * from OTHER_DB.STAGING.|")).toEqual([]);
    expect(run("select * from A.B.C.|")).toEqual([]);
  });

  it("completes Snowflake names by their last two parts and stays out of other databases", () => {
    expect(labels(complete("select * from RAW.|", "snowflake", sf))).toEqual(["EVENTS"]);
    expect(complete("select * from OTHER_DB.|", "snowflake", sf)).toEqual([]);
    expect(complete("select * from OTHER_DB.RAW.|", "snowflake", sf)).toEqual([]);
    expect(complete("select * from PUBLIC.USERS.|", "snowflake", sf)).toEqual([]);
    expect(labels(complete("select DB.PUBLIC.USERS.| from DB.PUBLIC.USERS", "snowflake", sf))).toEqual([
      "ID",
      "SRC",
      "mixedCase",
    ]);
    expect(labels(complete("select u.| from DB.PUBLIC.USERS u", "snowflake", sf))).toEqual(["ID", "SRC", "mixedCase"]);
    expect(at("select * from DB.PUBLIC.USERS u where |", "snowflake").refs[0]).toMatchObject({
      database: "DB",
      schema: "PUBLIC",
      name: "USERS",
      alias: "u",
    });
    // The keys of a VARIANT path and its cast are not names of the model.
    expect(complete("select SRC:|  from USERS", "snowflake", sf)).toEqual([]);
    expect(complete("select SRC:a.| from USERS", "snowflake", sf)).toEqual([]);
    expect(complete("select SRC:a::| from USERS", "snowflake", sf)).toEqual([]);
    // QUALIFY is a clause, not the alias of the table before it.
    const q = at("select * from USERS qualify |", "snowflake");
    expect(q.refs[0]).toMatchObject({ name: "USERS", alias: null });
    expect(q.context).toEqual({ kind: "column", clause: "having" });
    expect(at("select * from USERS sample (10) where |", "snowflake").refs[0]).toMatchObject({ alias: null });
  });

  it("offers tables after FROM, with schema and data source", () => {
    const c = complete("select * from |");
    expect(labels(c, "table")).toEqual(expect.arrayContaining(["users", "orders", "order_items", "products"]));
    expect(c.find((x) => x.label === "big_orders")).toMatchObject({ kind: "view", tail: "(main)", type: "shop" });
  });

  it("suggests whole join clauses from foreign keys, both directions, first", () => {
    const c = complete("select * from orders o join |");
    const joins = labels(c, "join");
    expect(joins.slice(0, 2).sort()).toEqual(["order_items oi on o.id = oi.order_id", "users u on o.user_id = u.id"]);
    expect(joins).toContain("big_orders bo on o.user_id = bo.user_id");
    expect(c[0]!.kind).toBe("join");
  });

  it("avoids alias clashes", () => {
    expect(aliasFor("users", new Set(["u"]))).toBe("u1");
    expect(aliasFor("order_items", new Set())).toBe("oi");
    expect(aliasFor("OrderItems", new Set())).toBe("oi");
    expect(aliasFor("on_hold", new Set())).toBe("oh");
  });

  it("suggests the join condition after ON", () => {
    const c = complete("select * from orders o join users u on |");
    expect(c[0]).toMatchObject({ kind: "join", label: "o.user_id = u.id" });
    expect(c.find((x) => x.label === "status")).toMatchObject({ kind: "column", tail: "(o)", type: "TEXT" });
    // `id` is in both tables: inserted qualified.
    expect(
      c
        .filter((x) => x.label === "id")
        .map((x) => x.insert)
        .sort(),
    ).toEqual(["o.id", "u.id"]);
  });

  it("offers ON with conditions right after a joined table", () => {
    const c = complete("select * from orders o join users u |");
    expect(c[0]).toMatchObject({ label: "on o.user_id = u.id" });
    expect(labels(c, "keyword")).toEqual(expect.arrayContaining(["on", "where", "left join"]));
  });

  it("completes columns of an alias after a dot, with key markers", () => {
    const c = complete("select o.| from orders o");
    expect(labels(c)).toEqual(["id", "user_id", "status", "total"]);
    expect(c.find((x) => x.label === "id")).toMatchObject({ primaryKey: true, foreignKey: false });
    expect(c.find((x) => x.label === "user_id")).toMatchObject({ primaryKey: false, foreignKey: true });
  });

  it("completes CTE and derived table columns", () => {
    expect(labels(complete("with r as (select id, total amount from orders) select r.| from r"))).toEqual([
      "id",
      "amount",
    ]);
  });

  it("completes the columns an INSERT needs, all of them, then each one", () => {
    const c = complete("insert into users (|)");
    expect(c.slice(0, 2).map((x) => [x.kind, x.label, x.tail])).toEqual([
      ["columns", "id, email, name", "(main.users)"],
      ["columns", "id, email, name, created_at", "(main.users)"],
    ]);
    expect(labels(c, "column")).toEqual(["id", "email", "name", "created_at"]);
  });

  it("suggests an alias right after a table, first", () => {
    expect(complete("select * from order_items |")[0]).toMatchObject({ kind: "alias", label: "oi" });
    expect(complete("select * from users u |")[0]?.kind).not.toBe("alias");
  });

  it("offers the whole column list in the select list", () => {
    const c = complete("select | from users");
    expect(c.find((x) => x.kind === "columns")).toMatchObject({
      label: "id, email, name, created_at",
      tail: "(main.users)",
      insert: "id, email, name, created_at",
    });
    const two = complete("select | from users u join orders o on o.user_id = u.id");
    expect(two.find((x) => x.kind === "columns" && x.tail === "(u)")?.insert).toBe(
      "u.id, u.email, u.name, u.created_at",
    );
  });

  it("names unaliased tables by schema in column rows", () => {
    expect(complete("update users set |").find((x) => x.label === "email")?.tail).toBe("(main.users)");
  });

  it("offers only columns as SET targets", () => {
    for (const text of ["update users set |", "update users set name = 'a', |"])
      expect(new Set(complete(text).map((x) => x.kind))).toEqual(new Set(["column"]));
    expect(complete("update users set name = |").some((x) => x.kind === "function")).toBe(true);
  });

  it("offers any column before FROM and adds the FROM", () => {
    const c = complete("select emai|");
    expect(c.find((x) => x.label === "email")).toMatchObject({ addFrom: "users", tail: "(users)" });
  });

  it("orders scope columns before functions before keywords", () => {
    const c = complete("select | from users");
    const first = (k: string) => c.findIndex((x) => x.kind === k);
    expect(first("column")).toBeLessThan(first("function"));
    expect(first("function")).toBeLessThan(first("keyword"));
    expect(c.find((x) => x.label === "count")).toMatchObject({ snippet: "count(${})" });
  });

  it.each(["sqlite", "postgres", "mysql"] as const)(
    "leaves the caret after a %s function without parameters",
    (driver) => {
      const candidates = complete("select |", driver).filter((c) => c.kind === "function" && c.tail === "()");
      expect(candidates.length).toBeGreaterThan(0);
      for (const candidate of candidates) {
        let state = EditorState.create({ doc: "select ", selection: { anchor: 7 } });
        snippet(candidate.snippet!)({ state, dispatch: (tr) => (state = tr.state) }, null, 7, 7);
        expect(state.doc.toString()).toBe(`select ${candidate.label}()`);
        expect(state.selection.main.head).toBe(state.doc.length);
      }
    },
  );

  it("quotes identifiers that need it", () => {
    expect(quoteIdent("Users", "postgres")).toBe('"Users"');
    expect(quoteIdent("Users", "mysql")).toBe("Users");
    expect(quoteIdent("order", "mysql")).toBe("`order`");
    expect(quoteIdent("my col", "sqlite")).toBe('"my col"');
  });

  it("qualifies tables outside the default schema", () => {
    const pg: DbCompletion = {
      defaultSchema: "public",
      tables: [
        { schema: "public", name: "users", kind: "table", columns: [col("id")] },
        { schema: "audit", name: "log", kind: "table", columns: [col("id")] },
      ],
      foreignKeys: [],
    };
    const c = complete("select * from |", "postgres", pg);
    expect(c.find((x) => x.label === "log")?.insert).toBe("audit.log");
    expect(c.find((x) => x.label === "users")?.insert).toBe("users");
    expect(labels(complete("select * from audit.|", "postgres", pg))).toEqual(["log"]);
    expect(c.find((x) => x.kind === "schema" && x.label === "audit")).toMatchObject({
      insert: "audit.",
      retrigger: true,
    });
  });

  it("is silent in strings and comments", () => {
    expect(complete("select '|'")).toEqual([]);
    expect(complete("-- sel|")).toEqual([]);
  });
});

describe("live template contexts", () => {
  it("knows where statements, queries and code go", () => {
    expect(templateContexts(at("sel|"))).toEqual(["sql-code", "sql-statement", "sql-query"]);
    expect(templateContexts(at("select 1; sel|"))).toContain("sql-statement");
    expect(templateContexts(at("select * from (sel|"))).toEqual(["sql-code", "sql-query"]);
    expect(templateContexts(at("select 1 union sel|"))).toEqual(["sql-code", "sql-query"]);
    expect(templateContexts(at("select * from users where sel|"))).toEqual(["sql-code"]);
    expect(templateContexts(at("select 'sel|'"))).toEqual([]);
  });
});

describe("VALUES parameter info", () => {
  const slot = (sql: string) => {
    const pos = sql.indexOf("|");
    return valuesSlot(sql.slice(0, pos) + sql.slice(pos + 1), pos, "sqlite");
  };
  it("finds the column of the value at the caret", () => {
    expect(slot("insert into users (email, name) values ('a', |)")).toMatchObject({
      columns: ["email", "name"],
      index: 1,
    });
    expect(slot("insert into users values (|)")).toMatchObject({ columns: null, index: 0 });
    expect(slot("insert into users (email) values ('a'), (|")).toMatchObject({ index: 0 });
    expect(slot("insert into users (email|)")).toBeNull();
    expect(slot("select (|)")).toBeNull();
  });
});

describe("resolve", () => {
  const problems = (sql: string, driver: "sqlite" | "postgres" | "mysql" = "sqlite") =>
    new SqlResolver(sql, driver, model).problems().map((p) => `${sql.slice(p.from, p.to)}: ${p.message}`);

  it("accepts resolvable statements", () => {
    for (const sql of [
      "select u.id, u.email, count(*) cnt from users u join orders o on o.user_id = u.id group by u.id order by cnt desc;",
      "select id, name as n from users where name like 'a%' order by n;",
      "with big as (select user_id, total from orders where total > 10) select b.user_id, total from big b;",
      "select * from (select id, email from users) x where x.email is not null;",
      "insert into users (email, name) values ('a', 'b');",
      "update users set name = upper(name) where id = 1;",
      "delete from orders where status = 'new' and total between 1 and 2;",
      "select cast(total as text), coalesce(status, 'x') from orders where created is null;".replace("created", "id"),
      "select exists (select 1 from orders o where o.user_id = u.id) from users u;",
      "create table t (a int, b text); drop table if exists t;",
      "insert into users (email) values ('x') on conflict (email) do update set email = excluded.email;",
    ])
      expect(problems(sql), sql).toEqual([]);
  });

  it("flags unresolved tables, columns and qualifiers", () => {
    expect(problems("select * from usres;")).toEqual(["usres: Unable to resolve table 'usres'"]);
    expect(problems("select u.emial from users u;")).toEqual(["emial: Unable to resolve column 'emial'"]);
    expect(problems("select x.id from users u;")).toEqual(["x: Unable to resolve symbol 'x'"]);
    expect(problems("select nope from users;")).toEqual(["nope: Unable to resolve column 'nope'"]);
    expect(problems("insert into users (emial) values (1);")).toEqual(["emial: Unable to resolve column 'emial'"]);
    expect(problems("update users set nme = 1;")).toEqual(["nme: Unable to resolve column 'nme'"]);
  });

  it("leaves names alone when it cannot judge them", () => {
    expect(problems("select foo from unknown_table;")).toEqual([
      "unknown_table: Unable to resolve table 'unknown_table'",
    ]);
    expect(problems("select * from (select * from users) x where x.whatever = 1;")).toEqual([]);
    expect(problems("select rowid, * from users;")).toEqual([]);
  });

  it("judges Snowflake names without flagging variant paths, stages or other databases", () => {
    const snow = (sql: string) =>
      new SqlResolver(sql, "snowflake", sf).problems().map((p) => `${sql.slice(p.from, p.to)}: ${p.message}`);
    for (const sql of [
      "select src:customer.name::string, src['a'].b, u.src:x[0].y, $1 from users u where id = :id;",
      "select id from users qualify row_number() over (order by id) = 1;",
      "select f.value:x, f.index from users, lateral flatten(input => src, outer => true) f;",
      "select $1, metadata$filename from @my_stage/path (file_format => 'ff', pattern => '.*csv') t;",
      "select * exclude id from users sample (10); select dateadd(day, 1, id), date_trunc(quarter, id) from users;",
      "select * from other_db.public.users; select * from other_db.sch.missing;",
      "select o.nope from other_db.public.users o; select other_db.public.users.nope from other_db.public.users;",
      "insert into other_db.public.users (nope) values (1);",
      "select id from users where src:a ilike 'x%' and $$ nope $$ = 'a\\'nope' // nope\n;",
      'select "mixedCase", ID from PUBLIC.USERS;',
    ])
      expect(snow(sql), sql).toEqual([]);
    expect(snow("select nope from users;")).toEqual(["nope: Unable to resolve column 'nope'"]);
    expect(snow("select u.nope from public.users u;")).toEqual(["nope: Unable to resolve column 'nope'"]);
    expect(snow("select * from public.missing;")).toEqual(["missing: Unable to resolve table 'missing'"]);
    expect(snow("select * from missing;")).toEqual(["missing: Unable to resolve table 'missing'"]);
    const sql = "select id from db.public.users";
    expect(new SqlResolver(sql, "snowflake", sf).resolveAt(sql.length - 1)?.symbol).toMatchObject({
      kind: "table",
      table: { schema: "PUBLIC", name: "USERS" },
    });
  });

  it("resolves symbols for navigation and documentation", () => {
    const sql = "select u.email from users u join orders o on o.user_id = u.id;";
    const r = new SqlResolver(sql, "sqlite", model);
    const at = (needle: string, nth = 0) => {
      let i = -1;
      for (let k = 0; k <= nth; k++) i = sql.indexOf(needle, i + 1);
      return r.resolveAt(i + 1)?.symbol;
    };
    expect(at("u.email")).toMatchObject({ kind: "alias", name: "u", def: { from: sql.indexOf("u join") } });
    expect(at("email")).toMatchObject({ kind: "column", name: "email", owner: "u", table: { name: "users" } });
    expect(at("users")).toMatchObject({ kind: "table", table: { name: "users" } });
    expect(at("u join")).toMatchObject({ kind: "alias", table: { name: "users" } });
    expect(at("user_id")).toMatchObject({ kind: "column", owner: "o", column: { dataType: "INTEGER" } });
  });
});

describe("params", () => {
  it("binds whole ClickHouse typed parameters without treating their types as names", () => {
    const sql = "select {value:UInt64}, {label: Nullable(String)}, '{skip:String}'";
    const params = findParams(sql, "clickhouse");
    expect(params.map((p) => p.name)).toEqual(["{value:UInt64}", "{label: Nullable(String)}"]);
    expect(bindParams(sql, params, { "{value:UInt64}": "12", "{label: Nullable(String)}": "'test'" })).toBe(
      "select 12, 'test', '{skip:String}'",
    );
  });

  it("finds parameters per dialect and binds values", () => {
    const names = (sql: string, driver: "sqlite" | "postgres" | "mysql" = "sqlite", n = 0) =>
      findParams(sql, driver, n).map((p) => p.name);
    expect(names("select * from t where a = :id and b = ? and c = ?3 and d = @x and e = '?' -- ?")).toEqual([
      ":id",
      "?1",
      "?3",
      "@x",
    ]);
    expect(names("select * from t where a = ? and b = ?", "sqlite", 2)).toEqual(["?3", "?4"]);
    expect(names("select @x := 1, @@version, ? from t", "mysql")).toEqual(["?1"]);
    expect(names("select j ? 'k', $1, a::int from t where b = :name", "postgres")).toEqual(["$1", ":name"]);
    const sql = "update t set a = :v where id = :id and b = :v";
    expect(bindParams(sql, findParams(sql, "sqlite"), { ":v": "'x'", ":id": " 3 " })).toBe(
      "update t set a = 'x' where id = 3 and b = 'x'",
    );
    expect(bindParams("select ?", findParams("select ?", "sqlite"), {})).toBe("select NULL");
  });

  it("leaves Snowflake variant paths, casts, stages and session variables alone", () => {
    const names = (sql: string) => findParams(sql, "snowflake").map((p) => p.name);
    const sql = "SELECT src:customer.name::string, $1 FROM @my_stage/path (FILE_FORMAT => 'ff') t WHERE x = :id";
    expect(names(sql)).toEqual([":id"]);
    expect(bindParams(sql, findParams(sql, "snowflake"), { ":id": "7" })).toBe(sql.replace(":id", "7"));
    expect(
      names(
        "select src:a.b, \"V\":k, f(x):y, a[0]:z, {'k':v}, $1, $var, t.$2 from @~/dir, @%tbl, @db.sch.stg t " +
          "where a = $$ :no ? $$ and b = 'it\\'s :no' // :no ?\n",
      ),
    ).toEqual([]);
    expect(names("select * from t where a = ? and b=:name and c in (:x, ?)")).toEqual(["?1", ":name", ":x", "?2"]);
  });
});
