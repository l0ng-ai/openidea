import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { findLanguageDescription, loadSupport } from "./languages";
import { looksLikeSql, sqlStringAt, sqlText } from "./phpSql";

async function php(source: string) {
  const desc = findLanguageDescription("PHP", "index.php")!;
  const support = await loadSupport(desc);
  const state = EditorState.create({ doc: source, extensions: [support!] });
  ensureSyntaxTree(state, source.length, 5000);
  return state;
}

async function tokens(source: string) {
  const state = await php(source);
  const result: { text: string; style: string }[] = [];
  highlightTree(syntaxTree(state), classHighlighter, (from, to, style) =>
    result.push({ text: source.slice(from, to), style }),
  );
  return result;
}

const styleOf = (out: { text: string; style: string }[], text: string) => out.find((t) => t.text === text)?.style;

/** The SQL string at the `|` of `source` (the marker removed). */
async function at(source: string) {
  const pos = source.indexOf("|");
  const doc = source.slice(0, pos) + source.slice(pos + 1);
  const state = await php(doc);
  const s = sqlStringAt(state, pos);
  return s && { ...s, text: sqlText(s, (from, to) => doc.slice(from, to)), content: doc.slice(s.from, s.to) };
}

describe("SQL in PHP strings", () => {
  it("recognises statements by their text", () => {
    expect(looksLikeSql("SELECT id, name FROM users WHERE id = ?")).toBe(true);
    expect(looksLikeSql("  select * from users")).toBe(true);
    expect(looksLikeSql("SELECT 1")).toBe(true);
    expect(looksLikeSql("INSERT INTO users (name) VALUES (?)")).toBe(true);
    expect(looksLikeSql("UPDATE users SET name = ?")).toBe(true);
    expect(looksLikeSql("update `users` u set u.name = ?")).toBe(true);
    expect(looksLikeSql("DELETE FROM users")).toBe(true);
    expect(looksLikeSql("CREATE TABLE IF NOT EXISTS t (id INT)")).toBe(true);
    expect(looksLikeSql("ALTER TABLE t ADD c INT")).toBe(true);
    expect(looksLikeSql("WITH recent AS (SELECT 1) SELECT * FROM recent")).toBe(true);
    expect(looksLikeSql("TRUNCATE TABLE logs")).toBe(true);
  });

  it("leaves prose and other strings alone", () => {
    expect(looksLikeSql("Select an item from the list")).toBe(false);
    expect(looksLikeSql("select an option")).toBe(false);
    expect(looksLikeSql("Please update your profile")).toBe(false);
    expect(looksLikeSql("users")).toBe(false);
    expect(looksLikeSql("delete")).toBe(false);
    expect(looksLikeSql("with love")).toBe(false);
  });

  it("highlights SQL keywords inside a recognised string, keeping the quotes a string", async () => {
    const out = await tokens("<?php\n$sql = 'SELECT name FROM users WHERE id = 1';\n");
    expect(styleOf(out, "SELECT")).toBe("tok-keyword");
    expect(styleOf(out, "FROM")).toBe("tok-keyword");
    expect(styleOf(out, "WHERE")).toBe("tok-keyword");
    expect(styleOf(out, "1")).toBe("tok-number");
    expect(styleOf(out, "'")).toBe("tok-string");
    expect(styleOf(out, "$sql")).toContain("tok-variableName");
  });

  it("does not highlight an ordinary string", async () => {
    const out = await tokens("<?php\n$label = 'Select an item from the list';\n");
    expect(styleOf(out, "'Select an item from the list'")).toBe("tok-string");
    expect(styleOf(out, "Select")).toBeUndefined();
  });

  it("keeps interpolations PHP", async () => {
    const out = await tokens('<?php\n$q = "SELECT * FROM {$table} WHERE id = $id";\n');
    expect(styleOf(out, "SELECT")).toBe("tok-keyword");
    expect(styleOf(out, "WHERE")).toBe("tok-keyword");
    expect(styleOf(out, "$id")).toContain("tok-variableName");
    const s = await at('<?php\n$q = "SELECT * FROM {$table} WHERE id =| $id";\n');
    expect(s?.text).toBe("SELECT * FROM ________ WHERE id = ___");
    expect(s?.quote).toBe('"');
    expect(await at('<?php\n$q = "SELECT * FROM {$tab|le} WHERE id = 1";\n')).toBeNull();
  });

  it("follows @lang and language= comments", async () => {
    const lang = await at("<?php\n$q = /** @lang SQL */ 'id = ?|';\n");
    expect(lang?.content).toBe("id = ?");
    const line = await at("<?php\n// language=SQL\n$q = 'id = ?|';\n");
    expect(line?.content).toBe("id = ?");
    const call = await at("<?php\nDB::select(/** @lang MySQL */ 'x|');\n");
    expect(call?.content).toBe("x");
    expect(await at("<?php\n$q = /** @lang HTML */ 'SELECT * FROM t|';\n")).toBeNull();
    const out = await tokens("<?php\n$q = /** @lang SQL */ 'select id from t';\n");
    expect(styleOf(out, "select")).toBe("tok-keyword");
  });

  it("recognises heredocs and nowdocs labelled SQL", async () => {
    const heredoc = await at("<?php\n$q = <<<SQL\n  id = 1|\n  SQL;\n");
    expect(heredoc?.content).toBe("  id = 1");
    expect(heredoc?.quote).toBeNull();
    const nowdoc = await at("<?php\n$q = <<<'SQL'\nSELECT id FROM t|\nSQL;\n");
    expect(nowdoc?.content).toBe("SELECT id FROM t");
    expect(await at("<?php\n$q = <<<TXT\nhello|\nTXT;\n")).toBeNull();
    const out = await tokens("<?php\n$q = <<<SQL\nSELECT id FROM t\nSQL;\n");
    expect(styleOf(out, "SELECT")).toBe("tok-keyword");
  });

  it("still parses the HTML around PHP", async () => {
    const out = await tokens("<div><?php echo 'DELETE FROM t'; ?></div>");
    expect(styleOf(out, "div")).toBe("tok-typeName");
    expect(styleOf(out, "DELETE")).toBe("tok-keyword");
  });

  it("finds nothing outside strings", async () => {
    expect(await at("<?php\n$q| = 'SELECT * FROM t';\n")).toBeNull();
  });
});
