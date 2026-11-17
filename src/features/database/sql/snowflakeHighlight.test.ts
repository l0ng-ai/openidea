import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { StandardSQL } from "@codemirror/lang-sql";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState, Prec } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { snowflakeLanguage } from "./snowflakeHighlight";

interface Piece {
  name: string;
  text: string;
}

/** The leaves of the syntax tree: what each run of text is coloured as. */
function pieces(sql: string): Piece[] {
  const out: Piece[] = [];
  snowflakeLanguage()
    .parser.parse(sql)
    .iterate({
      enter: (node) => {
        if (!node.node.firstChild) out.push({ name: node.name, text: sql.slice(node.from, node.to) });
      },
    });
  return out;
}

const named = (sql: string, name: string) =>
  pieces(sql)
    .filter((p) => p.name === name)
    .map((p) => p.text);

const fixture = resolve(process.cwd(), "crates/ide-db/tests/fixtures/snowflake/commands.json");
const commands = (JSON.parse(readFileSync(fixture, "utf8")) as { commands: Array<{ command: string; sql: string }> })
  .commands;

describe("Snowflake syntax colours", () => {
  it("colours the words of every documented command as keywords", () => {
    for (const c of commands) {
      const all = pieces(c.sql);
      // `GET` is a function as well as a command.
      expect(["Keyword", "Builtin"], `${c.command}: ${c.sql}`).toContain(all[0]?.name);
      // The command's own words (`ALTER ICEBERG TABLE`), wherever the sample uses them.
      const words = c.command.replace(/\([^)]*\)|<[^>]*>/g, "").match(/\b[A-Z][A-Z_0-9]+\b/g) ?? [];
      const coloured = new Set(
        all.filter((p) => ["Keyword", "Type", "Builtin"].includes(p.name)).map((p) => p.text.toUpperCase()),
      );
      const plain = new Set(all.filter((p) => p.name === "Identifier").map((p) => p.text.toUpperCase()));
      for (const word of words) {
        if (plain.has(word)) expect(coloured.has(word), `${c.command}: ${word} in ${c.sql}`).toBe(true);
      }
      expect(named(c.sql, "⚠"), `${c.command}: ${c.sql}`).toEqual([]);
    }
  });

  it("reads comments, bodies, strings and stages the way Snowflake does", () => {
    expect(named("select 1 // note; here\n, 2 -- other\n/* block */", "LineComment")).toEqual([
      "// note; here",
      "-- other",
    ]);
    const body = "$$\nbegin\n  return 'x'; -- inside\nend;\n$$";
    expect(named(`create procedure p() returns string language sql as ${body}; select 1`, "String")).toEqual([body]);
    // A doubled quote reads as two strings side by side: the same colour throughout.
    expect(named("select 'it''s', 'a\\'b', 'c;d'", "String")).toEqual(["'it'", "'s'", "'a\\'b'", "'c;d'"]);
    expect(named('select "My Col" from "DB"."S"."T"', "QuotedIdentifier")).toEqual(['"My Col"', '"DB"', '"S"', '"T"']);
    expect(named("select $1, $2:name, $my_var from @my_stage/dir/f.csv.gz, @~/x, @%t", "SpecialVar")).toEqual([
      "$1",
      "$2",
      "$my_var",
      "@my_stage/dir/f.csv.gz",
      "@~/x",
      "@%t",
    ]);
    // A location is not a comment, and what follows it is still read.
    const put = pieces("put file:///tmp/data.csv @my_stage auto_compress = true; select 1");
    expect(put.filter((p) => p.name === "LineComment")).toEqual([]);
    expect(put.filter((p) => p.name === "Keyword").map((p) => p.text)).toEqual(["put", "file", "true", "select"]);
    expect(put.some((p) => p.name === "Identifier" && p.text === "tmp")).toBe(true);
    expect(put.some((p) => p.name === "SpecialVar" && p.text === "@my_stage")).toBe(true);
  });

  it("colours Snowflake's own clauses, types and functions", () => {
    const sql =
      "select iff(a, 1, 2)::number, payload:k::varchar from t qualify row_number() over (order by a) = 1 limit 5";
    expect(named(sql, "Keyword")).toEqual(["select", "from", "qualify", "over", "order", "by", "limit"]);
    expect(named(sql, "Type")).toEqual(["number", "varchar"]);
    expect(named(sql, "Builtin")).toEqual(["iff", "row_number"]);
    for (const word of ["warehouse", "iceberg", "undrop", "variant", "ilike", "pivot", "asof", "clone", "stream"]) {
      expect(pieces(`x ${word} y`)[1]?.name, word).not.toBe("Identifier");
    }
  });

  it("takes over from the editor's standard SQL mode", () => {
    const doc = "select 1 // a note\n";
    const tree = (config: Parameters<typeof EditorState.create>[0]) =>
      ensureSyntaxTree(EditorState.create(config), doc.length, 1000)!;
    const comments = (config: Parameters<typeof EditorState.create>[0]) => {
      const found: string[] = [];
      tree(config).iterate({ enter: (n) => void (n.name === "LineComment" && found.push(doc.slice(n.from, n.to))) });
      return found;
    };
    expect(comments({ doc, extensions: [StandardSQL.extension] })).toEqual([]);
    expect(comments({ doc, extensions: [StandardSQL.extension, Prec.high(snowflakeLanguage().extension)] })).toEqual([
      "// a note",
    ]);
  });
});
