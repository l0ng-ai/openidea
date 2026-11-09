/**
 * GraphQL schema discovery (IDEA's GraphQL plugin, scoped): which files make up
 * a schema, read from graphql-config files (`.graphqlrc*`, `graphql.config.*`)
 * or, without one, every GraphQL file of the project ("Default project-wide
 * schema"), and which endpoints a configuration declares. Pure: the store reads
 * the files, this module interprets them.
 */
import type { Diagnostic } from "@/bindings";
import { tx } from "@/platform/i18n";

export const SCHEMA_EXTENSIONS = ["graphql", "graphqls", "gql"];

/** graphql-config file names, most specific first (as `languages/graphql.toml` root markers). */
export const CONFIG_NAMES = [
  "graphql.config.yml",
  "graphql.config.yaml",
  "graphql.config.json",
  "graphql.config.js",
  "graphql.config.ts",
  ".graphqlrc",
  ".graphqlrc.yml",
  ".graphqlrc.yaml",
  ".graphqlrc.json",
];

/** Written by "Add Schema Configuration" (IDEA's template). */
export const CONFIG_TEMPLATE = `schema: schema.graphql
documents: '**/*.graphql'
`;

export interface Endpoint {
  name: string;
  url: string;
  headers: Record<string, string>;
}

export interface GraphQLConfig {
  /** Globs (relative to the config's folder) or URLs of introspected schemas. */
  schema: string[];
  endpoints: Endpoint[];
  /** A JS/TS config: its contents are code and are not evaluated. */
  dynamic: boolean;
  /** Environment variables it uses (`${NAME}`, `${NAME:default}`). */
  variables: string[];
}

/** Definitions counted the way IDEA's "Schema discovery summary" reports them. */
export interface SchemaStats {
  /** Object, interface, union and scalar types. */
  types: number;
  inputs: number;
  enums: number;
  directives: number;
}

/** A named type a definition refers to, checked against the whole schema. */
export interface TypeReference {
  name: string;
  /** The type declaring the field (or the union / implementing type). */
  owner: string;
  line: number;
  col: number;
}

export interface SchemaFile {
  path: string;
  stats: SchemaStats;
  /** Type names it defines. */
  defined: string[];
  references: TypeReference[];
}

/** One schema: a config file's, or the project-wide default one. */
export interface SchemaProject {
  key: string;
  /** The config file; null for the default schema. */
  configPath: string | null;
  /** The folder its globs are relative to. */
  root: string;
  /** The config's local schema pointers (globs or files), relative to `root`. */
  pointers: string[];
  files: SchemaFile[];
  /** Schema pointers that are URLs (introspected remotely, not read here). */
  remote: string[];
  endpoints: Endpoint[];
  dynamic: boolean;
  /** Environment variables its config uses. */
  variables: string[];
}

export function isSchemaFile(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot > 0 && SCHEMA_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase());
}

export function isConfigFile(name: string): boolean {
  return CONFIG_NAMES.includes(name);
}

// --- config parsing --------------------------------------------------------------------------

type Value = string | Value[] | { [key: string]: Value };

/** The YAML a graphql-config uses: nested maps, `-` lists, scalars and flow lists. */
export function parseYaml(text: string): Value {
  const lines = text
    .split(/\r?\n/)
    .map((raw) => ({ indent: raw.search(/\S/), text: stripComment(raw).trim() }))
    .filter((l) => l.indent >= 0 && l.text && l.text !== "---");
  let i = 0;
  const isItem = (t: string) => t === "-" || t.startsWith("- ");

  function block(indent: number): Value {
    const line = lines[i];
    if (!line || line.indent < indent) return "";
    return isItem(line.text) ? list(line.indent) : map(line.indent);
  }

  function list(indent: number): Value[] {
    const out: Value[] = [];
    for (let line = lines[i]; line && line.indent === indent && isItem(line.text); line = lines[i]) {
      const rest = line.text.slice(1).trim();
      if (!rest) {
        i++;
        out.push(block(indent + 1));
      } else if (keyOf(rest)) {
        // "- key: value" opens a map whose further keys are indented past the dash.
        lines[i] = { indent: indent + 2, text: rest };
        out.push(map(indent + 2));
      } else {
        i++;
        out.push(scalar(rest));
      }
    }
    return out;
  }

  function map(indent: number): Value {
    const out: { [key: string]: Value } = {};
    for (let line = lines[i]; line && line.indent === indent; line = lines[i]) {
      const kv = keyOf(line.text);
      if (!kv) break;
      i++;
      out[kv.key] = kv.value ? scalar(kv.value) : block(indent + 1);
    }
    return out;
  }

  return block(0);
}

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1] ?? ""))) return line.slice(0, i);
  }
  return line;
}

