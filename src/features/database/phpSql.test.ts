import { beforeEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { findLanguageDescription, loadSupport } from "@/editor/core/cm/languages";
import type { DbCompletion } from "@/platform/ipc";
import { escapeForPhp, phpSqlCandidates, phpSqlSource } from "./phpSql";
import { useDatabase } from "./store";

const col = (name: string, primaryKey = false) => ({
  name,
  dataType: "INTEGER",
  nullable: !primaryKey,
  primaryKey,
  hasDefault: false,
});

const model: DbCompletion = {
  defaultSchema: "shop",
  tables: [
    { schema: "shop", name: "users", kind: "table", columns: [col("id", true), col("email"), col("name")] },
    { schema: "shop", name: "orders", kind: "table", columns: [col("id", true), col("user_id")] },
  ],
  foreignKeys: [],
};

/** Candidates at the `|` of `source`. */
async function complete(source: string, explicit = true, m: DbCompletion | null = model) {
  const pos = source.indexOf("|");
  const doc = source.slice(0, pos) + source.slice(pos + 1);
  const support = await loadSupport(findLanguageDescription("PHP", "index.php")!);
  const state = EditorState.create({ doc, extensions: [support!] });
  ensureSyntaxTree(state, doc.length, 5000);
  return phpSqlCandidates(state, pos, explicit, m, "mysql", "shop");
}

const labels = (r: Awaited<ReturnType<typeof complete>>, kind?: string) =>
  (r?.candidates ?? []).filter((c) => !kind || c.kind === kind).map((c) => c.label);

describe("SQL completion in PHP strings", () => {
  it("completes tables after FROM", async () => {
    const r = await complete("<?php\n$q = 'SELECT * FROM us|';\n");
    expect(labels(r, "table")).toContain("users");
    expect(r?.from).toBe("<?php\n$q = 'SELECT * FROM ".length);
  });

  it("completes the columns of the tables in scope", async () => {
    const r = await complete('<?php\n$rows = $db->query("SELECT em| FROM users WHERE id = $id");\n');
    expect(labels(r, "column")).toContain("email");
  });

  it("completes in strings marked with @lang", async () => {
    const r = await complete("<?php\n$q = /** @lang SQL */ 'SEL|';\n");
    expect(labels(r, "keyword")).toContain("SELECT");
  });

  it("offers keywords without a data source", async () => {
    const r = await complete("<?php\n$q = /** @lang SQL */ 'SEL|';\n", true, null);
    expect(labels(r, "keyword")).toContain("SELECT");
  });

  it("offers nothing outside SQL strings", async () => {
    expect(await complete("<?php\n$label = 'Select an item fr|';\n")).toBeNull();
    expect(await complete("<?php\n$us|er = 1;\n")).toBeNull();
  });

  it("does not pop up on its own without a word typed", async () => {
    expect(await complete("<?php\n$q = 'SELECT * FROM users |';\n", false)).toBeNull();
  });

  it("escapes inserted text for the string it lands in", () => {
    expect(escapeForPhp("`order`", "'")).toBe("`order`");
    expect(escapeForPhp('"Order"', '"')).toBe('\\"Order\\"');
    expect(escapeForPhp("it's", "'")).toBe("it\\'s");
    expect(escapeForPhp('"x"', null)).toBe('"x"');
  });
});

describe("data source of SQL in PHP", () => {
  beforeEach(() => {
    useDatabase.setState({ sources: [], connected: new Set(), consoles: {} });
  });

  const source = (id: string) => ({ id, name: id, driver: "mysql" }) as never;

  it("uses the connected data source, else the only one", () => {
    useDatabase.setState({ sources: [source("a"), source("b")], connected: new Set(["b"]) });
    expect(phpSqlSource("/p/index.php")).toBe("b");
    useDatabase.setState({ sources: [source("a")], connected: new Set() });
    expect(phpSqlSource("/p/index.php")).toBe("a");
    useDatabase.setState({ sources: [source("a"), source("b")], connected: new Set() });
    expect(phpSqlSource("/p/index.php")).toBeNull();
  });

  it("prefers the file's own binding", () => {
    useDatabase.setState({
      sources: [source("a"), source("b")],
      connected: new Set(["b"]),
      consoles: { "/p/index.php": "a" },
    });
    expect(phpSqlSource("/p/index.php")).toBe("a");
  });
});
