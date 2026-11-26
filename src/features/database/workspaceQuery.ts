import { tx } from "@/platform/i18n";
import type { DbCompletion } from "@/platform/ipc";
import { statementTokenRange } from "./sql/analyze";
import { quoteIdent } from "./sql/complete";
import { identName, inLiteral, lex, type Lexed, type Token } from "./sql/lexer";

export interface WorkspaceRelation {
  source: "left" | "right";
  schema: string;
  table: string;
  alias: string;
  key: string;
}

const sides = ["left", "right"] as const;
type Side = (typeof sides)[number];
type SourceNames = Record<Side, string>;
const defaultNames: SourceNames = { left: "left", right: "right" };
export const WORKSPACE_SQL_LIMIT = 65_536;

export function workspaceSourceNames(left: string, right: string): SourceNames {
  const unique = left.toLowerCase() !== right.toLowerCase();
  const preferred = (name: string, side: Side) =>
    unique && name.trim() && !/^(left|right)$/i.test(name) ? name : side;
  return { left: preferred(left, "left"), right: preferred(right, "right") };
}

export function workspaceSourceAliasError(names: SourceNames, aliases: Partial<SourceNames>): string | null {
  for (const side of sides) {
    const alias = aliases[side]?.trim();
    if (!alias) continue;
    if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(alias))
      return tx("Start each SQL alias with a letter or underscore, then use letters, digits or underscores.");
    const peer = side === "left" ? "right" : "left";
    const folded = alias.toLowerCase();
    if (
      /^(left|right)$/i.test(alias) ||
      folded === names[peer].toLowerCase() ||
      folded === aliases[peer]?.trim().toLowerCase()
    )
      return tx("Choose a unique SQL alias. The names left and right are reserved.");
  }
  return null;
}

export function workspaceSourceSide(
  name: string,
  names: SourceNames,
  aliases: Partial<SourceNames> = {},
): Side | undefined {
  if (!name) return undefined;
  const folded = name.toLowerCase();
  return sides.find(
    (side) => folded === side || name === names[side] || folded === aliases[side]?.trim().toLowerCase(),
  );
}

function parseWorkspaceJoin(tokens: readonly Token[], names: SourceNames, aliases: Partial<SourceNames>) {
  const aliasError = workspaceSourceAliasError(names, aliases);
  if (aliasError) throw new Error(aliasError);
  let i = 0;
  const take = (expected: string) => {
    if (tokens[i]?.upper !== expected) return false;
    ++i;
    return true;
  };
  const need = (expected: string) => {
    if (!take(expected)) throw new Error(tx`Expected ${expected} in the workspace query.`);
  };
  const identifier = () => {
    const token = tokens[i++];
    if (token?.kind === "word") return token.text.toLowerCase();
    if (token?.kind === "quoted" && /^"(?:[^"]|"")+"$/.test(token.text)) return identName(token);
    throw new Error(tx("Expected an identifier in the workspace query."));
  };
  const relation = (): WorkspaceRelation => {
    need("#");
    const name = identifier();
    const source = workspaceSourceSide(name, names, aliases);
    if (!source) throw new Error(tx("Choose a source from completion after #, or use #left or #right."));
    need(".");
    const schema = identifier();
    need(".");
    const table = identifier();
    const alias = take("AS") || !["INNER", "JOIN", "ON"].includes(tokens[i]?.upper ?? "") ? identifier() : name;
    return { source, schema, table, alias, key: "" };
  };
  need("SELECT");
  need("*");
  need("FROM");
  const first = relation();
  take("INNER");
  need("JOIN");
  const second = relation();
  if (first.source === second.source || first.alias === second.alias)
    throw new Error(tx("Use two different sources and table aliases."));
  need("ON");
  const relations: [WorkspaceRelation, WorkspaceRelation] = [first, second];
  const columnOwner = () => {
    const alias = identifier();
    need(".");
    const target = relations.find((r) => r.alias === alias);
    if (!target || target.key) throw new Error(tx("The join must compare one column from each table."));
    return target;
  };
  const column = () => {
    columnOwner().key = identifier();
  };
  const at = (index: number) => i === index;
  return { relations, identifier, columnOwner, column, take, need, at };
}