function keyOf(text: string): { key: string; value: string } | null {
  const m = /^("[^"]*"|'[^']*'|[^\s:'"][^:]*?)\s*:(?:\s+(.*))?$/.exec(text);
  return m ? { key: unquote(m[1] ?? ""), value: m[2]?.trim() ?? "" } : null;
}

function scalar(text: string): Value {
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    return inner ? inner.split(",").map((s) => unquote(s.trim())) : [];
  }
  return unquote(text);
}

function unquote(s: string): string {
  return s.length >= 2 && (s[0] === '"' || s[0] === "'") && s.at(-1) === s[0] ? s.slice(1, -1) : s;
}

function asStrings(v: unknown): string[] {
  if (typeof v === "string") return v ? [v] : [];
  if (Array.isArray(v)) return v.flatMap(asStrings);
  // `schema: { "https://api/graphql": { headers } }`: the pointer is the key.
  if (v && typeof v === "object") return Object.keys(v);
  return [];
}

function asHeaders(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"));
}

function asEndpoints(v: unknown): Endpoint[] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return [];
  return Object.entries(v).flatMap(([name, e]): Endpoint[] => {
    if (typeof e === "string") return [{ name, url: e, headers: {} }];
    if (e && typeof e === "object" && !Array.isArray(e) && typeof (e as { url?: unknown }).url === "string") {
      const { url, headers } = e as { url: string; headers?: unknown };
      return [{ name, url, headers: asHeaders(headers) }];
    }
    return [];
  });
}

/** Reads a graphql-config file (graphql-config v3+, and the legacy `schemaPath`). */
export function parseConfig(name: string, text: string): GraphQLConfig {
  const variables = [...new Set([...text.matchAll(ENV_VARIABLE)].map((m) => m[1] ?? ""))];
  const empty = { schema: [], endpoints: [], variables };
  if (/\.(js|ts)$/.test(name)) return { ...empty, dynamic: true };
  let data: unknown;
  try {
    data = name.endsWith(".json") || /^\s*\{/.test(text) ? JSON.parse(text) : parseYaml(text);
  } catch {
    return { ...empty, dynamic: false };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ...empty, dynamic: false };
  const o = data as Record<string, unknown>;
  const extensions = (o.extensions ?? {}) as Record<string, unknown>;
  return {
    schema: [...asStrings(o.schema), ...asStrings(o.schemaPath)],
    endpoints: asEndpoints(extensions.endpoints),
    dynamic: false,
    variables,
  };
}

/** graphql-config's environment variables: `${NAME}` or `${NAME:default}`. */
const ENV_VARIABLE = /\$\{([A-Za-z_]\w*)(?::([^}]*))?\}/g;

/** `text` with its `${NAME}` / `${NAME:default}` replaced from `values` (else the default, else ""). */
export function expandVariables(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(ENV_VARIABLE, (_m, name: string, fallback?: string) => values[name] ?? fallback ?? "");
}

/** Variables `endpoint` uses that have neither a value nor a default: it cannot run before they are set. */
export function missingVariables(endpoint: Endpoint, values: Readonly<Record<string, string>>): string[] {
  const missing = new Set<string>();
  for (const text of [endpoint.url, ...Object.values(endpoint.headers)])
    for (const [, name = "", fallback] of text.matchAll(ENV_VARIABLE))
      if (!values[name] && fallback === undefined) missing.add(name);
  return [...missing];
}

