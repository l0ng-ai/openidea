import { tx } from "@/platform/i18n";
import type { DbCompletion } from "@/platform/ipc";
import { statementTokenRange } from "./sql/analyze";
import { quoteIdent } from "./sql/complete";
import { identName, inLiteral, lex, type Lexed, type Token } from "./sql/lexer";

export interface WorkspaceSourceReference {
  id: string;
  name: string;
  alias?: string;
  legacy?: "left" | "right";
}

interface WorkspaceTableReference {
  sourceId: string;
  database: string;
  schema: string;
  table: string;
}

export const WORKSPACE_SQL_LIMIT = 65_536;

/** Resolve a whole project list once, retaining ambiguity instead of choosing the first duplicate. */
export function workspaceSourceResolver(
  sources: readonly WorkspaceSourceReference[],
  bindings?: { legacySources?: { left: string; right: string }; sourceAliases?: Record<string, string> },
) {
  type Matches = Map<string, WorkspaceSourceReference | null>;
  const exact: Matches = new Map();
  const folded: Matches = new Map();
  const legacy = new Map<string, WorkspaceSourceReference | undefined>();
  for (const side of ["left", "right"] as const) {
    if (bindings?.legacySources?.[side]) legacy.set(side, undefined);
  }
  const put = (index: Matches, key: string, source: WorkspaceSourceReference) => {
    const previous = index.get(key);
    index.set(key, previous === undefined || previous?.id === source.id ? source : null);
  };
  for (const source of sources) {
    for (const name of [source.name, source.alias?.trim()]) {
      if (!name) continue;
      put(exact, name, source);
      put(folded, name.toLowerCase(), source);
    }
    if (source.legacy) legacy.set(source.legacy, source);
  }
  if (bindings?.sourceAliases) {
    const available = new Set(sources.map((source) => source.id));
    for (const [id, alias] of Object.entries(bindings.sourceAliases)) {
      if (alias.trim() && !available.has(id)) folded.delete(alias.trim().toLowerCase());
    }
  }
  return (name: string, quoted = false) => {
    if (quoted) return exact.get(name);
    const key = name.toLowerCase();
    return legacy.has(key) ? legacy.get(key) : folded.get(key);
  };
}

export function workspaceSourceAliasError(
  sources: readonly WorkspaceSourceReference[],
  resolve = workspaceSourceResolver(sources),
): string | null {
  for (const source of sources) {
    const alias = source.alias?.trim();
    if (!alias) continue;
    if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(alias))
      return tx("Start each SQL alias with a letter or underscore, then use letters, digits or underscores.");
    if (resolve(alias)?.id !== source.id) return tx("Choose a SQL alias unique to this source.");
  }
  return null;
}

type ResolveSource = ReturnType<typeof workspaceSourceResolver>;

type Column = { relation: number; column: string };
type Projection = { relation: number; column: string | null };
type Join = { left: Column; rightColumn: string };

