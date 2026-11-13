/**
 * Every SQL command of Snowflake's reference through the console's SQL assistance. The samples
 * are the ones the driver's tests run (`crates/ide-db/src/snowflake/commands.rs`): one statement
 * per documented command.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { formatted } from "./format";
import { lex } from "./lexer";
import { findParams } from "./params";
import { isReadOnlyQuery } from "./readOnly";

interface Command {
  command: string;
  sql: string;
  /** Running it again for another page of its result changes nothing. */
  rerunnable: boolean;
}

const fixture = resolve(process.cwd(), "crates/ide-db/tests/fixtures/snowflake/commands.json");
const commands = (JSON.parse(readFileSync(fixture, "utf8")) as { commands: Command[] }).commands;
/** What a statement is made of, whatever its layout and letter case. */
const shape = (sql: string) =>
  lex(sql, "snowflake")
    .tokens.map((t) => (t.kind === "word" ? t.upper : t.text))
    .join(" ");

describe("Snowflake commands", () => {
  it("has the whole reference", () => {
    expect(commands.length).toBeGreaterThanOrEqual(786);
  });

  it("lexes every command to its end", () => {
    for (const c of commands) {
      const { tokens, comments } = lex(c.sql, "snowflake");
      // The samples' only comments are inside `$$` bodies; `file://` is a path, not a comment.
      expect(comments, c.command).toEqual([]);
      expect(tokens.length, c.command).toBeGreaterThan(0);
      expect(tokens[0]!.kind, c.command).toBe("word");
      // No token runs past the statement or overlaps the one before.
      let end = 0;
      for (const t of tokens) {
        expect(t.from, c.command).toBeGreaterThanOrEqual(end);
        end = t.to;
      }
      expect(end, c.command).toBeLessThanOrEqual(c.sql.length);
    }
  });

  it("pages only what is safe to run again", () => {
    for (const c of commands) expect(isReadOnlyQuery(c.sql, "snowflake"), `${c.command}: ${c.sql}`).toBe(c.rerunnable);
  });

  it("asks for no parameter values", () => {
    // Stage paths, variant paths, `$1`, `:=`, `file://` and `=>` are not parameters.
    for (const c of commands) {
      if (c.command === "CALL") continue; // `INTO :result` is a bind variable
      expect(
        findParams(c.sql, "snowflake").map((p) => p.name),
        `${c.command}: ${c.sql}`,
      ).toEqual([]);
    }
  });

  it("formats every command without changing it, and settles", () => {
    for (const c of commands) {
      const once = formatted(c.sql, "snowflake");
      expect(shape(once), c.command).toBe(shape(c.sql));
      expect(formatted(once, "snowflake"), c.command).toBe(once);
      // Paths, casts, stages and scoped names stay in one piece: a space inside breaks them.
      for (const piece of c.sql.split(/\s+/)) {
        if (/[:!@$]/.test(piece) && !/['"(),;]/.test(piece) && !/^(:=|\$\$)$/.test(piece)) {
          expect(once, `${c.command}: ${piece}`).toContain(piece);
        }
      }
    }
  });
});