/** A response size as IDEA's result header shows it: "286 bytes", "1.7 kb". */
export function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} kb`;
}

/** `endpoint` with its URL and headers expanded. */
export function expandEndpoint(endpoint: Endpoint, values: Readonly<Record<string, string>>): Endpoint {
  return {
    ...endpoint,
    url: expandVariables(endpoint.url, values),
    headers: Object.fromEntries(Object.entries(endpoint.headers).map(([k, v]) => [k, expandVariables(v, values)])),
  };
}

/** 0-based lines declaring the endpoints of a config file, for its ▶ gutter (YAML or JSON). */
export function endpointLines(name: string, text: string): Array<{ endpoint: string; line: number }> {
  const endpoints = parseConfig(name, text).endpoints;
  if (!endpoints.length) return [];
  const lines = text.split(/\r?\n/);
  const section = lines.findIndex((l) => /^\s*["']?endpoints["']?\s*:/.test(l));
  if (section < 0) return [];
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return endpoints.flatMap(({ name: endpoint }) => {
    const key = new RegExp(`^\\s*["']?${escape(endpoint)}["']?\\s*:`);
    const at = lines.findIndex((l, i) => i > section && key.test(l));
    return at < 0 ? [] : [{ endpoint, line: at }];
  });
}

// --- schema files ----------------------------------------------------------------------------

/** `**`, `*`, `?` and `{a,b}` globs, matched against a `/`-separated relative path. */
export function globToRegExp(pattern: string): RegExp {
  const glob = pattern.replace(/^\.\//, "");
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        re += "(?:.*/)?";
      } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end < 0) re += "\\{";
      else {
        re += `(?:${glob
          .slice(i + 1, end)
          .split(",")
          .map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&"))
          .join("|")})`;
        i = end;
      }
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function isUrl(pointer: string): boolean {
  return /^https?:\/\//i.test(pointer);
}

const BUILTIN_TYPES = ["String", "Int", "Float", "Boolean", "ID"];

const DEFINITION =
  /\b(extend[ \t]+)?(type|interface|enum|input|union|scalar)[ \t]+([_A-Za-z]\w*)|\bdirective[ \t]+@([_A-Za-z]\w*)/g;