function parseJoin(
  tokens: readonly Token[],
  resolveSource: ResolveSource,
  complete?: (table: WorkspaceTableReference) => void,
) {
  let cursor = 0;
  const take = (expected: string) => {
    if (tokens[cursor]?.upper !== expected) return false;
    cursor++;
    return true;
  };
  const need = (expected: string) => {
    if (!take(expected)) throw new Error(tx`Expected ${expected} in the workspace query.`);
  };
  const identifier = () => {
    const token = tokens[cursor++];
    if (token?.kind === "word") return token.text.toLowerCase();
    if (token?.kind === "quoted" && /^"(?:[^"]|"")+"$/.test(token.text)) return identName(token);
    throw new Error(tx("Expected an identifier in the workspace query."));
  };

  need("SELECT");
  const fields: { owner: string; column: string | null }[] = [];
  if (!take("*")) {
    do {
      const owner = identifier();
      need(".");
      fields.push({ owner, column: take("*") ? null : identifier() });
    } while (take(","));
  }
  need("FROM");
  const tables: WorkspaceTableReference[] = [];
  const aliases: string[] = [];
  const legacyQualifiers: (string | undefined)[] = [];
  const relation = () => {
    need("#");
    const quoted = tokens[cursor]?.kind === "quoted";
    const name = identifier();
    const source = resolveSource(name, quoted);
    if (source === null)
      throw new Error(tx`Multiple sources match ${name}. Set a unique SQL alias in Workspace Settings.`);
    if (!source) throw new Error(tx`Data source ${name} is unavailable. Type # to see available sources.`);
    need(".");
    const parts = [identifier()];
    while (take(".")) {
      if (parts.length === 3) throw new Error(tx("A table reference can include a database and a schema."));
      parts.push(identifier());
    }
    const table = parts.pop()!;
    const schema = parts.pop() ?? "";
    const database = parts.pop() ?? "";
    const explicit = take("AS") || (!!tokens[cursor] && !["INNER", "JOIN", "ON", ";"].includes(tokens[cursor]!.upper));
    const alias = explicit ? identifier() : table;
    if (aliases.some((existing, index) => existing === alias && (explicit || legacyQualifiers[index] === undefined)))
      throw new Error(tx("Give each workspace table a distinct alias."));
    aliases.push(alias);
    // Earlier drafts could qualify an unaliased table by its source name.
    legacyQualifiers.push(explicit ? undefined : name);
    tables.push({ sourceId: source.id, database, schema, table });
  };
  const indexOfOwner = (name: string) => {
    const index = aliases.indexOf(name);
    if (index >= 0 && aliases.lastIndexOf(name) === index) return index;
    const old = legacyQualifiers.indexOf(name);
    if (old >= 0 && legacyQualifiers.lastIndexOf(name) === old) return old;
    throw new Error(tx`Unknown or ambiguous table qualifier: ${name}.`);
  };
  const key = (candidate?: number): Column => {
    const relation = indexOfOwner(identifier());
    need(".");
    if (
      candidate !== undefined &&
      (relation === candidate || (relation < tables.length - 1 && candidate < tables.length - 1))
    )
      throw new Error(tx("Each JOIN must compare the new table with an earlier table."));
    if (cursor === tokens.length) complete?.(tables[relation]!);
    return { relation, column: identifier() };
  };
  relation();
  const joins: Join[] = [];
  do {
    take("INNER");
    need("JOIN");
    if (tables.length === 8) throw new Error(tx("A workspace query can join up to eight tables."));
    relation();
    need("ON");
    const a = key();
    need("=");
    const b = key(a.relation);
    joins.push(
      a.relation === tables.length - 1 ? { left: b, rightColumn: a.column } : { left: a, rightColumn: b.column },
    );
  } while (tokens[cursor]?.upper === "INNER" || tokens[cursor]?.upper === "JOIN");
  take(";");
  if (cursor !== tokens.length) throw new Error(tx("Expected one SELECT with direct equality JOINs."));
  const projection: Projection[] | null = fields.length
    ? fields.map(({ owner, column }) => ({ relation: indexOfOwner(owner), column }))
    : null;
  return { tables, joins, projection };
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

/** The host receives resolved identifiers and equality edges, never editor SQL. */
export function workspaceJoinQuery(sql: string, resolveSource: ResolveSource, caret?: number) {
  if (sql.length > WORKSPACE_SQL_LIMIT) throw new Error(tx("Workspace SQL exceeds 65,536 characters."));
  if (caret !== undefined) {
    const range = workspaceStatementRanges(sql, caret)[0];
    sql = range ? sql.slice(range.from, range.to) : "";
  }
  return parseJoin(lex(sql, "postgres").tokens, resolveSource);
}

export interface WorkspaceJoinColumnTarget extends WorkspaceTableReference {
  from: number;
  prefix: string;
  quoted: boolean;
}

export function workspaceJoinColumnTarget(
  sql: string,
  resolveSource: ResolveSource,
  lexed?: Lexed,
): WorkspaceJoinColumnTarget | null {
  if (sql.length > WORKSPACE_SQL_LIMIT) return null;
  const parsed = lexed ?? lex(sql, "postgres");
  const literal = inLiteral(parsed, sql.length);
  if (literal === "string" || literal === "comment") return null;
  const { start } = statementTokenRange(parsed.tokens, sql.length);
  const tokens = parsed.tokens.slice(start);
  const last = tokens.at(-1);
  const partial = last?.to === sql.length && (last.kind === "word" || last.kind === "quoted") ? last : undefined;
  if (tokens.at(partial ? -2 : -1)?.text !== ".") return null;
  let target: WorkspaceJoinColumnTarget | null = null;
  try {
    parseJoin(partial ? tokens.slice(0, -1) : tokens, resolveSource, (table) => {
      target = {
        ...table,
        from: partial?.from ?? sql.length,
        prefix: partial ? identName(partial) : "",
        quoted: partial?.kind === "quoted",
      };
    });
  } catch {
    // Completion parses an unfinished predicate and records its qualifier before the missing key.
  }
  return target;
}

/** Use workspace quoting for columns regardless of the selected table's database dialect. */
export function workspaceJoinColumnOptions(target: WorkspaceJoinColumnTarget, catalog: DbCompletion) {
  const schema = target.schema || catalog.defaultSchema;
  const table = catalog.tables.find(
    (table) => table.kind === "table" && table.schema === schema && table.name === target.table,
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
