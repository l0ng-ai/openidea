/**
 * Logcat filter expressions in the shape Android Studio accepts:
 *
 *   tag:glide            the tag contains "glide"
 *   message:boom         the message contains "boom"
 *   pid:4242             the process (or thread) id is 4242
 *   level:error          the level is error (or `level:warn,error`, names or letters)
 *   -tag:chatty          "not": drops matching lines
 *   a b                  both, implicitly and-ed (`&` works too)
 *   a|b                  either, or-ed
 *   (a|b) -c             grouping
 *   message~:^Tile.*     a case-insensitive regular expression
 *   message:"two words"  quoted values, single or double
 *
 * A bare word matches the tag, the message, or `#pid`, as before.
 */
import type { LogcatLevel, LogcatLine } from "@/platform/ipc";

export type QueryField = "tag" | "message" | "pid" | "level" | "text";

export interface QueryTerm {
  field: QueryField;
  value: string;
  /** `key~:value`: `value` is a regular expression. */
  regex: boolean;
}

type QueryNode =
  | { kind: "term"; term: QueryTerm }
  | { kind: "not"; node: QueryNode }
  | { kind: "and"; nodes: QueryNode[] }
  | { kind: "or"; nodes: QueryNode[] };

export interface LogFilter {
  /** Whether a line passes. Every line passes when the query is empty or invalid. */
  test: (line: LogcatLine) => boolean;
  /** Why an invalid query was ignored, or `null`. */
  error: string | null;
}

const FIELD_ALIASES: Record<string, QueryField> = {
  tag: "tag",
  message: "message",
  msg: "message",
  pid: "pid",
  level: "level",
};

const LEVEL_NAMES: Record<string, LogcatLevel> = {
  verbose: "verbose",
  v: "verbose",
  debug: "debug",
  d: "debug",
  info: "info",
  i: "info",
  warn: "warn",
  warning: "warn",
  w: "warn",
  error: "error",
  e: "error",
  fatal: "fatal",
  assert: "fatal",
  a: "fatal",
  f: "fatal",
  unknown: "unknown",
};

class QueryError extends Error {}

/** Splits one word into a term. Unknown `key:value` pairs stay plain text. */
function toTerm(raw: string): QueryTerm {
  const colon = raw.indexOf(":");
  if (colon > 0) {
    let key = raw.slice(0, colon).toLowerCase();
    const regex = key.endsWith("~");
    if (regex) key = key.slice(0, -1);
    const field = FIELD_ALIASES[key];
    if (field) return { field, value: raw.slice(colon + 1), regex };
  }
  return { field: "text", value: raw, regex: false };
}

class Parser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): QueryNode | null {
    const node = this.or();
    if (this.peek() !== "") throw new QueryError(`Unexpected “${this.peek()}”`);
    return node;
  }

  /** Whitespace is insignificant; anything else is a token. */
  private peek(): string {
    while (this.index < this.source.length && /\s/.test(this.source[this.index]!)) this.index++;
    return this.source[this.index] ?? "";
  }

  private or(): QueryNode | null {
    const nodes: QueryNode[] = [];
    const first = this.and();
    if (first) nodes.push(first);
    while (this.peek() === "|") {
      this.index++;
      const next = this.and();
      if (!next) throw new QueryError("Nothing to match after |");
      nodes.push(next);
    }
    if (!nodes.length) return null;
    return nodes.length === 1 ? nodes[0]! : { kind: "or", nodes };
  }

  private and(): QueryNode | null {
    const nodes: QueryNode[] = [];
    for (;;) {
      const next = this.peek();
      if (next === "" || next === "|" || next === ")") break;
      if (next === "&") {
        this.index++;
        continue;
      }
      nodes.push(this.unary());
    }
    if (!nodes.length) return null;
    return nodes.length === 1 ? nodes[0]! : { kind: "and", nodes };
  }

  private unary(): QueryNode {
    const next = this.peek();
    if (next === "-" || next === "!") {
      this.index++;
      return { kind: "not", node: this.unary() };
    }
    if (next === "(") {
      this.index++;
      const node = this.or();
      if (!node) throw new QueryError("Empty parentheses");
      if (this.peek() !== ")") throw new QueryError("Missing )");
      this.index++;
      return node;
    }
    const word = this.word();
    if (!word) throw new QueryError(`Unexpected “${next}”`);
    return { kind: "term", term: toTerm(word) };
  }

  /** A run of characters up to whitespace or a separator, quotes removed. */
  private word(): string {
    let word = "";
    for (;;) {
      const c = this.source[this.index];
      if (c === undefined || /\s/.test(c) || c === "|" || c === "&" || c === ")" || c === "(") break;
      if (c === '"' || c === "'") {
        this.index++;
        while (this.index < this.source.length && this.source[this.index] !== c) {
          word += this.source[this.index]!;
          this.index++;
        }
        if (this.index < this.source.length) this.index++;
        continue;
      }
      word += c;
      this.index++;
    }
    return word;
  }
}

function levels(value: string): Set<LogcatLevel> {
  const names = value.split(",").map((part) => part.trim().toLowerCase());
  const chosen = new Set<LogcatLevel>();
  for (const name of names) {
    const level = LEVEL_NAMES[name];
    if (!level) throw new QueryError(`Unknown level “${name}”`);
    chosen.add(level);
  }
  return chosen;
}

function termMatcher(term: QueryTerm): (line: LogcatLine) => boolean {
  const value = term.value.toLowerCase();
  const named = term.field === "level" ? levels(term.value) : null;
  const pattern = term.regex && term.field !== "level" ? new RegExp(term.value, "i") : null;

  const hit = (text: string): boolean => {
    if (!term.regex) return value.length === 0 ? text.length === 0 : text.toLowerCase().includes(value);
    return pattern!.test(text);
  };

  switch (term.field) {
    case "tag":
      return (line) => hit(line.tag);
    case "message":
      return (line) => hit(line.message);
    case "pid":
      return (line) => line.pid === Number(term.value) || line.tid === Number(term.value);
    case "level":
      return (line) => named!.has(line.level);
    case "text": {
      const hash = value.startsWith("#") ? value.slice(1) : null;
      return (line) =>
        hit(line.message) ||
        hit(line.tag) ||
        (hash !== null && (String(line.pid) === hash || String(line.tid) === hash));
    }
  }
}

function compile(node: QueryNode): (line: LogcatLine) => boolean {
  switch (node.kind) {
    case "term":
      return termMatcher(node.term);
    case "not": {
      const inner = compile(node.node);
      return (line) => !inner(line);
    }
    case "and": {
      const parts = node.nodes.map(compile);
      return (line) => parts.every((part) => part(line));
    }
    case "or": {
      const parts = node.nodes.map(compile);
      return (line) => parts.some((part) => part(line));
    }
  }
}

const cache = new Map<string, LogFilter>();

/** Parses and compiles a query. Compiling is cached: the filter runs per line. */
export function compileQuery(query: string): LogFilter {
  const source = query.trim();
  if (!source) return { test: () => true, error: null };
  const hit = cache.get(source);
  if (hit) return hit;

  let filter: LogFilter;
  try {
    const node = new Parser(source).parse();
    filter = node ? { test: compile(node), error: null } : { test: () => true, error: null };
  } catch (e) {
    filter = { test: () => true, error: e instanceof Error ? e.message : String(e) };
  }

  // A handful of entries is enough: there is one query per keystroke at most.
  if (cache.size >= 32) cache.delete(cache.keys().next().value!);
  cache.set(source, filter);
  return filter;
}