/** Comments and strings blanked out, offsets kept (so positions still match `text`). */
function codeOnly(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  return text.replace(/"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"|#[^\n]*/g, blank);
}

/** The body of the `{ … }` block starting at `open`, or "" when there is none. */
function blockAt(code: string, open: number): { body: string; start: number } {
  const close = code.indexOf("}", open);
  return close < 0 ? { body: "", start: open } : { body: code.slice(open + 1, close), start: open + 1 };
}

/** Definitions and type references of a schema file (a light parse, enough for discovery). */
export function analyzeSchema(text: string): Pick<SchemaFile, "stats" | "defined" | "references"> {
  const code = codeOnly(text);
  const lineStarts = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === "\n") lineStarts.push(i + 1);
  const position = (offset: number) => {
    let line = 0;
    while (line + 1 < lineStarts.length && (lineStarts[line + 1] ?? Infinity) <= offset) line++;
    return { line, col: offset - (lineStarts[line] ?? 0) };
  };
  const stats: SchemaStats = { types: 0, inputs: 0, enums: 0, directives: 0 };
  const defined = new Set<string>();
  const references: TypeReference[] = [];
  const refer = (name: string, owner: string, offset: number) => references.push({ name, owner, ...position(offset) });

  for (const m of code.matchAll(DEFINITION)) {
    const [whole, extend, kind, name, directive] = m;
    const at = m.index ?? 0;
    if (directive) {
      stats.directives++;
      continue;
    }
    if (!kind || !name) continue;
    if (!extend && !defined.has(name)) {
      defined.add(name);
      if (kind === "input") stats.inputs++;
      else if (kind === "enum") stats.enums++;
      else stats.types++;
    }
    const after = at + whole.length;
    const headerEnd = (() => {
      const brace = code.indexOf("{", after);
      const next = code
        .slice(after)
        .search(/\n[ \t]*(?:extend\b|type\b|interface\b|enum\b|input\b|union\b|scalar\b|directive\b|schema\b)/);
      const nextAt = next < 0 ? code.length : after + next;
      return brace >= 0 && brace < nextAt ? brace : nextAt;
    })();
    const header = code.slice(after, headerEnd);
    if (kind === "union" || /\bimplements\b/.test(header)) {
      const list =
        kind === "union" ? header.slice(header.indexOf("=") + 1) : header.slice(header.indexOf("implements") + 10);
      const listAt = after + header.length - list.length;
      for (const r of list.matchAll(/[_A-Za-z]\w*/g)) refer(r[0], name, listAt + (r.index ?? 0));
    }
    if (kind === "enum" || kind === "scalar" || kind === "union" || code[headerEnd] !== "{") continue;
    // Field and argument types: the name after each `:` (past `[`) in the block.
    const { body, start } = blockAt(code, headerEnd);
    for (const r of body.matchAll(/:\s*\[*\s*([_A-Za-z]\w*)/g)) {
      const typeName = r[1] ?? "";
      refer(typeName, name, start + (r.index ?? 0) + r[0].length - typeName.length);
    }
  }
  return { stats, defined: [...defined], references };
}

/** Named types used but defined nowhere in the schema (IDEA's "Schema errors"). */
export function unresolvedTypes(project: SchemaProject): Array<{ path: string; diagnostic: Diagnostic }> {
  const known = new Set([...BUILTIN_TYPES, ...project.files.flatMap((f) => f.defined)]);
  return project.files.flatMap((f) =>
    f.references
      .filter((r) => !known.has(r.name))
      .map((r) => ({
        path: f.path,
        diagnostic: {
          range: { start: { line: r.line, col: r.col }, end: { line: r.line, col: r.col + r.name.length } },
          severity: "error" as const,
          message: tx`The field type '${r.name}' is not present when resolving type '${r.owner}'`,
          source: "graphql",
          code: null,
        },
      })),
  );
}

export function schemaStats(project: SchemaProject): SchemaStats {
  const total: SchemaStats = { types: 0, inputs: 0, enums: 0, directives: 0 };
  for (const f of project.files) {
    total.types += f.stats.types;
    total.inputs += f.stats.inputs;
    total.enums += f.stats.enums;
    total.directives += f.stats.directives;
  }
  return total;
}

function relativeTo(root: string, path: string): string | null {
  if (root === "/") return path.replace(/^\//, "");
  return path.startsWith(root + "/") ? path.slice(root.length + 1) : null;
}

/**
 * The schemas of a project: one per config file, its `schema` globs picking files under
 * the config's folder; with no config, every GraphQL file is in the default schema.
 */
export function discoverSchemas(
  root: string,
  configs: ReadonlyArray<{ path: string; config: GraphQLConfig }>,
  files: readonly SchemaFile[],
): SchemaProject[] {
  if (!configs.length) {
    return [
      {
        key: "default",
        configPath: null,
        root,
        pointers: [],
        files: [...files].sort((a, b) => a.path.localeCompare(b.path)),
        remote: [],
        endpoints: [],
        dynamic: false,
        variables: [],
      },
    ];
  }
  return [...configs]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(({ path, config }) => {
      const dir = path.slice(0, path.lastIndexOf("/")) || "/";
      const globs = config.schema.filter((p) => !isUrl(p)).map(globToRegExp);
      return {
        key: path,
        configPath: path,
        root: dir,
        pointers: config.schema.filter((p) => !isUrl(p)),
        files: files
          .filter((f) => {
            const rel = relativeTo(dir, f.path);
            return rel !== null && globs.some((g) => g.test(rel));
          })
          .sort((a, b) => a.path.localeCompare(b.path)),
        remote: config.schema.filter(isUrl),
        endpoints: config.endpoints,
        dynamic: config.dynamic,
        variables: config.variables,
      };
    });
}

// --- tool window tree ------------------------------------------------------------------------

export type SchemaNode =
  | { kind: "project"; key: string; project: SchemaProject }
  | { kind: "summary"; key: string; project: SchemaProject }
  | { kind: "file"; key: string; file: SchemaFile }
  | { kind: "remote"; key: string; url: string }
  | { kind: "errors"; key: string; project: SchemaProject }
  | { kind: "error"; key: string; path: string; diagnostic: Diagnostic }
  | { kind: "noErrors"; key: string }
  | { kind: "endpoints"; key: string; project: SchemaProject }
  | { kind: "endpoint"; key: string; endpoint: Endpoint }
  | { kind: "noEndpoints"; key: string; project: SchemaProject };

export function projectNodes(projects: readonly SchemaProject[]): SchemaNode[] {
  return projects.map((project) => ({ kind: "project", key: project.key, project }));
}

/**
 * A schema's errors: unresolved types found by discovery, and the errors and warnings
 * the language server reports for its open files (the same problem only once).
 */
export function schemaProblems(
  project: SchemaProject,
  diagnosticsFor: (path: string) => readonly Diagnostic[],
): Array<{ path: string; diagnostic: Diagnostic }> {
  const own = unresolvedTypes(project);
  const seen = new Set(own.map(({ path, diagnostic: d }) => `${path}:${d.range.start.line}:${d.range.start.col}`));
  const reported = project.files.flatMap((f) =>
    diagnosticsFor(f.path)
      .filter((d) => d.severity === "error" || d.severity === "warning")
      .filter((d) => !seen.has(`${f.path}:${d.range.start.line}:${d.range.start.col}`))
      .map((diagnostic) => ({ path: f.path, diagnostic })),
  );
  return [...own, ...reported];
}

export function childNodes(
  node: SchemaNode,
  diagnosticsFor: (path: string) => readonly Diagnostic[],
): SchemaNode[] | undefined {
  const k = node.key;
  switch (node.kind) {
    case "project":
      return [
        { kind: "summary", key: `${k}#summary`, project: node.project },
        { kind: "errors", key: `${k}#errors`, project: node.project },
        { kind: "endpoints", key: `${k}#endpoints`, project: node.project },
      ];
    case "summary":
      return [
        ...node.project.files.map((file): SchemaNode => ({ kind: "file", key: `${k}:${file.path}`, file })),
        ...node.project.remote.map((url): SchemaNode => ({ kind: "remote", key: `${k}:${url}`, url })),
      ];
    case "errors": {
      const problems = schemaProblems(node.project, diagnosticsFor);
      if (!problems.length) return [{ kind: "noErrors", key: `${k}:none` }];
      return problems.map(({ path, diagnostic: d }, i) => ({
        kind: "error",
        key: `${k}:${i}:${path}:${d.range.start.line}:${d.range.start.col}`,
        path,
        diagnostic: d,
      }));
    }
    case "endpoints":
      if (!node.project.endpoints.length) return [{ kind: "noEndpoints", key: `${k}:none`, project: node.project }];
      return node.project.endpoints.map((endpoint) => ({ kind: "endpoint", key: `${k}:${endpoint.name}`, endpoint }));
    default:
      return undefined;
  }
}

// --- query execution -------------------------------------------------------------------------

/** A top-level definition of an executable document. */
export interface Definition {
  kind: "operation" | "fragment" | "other";
  name: string | null;
  from: number;
  to: number;
}

/** Top-level definitions of `doc`, found by brace matching outside comments and strings. */
export function topLevelDefinitions(doc: string): Definition[] {
  const code = codeOnly(doc);
  const out: Definition[] = [];
  let i = 0;
  while (i < code.length) {
    while (i < code.length && /[\s,]/.test(code.charAt(i))) i++;
    if (i >= code.length) break;
    const from = i;
    const open = code.indexOf("{", i);
    if (open < 0) break;
    let depth = 0;
    let j = open;
    for (; j < code.length; j++) {
      if (code[j] === "{") depth++;
      else if (code[j] === "}" && --depth === 0) break;
    }
    const to = Math.min(j + 1, code.length);
    const header = code.slice(from, open).trim();
    const m = /^(query|mutation|subscription|fragment)\b\s*([_A-Za-z]\w*)?/.exec(header);
    const kind = !header || (m && m[1] !== "fragment") ? "operation" : m ? "fragment" : "other";
    out.push({ kind, name: m?.[2] ?? null, from, to });
    i = to;
  }
  return out;
}

export interface QueryContext {
  /** What is sent. */
  text: string;
  /** The parts of the document it comes from (the rest is greyed out, as in IDEA). */
  ranges: Array<{ from: number; to: number }>;
}

/**
 * What Execute GraphQL sends, as IDEA's GraphQL plugin picks it: the selection; else the
 * operation around the caret with the fragments it uses; else the whole document.
 */
export function queryContext(doc: string, selection: { from: number; to: number } | null): QueryContext {
  if (selection && selection.to > selection.from)
    return { text: doc.slice(selection.from, selection.to).trim(), ranges: [selection] };
  const whole = { text: doc.trim(), ranges: [{ from: 0, to: doc.length }] };
  const defs = topLevelDefinitions(doc);
  const caret = selection?.from ?? -1;
  const op = defs.find((d) => d.kind === "operation" && d.from <= caret && caret <= d.to);
  if (!op) return whole;
  const code = codeOnly(doc);
  const fragments = new Map(defs.filter((d) => d.kind === "fragment" && d.name).map((d) => [d.name!, d]));
  const used = new Set<string>();
  const visit = (d: Definition) => {
    for (const s of code.slice(d.from, d.to).matchAll(/\.\.\.\s*([_A-Za-z]\w*)/g)) {
      const name = s[1] ?? "";
      const fragment = fragments.get(name);
      if (name === "on" || !fragment || used.has(name)) continue;
      used.add(name);
      visit(fragment);
    }
  };
  visit(op);
  const sent = defs.filter((d) => d === op || (d.kind === "fragment" && used.has(d.name ?? "")));
  return {
    text: sent.map((d) => doc.slice(d.from, d.to)).join("\n\n"),
    ranges: sent.map(({ from, to }) => ({ from, to })),
  };
}

export function queryText(doc: string, selection: { from: number; to: number } | null): string {
  return queryContext(doc, selection).text;
}

/** The parts of `[0, length)` outside `ranges` (sorted, non-overlapping). */
export function outsideRanges(
  length: number,
  ranges: ReadonlyArray<{ from: number; to: number }>,
): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  let pos = 0;
  for (const r of [...ranges].sort((a, b) => a.from - b.from)) {
    if (r.from > pos) out.push({ from: pos, to: r.from });
    pos = Math.max(pos, r.to);
  }
  if (pos < length) out.push({ from: pos, to: length });
  return out;
}

/** Errors in a GraphQL response body (`errors` array), 0 when it is not a GraphQL response. */
export function responseErrorCount(body: string | null): number {
  if (!body) return 0;
  try {
    const errors = (JSON.parse(body) as { errors?: unknown }).errors;
    return Array.isArray(errors) ? errors.length : 0;
  } catch {
    return 0;
  }
}

/** An `.http` request posting `query` (and `variables`) to `endpoint`, for the HTTP client to execute. */
export function httpRequestText(
  endpoint: Endpoint,
  query: string,
  variables: Record<string, unknown> | null = null,
): string {
  const headers = { "Content-Type": "application/json", ...endpoint.headers };
  return [
    `POST ${endpoint.url}`,
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    "",
    jsonWithoutTemplates(variables ? { query, variables } : { query }),
    "",
  ].join("\n");
}

/**
 * JSON the HTTP client sends as written: it expands `{{name}}`, which a GraphQL
 * selection (`{ a { b }}`) can contain, so braces inside strings are escaped.
 */
export function jsonWithoutTemplates(value: unknown): string {
  return JSON.stringify(value).replace(/"(?:[^"\\]|\\.)*"/g, (s) =>
    s.replace(/[{}]/g, (c) => (c === "{" ? "\\u007b" : "\\u007d")),
  );
}

