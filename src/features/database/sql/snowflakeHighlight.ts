/**
 * Syntax colours for consoles of a Snowflake data source. The editor's SQL mode is standard SQL;
 * Snowflake adds `//` comments, `$$` bodies, stages (`@stage/path`), `$1` / `$name`, backslash
 * escapes and several hundred command words.
 */
import { SQLDialect } from "@codemirror/lang-sql";
import type { LRLanguage } from "@codemirror/language";
import { ExternalTokenizer, type InputStream, type LRParser, type Stack } from "@lezer/lr";
import { DATA_TYPES, functions } from "./dialect";
import { SNOWFLAKE_KEYWORDS } from "./snowflakeKeywords";

/** A grammar tokenizer as the parser calls it. */
interface Tokenizer {
  token(input: InputStream, stack: Stack): void;
}

const SLASH = 47;
const COLON = 58;
const DOLLAR = 36;
const AT = 64;
/** A stage reference ends at whitespace, a bracket, a comma, a semicolon or a quote. */
const STAGE_END = /[\s(),;']/;
const WORD = /[\p{L}\p{N}_]/u;

function build(): LRLanguage {
  const spec = {
    keywords: SNOWFLAKE_KEYWORDS.toLowerCase(),
    types: DATA_TYPES.snowflake.join(" ").toLowerCase(),
    builtin: functions("snowflake")
      .map((f) => f.name)
      .join(" ")
      .toLowerCase(),
    doubleDollarQuotedStrings: true,
    backslashEscapes: true,
    identifierQuotes: '"',
    specialVar: "@",
  };
  const slashes = SQLDialect.define({ ...spec, slashComments: true }).language;
  const plain = SQLDialect.define({ ...spec, slashComments: false }).language;
  // The grammar's tokenizer is built per dialect: the one that differs between the two.
  const tokenizers = (language: LRLanguage) =>
    (language.parser as LRParser & { tokenizers: readonly ExternalTokenizer[] }).tokenizers;
  const index = tokenizers(slashes).findIndex((t, i) => t !== tokenizers(plain)[i]);
  const withComments = tokenizers(slashes)[index];
  const without = tokenizers(plain)[index];
  if (!withComments || !without) return slashes;
  const special = slashes.parser.nodeSet.types.find((type) => type.name === "SpecialVar")?.id;
  const tokens = new ExternalTokenizer((input, stack) => {
    const next = input.next;
    if (special !== undefined && (next === AT || next === DOLLAR)) {
      const first = String.fromCharCode(Math.max(input.peek(1), 0));
      // `$$` opens a body; `$1` is a column and `$name` a session variable.
      if (next === DOLLAR ? WORD.test(first) : !STAGE_END.test(first) && input.peek(1) >= 0) {
        input.advance();
        const part = next === AT ? (c: string) => !STAGE_END.test(c) : (c: string) => WORD.test(c);
        while (input.next >= 0 && part(String.fromCharCode(input.next))) input.advance();
        input.acceptToken(special);
        return;
      }
    }
    // The `//` of `file://…` (PUT, GET) starts no comment.
    const url = next === SLASH && input.peek(1) === SLASH && input.peek(-1) === COLON;
    ((url ? without : withComments) as unknown as Tokenizer).token(input, stack);
  });
  return slashes.configure({ tokenizers: [{ from: withComments, to: tokens }] });
}

let built: LRLanguage | undefined;

/** The Snowflake SQL language (built on first use). */
export function snowflakeLanguage(): LRLanguage {
  return (built ??= build());
}