/** Split on SQL delimiters, matching the console's trimmed UTF-16 ranges and caret rules. */
export function workspaceStatementRanges(sql: string, caret?: number): { from: number; to: number }[] {
  if (sql.length > WORKSPACE_SQL_LIMIT) throw new Error(tx("Workspace SQL exceeds 65,536 characters."));
  const ranges: { from: number; to: number }[] = [];
  let start = 0;
  let hasCode = false;
  const add = (end: number) => {
    if (!hasCode) return;
    const segment = sql.slice(start, end);
    ranges.push({ from: end - segment.trimStart().length, to: start + segment.trimEnd().length });
    hasCode = false;
  };
  for (const token of lex(sql, "postgres").tokens) {
    if (token.kind === "punct" && token.text === ";") {
      add(token.from);
      start = token.to;
    } else {
      hasCode = true;
    }
  }
  add(sql.length);
  if (caret === undefined || !ranges.length) return ranges;
  const next = ranges.findIndex(({ to }) => to >= caret);
  if (next === -1) return [ranges.at(-1)!];
  const current = ranges[next]!;
  const previous = ranges[next - 1];
  if (caret < current.from && previous && (sql.slice(previous.to, caret).match(/\n/g)?.length ?? 0) <= 1) {
    return [previous];
  }
  return [current];
}

/** Compile the workspace's direct table JOIN to structured host arguments. */
export function workspaceJoinQuery(
  sql: string,
  names: SourceNames = defaultNames,
  aliases: Partial<SourceNames> = {},
  caret?: number,
): [WorkspaceRelation, WorkspaceRelation] {
  if (sql.length > WORKSPACE_SQL_LIMIT) throw new Error(tx("Workspace SQL exceeds 65,536 characters."));
  if (caret !== undefined) {
    const range = workspaceStatementRanges(sql, caret)[0];
    sql = range ? sql.slice(range.from, range.to) : "";
  }
  const { tokens } = lex(sql, "postgres");
  const query = parseWorkspaceJoin(tokens, names, aliases);
  query.column();
  query.need("=");
  query.column();
  query.take(";");
  if (!query.at(tokens.length)) throw new Error(tx("The workspace supports one direct equality JOIN per statement."));
  return query.relations;
}

export interface WorkspaceJoinColumnTarget {
  source: Side;
  schema: string;
  table: string;
  from: number;
  prefix: string;
  quoted: boolean;
}

/** Find the table named by the qualifier at the end of the SQL prefix. */
export function workspaceJoinColumnTarget(
  sql: string,
  names: SourceNames = defaultNames,
  aliases: Partial<SourceNames> = {},
  lexed?: Lexed,
): WorkspaceJoinColumnTarget | null {
  if (sql.length > WORKSPACE_SQL_LIMIT) return null;
  const parsed = lexed ?? lex(sql, "postgres");
  const { start } = statementTokenRange(parsed.tokens, sql.length);
  const tokens = parsed.tokens.slice(start);
  const last = tokens.at(-1);
  const partial = last?.to === sql.length && (last.kind === "word" || last.kind === "quoted") ? last : undefined;
  if (tokens.at(partial ? -2 : -1)?.text !== ".") return null;
  const literal = inLiteral(parsed, sql.length);
  if (literal === "string" || literal === "comment") return null;

  const atCaret = tokens.length - Number(!!partial);
  try {
    const query = parseWorkspaceJoin(tokens, names, aliases);
    let relation = query.columnOwner();
    if (!query.at(atCaret)) {
      relation.key = query.identifier();
      query.need("=");
      relation = query.columnOwner();
    }
    if (!query.at(atCaret)) return null;
    const { source, schema, table } = relation;
    return {
      source,
      schema,
      table,
      from: partial?.from ?? sql.length,
      prefix: partial ? identName(partial) : "",
      quoted: partial?.kind === "quoted",
    };
  } catch {
    return null;
  }
}

/** Use workspace quoting for columns regardless of the selected table's database dialect. */
export function workspaceJoinColumnOptions(target: WorkspaceJoinColumnTarget, catalog: DbCompletion) {
  const table = catalog.tables.find(
    (table) => table.kind === "table" && table.schema === target.schema && table.name === target.table,
  );
  const prefix = target.quoted ? target.prefix : target.prefix.toLowerCase();
  const options = [];
  for (const column of table?.columns ?? []) {
    if (!(target.quoted ? column.name : column.name.toLowerCase()).startsWith(prefix)) continue;
    options.push({
      label: column.name,
      apply: quoteIdent(column.name, "postgres"),
      detail: column.dataType,
      type: "property",
    });
    if (options.length === 100) break;
  }
  return options;
}