/** The variables editor's text: empty, or a JSON object. */
export function parseVariables(text: string): { variables: Record<string, unknown> | null } | { error: string } {
  if (!text.trim()) return { variables: null };
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return { variables: v as Record<string, unknown> };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  return { error: "Variables must be a JSON object" };
}

/** Pretty-prints a JSON body; other bodies are shown as received. */
export function formatBody(body: string | null): string {
  if (body === null) return "";
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

// --- introspection ---------------------------------------------------------------------------

/** graphql-js `getIntrospectionQuery()` with descriptions. */
export const INTROSPECTION_QUERY = `query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types { ...FullType }
    directives { name description locations args { ...InputValue } }
  }
}
fragment FullType on __Type {
  kind name description
  fields(includeDeprecated: true) {
    name description args { ...InputValue } type { ...TypeRef } isDeprecated deprecationReason
  }
  inputFields { ...InputValue }
  interfaces { ...TypeRef }
  enumValues(includeDeprecated: true) { name description isDeprecated deprecationReason }
  possibleTypes { ...TypeRef }
}
fragment InputValue on __InputValue { name description type { ...TypeRef } defaultValue }
fragment TypeRef on __Type {
  kind name ofType { kind name ofType { kind name ofType { kind name ofType {
    kind name ofType { kind name ofType { kind name ofType { kind name } } } } } } }
}`;

interface TypeRef {
  kind: string;
  name: string | null;
  ofType?: TypeRef | null;
}
interface InputValue {
  name: string;
  description?: string | null;
  type: TypeRef;
  defaultValue?: string | null;
}
interface Deprecation {
  isDeprecated?: boolean;
  deprecationReason?: string | null;
}
interface Field extends Deprecation {
  name: string;
  description?: string | null;
  args?: InputValue[];
  type: TypeRef;
}
interface EnumValue extends Deprecation {
  name: string;
  description?: string | null;
}
interface FullType {
  kind: string;
  name: string;
  description?: string | null;
  fields?: Field[] | null;
  inputFields?: InputValue[] | null;
  interfaces?: TypeRef[] | null;
  enumValues?: EnumValue[] | null;
  possibleTypes?: TypeRef[] | null;
}
interface IntrospectionSchema {
  queryType?: { name: string } | null;
  mutationType?: { name: string } | null;
  subscriptionType?: { name: string } | null;
  types: FullType[];
  directives?: Array<{ name: string; description?: string | null; locations: string[]; args?: InputValue[] }>;
}

const BUILTIN_SCALARS = new Set(["String", "Int", "Float", "Boolean", "ID"]);
/** Spec directives every server has; `@oneOf` is printed, as IDEA does. */
const BUILTIN_DIRECTIVES = new Set(["include", "skip", "deprecated", "specifiedBy"]);

/** First line of a schema file written by "Get GraphQL Schema from Endpoint" (IDEA's). */
export const GENERATED_HEADER = "# This file was generated. Do not edit manually.";

/** IDEA (graphql-java's SchemaPrinter) indents by four spaces. */
const INDENT = "    ";

/** IDEA prints types grouped by kind, each group by name. */
const KIND_ORDER = ["INTERFACE", "UNION", "OBJECT", "ENUM", "SCALAR", "INPUT_OBJECT"];

const byName = <T extends { name: string }>(list: readonly T[] | null | undefined): T[] =>
  [...(list ?? [])].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

function printTypeRef(t: TypeRef): string {
  if (t.kind === "NON_NULL" && t.ofType) return `${printTypeRef(t.ofType)}!`;
  if (t.kind === "LIST" && t.ofType) return `[${printTypeRef(t.ofType)}]`;
  return t.name ?? "";
}

function printDescription(text: string | null | undefined, indent: string): string {
  if (!text) return "";
  if (!text.includes("\n")) return `${indent}${JSON.stringify(text)}\n`;
  const body = text
    .replace(/"""/g, '\\"""')
    .split("\n")
    .map((l) => (l ? indent + l : l))
    .join("\n");
  return `${indent}"""\n${body}\n${indent}"""\n`;
}

function printDeprecated(d: Deprecation): string {
  if (!d.isDeprecated) return "";
  return d.deprecationReason && d.deprecationReason !== "No longer supported"
    ? ` @deprecated(reason: ${JSON.stringify(d.deprecationReason)})`
    : " @deprecated";
}

function printInputValue(v: InputValue): string {
  return `${v.name}: ${printTypeRef(v.type)}${v.defaultValue != null ? ` = ${v.defaultValue}` : ""}`;
}

function printArgs(list: InputValue[] | undefined): string {
  return list?.length ? `(${list.map(printInputValue).join(", ")})` : "";
}

function printBlock(lines: string[]): string {
  return lines.length ? ` {\n${lines.join("\n")}\n}` : "";
}

function printType(t: FullType): string {
  const head = printDescription(t.description, "");
  switch (t.kind) {
    case "SCALAR":
      return `${head}scalar ${t.name}`;
    case "OBJECT":
    case "INTERFACE": {
      const impl = t.interfaces?.length ? ` implements ${t.interfaces.map(printTypeRef).join(" & ")}` : "";
      const fields = byName(t.fields).map(
        (f) =>
          `${printDescription(f.description, INDENT)}${INDENT}${f.name}${printArgs(f.args)}: ${printTypeRef(f.type)}${printDeprecated(f)}`,
      );
      return `${head}${t.kind === "OBJECT" ? "type" : "interface"} ${t.name}${impl}${printBlock(fields)}`;
    }
    case "UNION":
      return `${head}union ${t.name} = ${(t.possibleTypes ?? []).map(printTypeRef).join(" | ")}`;
    case "ENUM":
      return `${head}enum ${t.name}${printBlock(
        (t.enumValues ?? []).map(
          (v) => `${printDescription(v.description, INDENT)}${INDENT}${v.name}${printDeprecated(v)}`,
        ),
      )}`;
    case "INPUT_OBJECT":
      return `${head}input ${t.name}${printBlock(
        byName(t.inputFields).map((v) => `${printDescription(v.description, INDENT)}${INDENT}${printInputValue(v)}`),
      )}`;
    default:
      return "";
  }
}

/**
 * The schema file "Get GraphQL Schema from Endpoint" writes for an introspection response
 * body (`{"data":{"__schema":…}}`), laid out as IDEA writes it. Throws when there is no schema.
 */
export function introspectionToSdl(body: string): string {
  const json = JSON.parse(body) as { data?: { __schema?: IntrospectionSchema }; errors?: Array<{ message: string }> };
  const schema = json.data?.__schema;
  if (!schema) throw new Error(json.errors?.map((e) => e.message).join("\n") || "The response has no __schema");
  const roots: Array<[string, string | undefined]> = [
    ["query", schema.queryType?.name],
    ["mutation", schema.mutationType?.name],
    ["subscription", schema.subscriptionType?.name],
  ];
  const ops = roots.filter(([, name]) => name).map(([op, name]) => `${INDENT}${op}: ${name}`);
  const parts = [`schema {\n${ops.join("\n")}\n}`];
  for (const d of byName(schema.directives)) {
    if (BUILTIN_DIRECTIVES.has(d.name)) continue;
    parts.push(
      `${printDescription(d.description, "")}directive @${d.name}${printArgs(d.args)} on ${d.locations.join(" | ")}`,
    );
  }
  const types = schema.types.filter(
    (t) => !t.name.startsWith("__") && !(t.kind === "SCALAR" && BUILTIN_SCALARS.has(t.name)),
  );
  for (const kind of KIND_ORDER) for (const t of byName(types.filter((x) => x.kind === kind))) parts.push(printType(t));
  return `${GENERATED_HEADER}\n\n${parts.filter(Boolean).join("\n\n")}\n`;
}

/**
 * Where "Get GraphQL Schema from Endpoint" writes (IDEA): the config's first schema
 * pointer naming a file, else `schema.graphql` next to the config.
 */
export function introspectionTarget(project: SchemaProject): string {
  const file = project.pointers.find((p) => !/[*?{[]/.test(p)) ?? "schema.graphql";
  const base = project.root === "/" ? "" : project.root;
  return `${base}/${file.replace(/^\.\//, "")}`;
}
