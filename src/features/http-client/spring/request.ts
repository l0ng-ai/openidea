/**
 * Spring endpoints → `.http` requests: the server address from
 * `application.properties` / `application.yml`, `{var}` → `{{var}}`, query
 * parameters, headers and a JSON skeleton of the `@RequestBody` type.
 */
import type { Endpoint } from "./endpoints";
import { allClasses, parseSource, type ClassDecl, type SourceFile } from "./source";

/** Flat `key → value` of a `.properties` file (`=`, `:` or space separated; `#` / `!` comments). */
export function parseProperties(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    while (line.endsWith("\\") && i + 1 < lines.length) line = line.slice(0, -1) + lines[++i]!.trim();
    const m = /^((?:\\.|[^=:\s])+)\s*[=:\s]\s*(.*)$/.exec(line);
    if (m && !out.has(m[1]!)) out.set(m[1]!.replace(/\\(.)/g, "$1"), m[2]!.trim());
  }
  return out;
}

/** Flat dotted keys of a YAML file's first document (block mappings and scalars only; enough for `server.*`). */
export function parseYaml(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const stack: { indent: number; key: string }[] = [];
  let started = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^---/.test(raw)) {
      if (started) break;
      continue;
    }
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim() || line.trim().startsWith("#") || line.trim().startsWith("- ")) continue;
    const m = /^(\s*)("[^"]*"|'[^']*'|[^:]+?)\s*:(?:\s+(.*))?$/.exec(line);
    if (!m) continue;
    started = true;
    const indent = m[1]!.length;
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const key = m[2]!.replace(/^["']|["']$/g, "");
    const path = [...stack.map((s) => s.key), key].join(".");
    const value = m[3]?.trim();
    if (value && value !== "|" && value !== ">") {
      if (!out.has(path)) out.set(path, value.replace(/^"(.*)"$|^'(.*)'$/, "$1$2"));
    } else stack.push({ indent, key });
  }
  return out;
}

/** `${PORT:8081}` → `8081`; a placeholder without a default is unknown. */
function resolved(value: string | undefined): string | null {
  if (value === undefined) return null;
  let unknown = false;
  const out = value.replace(/\$\{[^}:]*(?::([^}]*))?\}/g, (_m, def: string | undefined) => {
    if (def === undefined) unknown = true;
    return def ?? "";
  });
  return unknown ? null : out;
}

/** `http://localhost:<server.port><context path>` from Spring Boot configuration (first file with a value wins). */
export function hostFromConfig(configs: Map<string, string>[]): string {
  const get = (...keys: string[]) => {
    for (const c of configs)
      for (const k of keys) {
        const v = resolved(c.get(k));
        if (v) return v;
      }
    return null;
  };
  const port = get("server.port");
  const ssl = /^true$/i.test(get("server.ssl.enabled") ?? "") || !!get("server.ssl.key-store");
  const scheme = ssl ? "https" : "http";
  const portNum = port && /^\d+$/.test(port) && port !== "0" ? Number(port) : 8080;
  const context = [
    get("server.servlet.context-path", "server.context-path", "spring.webflux.base-path") ?? "",
    get("spring.mvc.servlet.path") ?? "",
  ]
    .join("/")
    .replace(/\/{2,}/g, "/")
    .replace(/\/$/, "");
  const ctx = context && !context.startsWith("/") ? `/${context}` : context;
  return `${scheme}://localhost:${portNum}${ctx}`;
}

const NUMBER =
  /^(byte|short|int|long|float|double|Byte|Short|Integer|Long|Float|Double|Int|BigDecimal|BigInteger|Number|UByte|UShort|UInt|ULong)\??$/;
const BOOLEAN = /^(boolean|Boolean)\??$/;
const STRING =
  /^(String|CharSequence|char|Character|Char|UUID|LocalDate|LocalDateTime|LocalTime|Instant|OffsetDateTime|ZonedDateTime|Date|Duration|URI|URL)\??$/;
const COLLECTION =
  /^(List|ArrayList|LinkedList|Set|HashSet|TreeSet|LinkedHashSet|Collection|Iterable|MutableList|MutableSet|Flux|Array|.*Array)(<.*>)?\??$|\[\]$|\.\.\.$/;
const MAP = /^(Map|HashMap|LinkedHashMap|TreeMap|MutableMap|MultiValueMap|JsonNode|ObjectNode)(<.*>)?\??$/;

/** Unwraps `Mono<T>`, `Optional<T>`, `HttpEntity<T>`, `@Valid`-less qualified names and nullability. */
export function bareType(type: string): string {
  let t = type.trim().replace(/\?$/, "");
  for (;;) {
    const m = /^(?:[\w.]*\.)?(Mono|Optional|HttpEntity|RequestEntity|Deferred|CompletableFuture)<(.*)>$/.exec(t);
    if (!m) break;
    t = m[2]!.trim();
  }
  return t.replace(/^(?:[a-z_$][\w$]*\.)+/, "");
}

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Placeholder value for a field / body of `type`; classes found by `lookup` get their properties (one level deep for nested ones). */
export function skeleton(type: string, lookup: (name: string) => ClassDecl | null, depth = 0): Json {
  const t = bareType(type);
  if (NUMBER.test(t)) return 0;
  if (BOOLEAN.test(t)) return false;
  if (STRING.test(t)) return "";
  if (COLLECTION.test(t)) return [];
  if (MAP.test(t) || t === "Object" || t === "Any" || !t) return {};
  const cls = lookup(t.replace(/<.*$/, ""));
  if (!cls || depth > 1) return {};
  const obj: { [k: string]: Json } = {};
  for (const p of cls.ctorParams) obj[p.name] = skeleton(p.type, lookup, depth + 1);
  for (const f of cls.fields) if (!f.isStatic && !(f.name in obj)) obj[f.name] = skeleton(f.type, lookup, depth + 1);
  return obj;
}

const pathVariables = (path: string) => path.replace(/\{\*?([\w.-]+)(?::[^{}]*(?:\{[^{}]*\}[^{}]*)*)?\}/g, "{{$1}}");

export interface RenderOptions {
  host: string;
  /** Path to use (one of `endpoint.paths`); default the first. */
  path?: string;
  /** JSON body of the `@RequestBody` type. */
  body?: Json;
}

/** One `### Name` request block, ending with a line break. */
export function renderRequest(e: Endpoint, opts: RenderOptions): string {
  const path = pathVariables(opts.path ?? e.paths[0] ?? "/");
  const query = e.query.map((q) => `${q.name}=${q.value ?? `{{${q.name}}}`}`).join("&");
  const lines = [
    `### ${e.className}.${e.methodName}`,
    `${e.httpMethod} ${opts.host}${path}${query ? `?${query}` : ""}`,
  ];
  const headers = [...e.headers];
  const contentType = e.consumes ?? (e.bodyType ? "application/json" : null);
  if (e.produces) headers.unshift({ name: "Accept", value: e.produces });
  if (contentType && (e.bodyType || e.consumes)) headers.push({ name: "Content-Type", value: contentType });
  for (const h of headers) lines.push(`${h.name}: ${h.value}`);
  if (e.bodyType) {
    lines.push("");
    const body = opts.body ?? {};
    const form =
      contentType === "application/x-www-form-urlencoded" && body && typeof body === "object" && !Array.isArray(body);
    lines.push(
      form
        ? Object.keys(body)
            .map((k) => `${k}=`)
            .join("&")
        : JSON.stringify(body, null, 2),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Text to append to a request file holding `existing`, and the offset (in the new text) of the first request line. */
export function appendRequests(existing: string, blocks: string[]): { insert: string; from: number; caret: number } {
  const from = existing.length;
  let sep = "";
  if (existing.trim()) sep = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  const insert = sep + blocks.join("\n");
  const firstLine = blocks[0]?.indexOf("\n") ?? -1;
  return { insert, from, caret: from + sep.length + (firstLine >= 0 ? firstLine + 1 : 0) };
}

// --- project lookups -------------------------------------------------------------

export interface SourceReader {
  /** File text, null when missing. */
  read(path: string): Promise<string | null>;
}

const dirname = (p: string) => p.replace(/[\\/][^\\/]*$/, "");

/** The Spring Boot configuration files for `sourcePath` (its module's `src/main/resources`), most specific first. */
export function configCandidates(sourcePath: string, projectRoot: string | null): string[] {
  const norm = sourcePath.replace(/\\/g, "/");
  const at = norm.lastIndexOf("/src/main/");
  const roots = at >= 0 ? [norm.slice(0, at)] : [];
  if (projectRoot && !roots.includes(projectRoot)) roots.push(projectRoot.replace(/\\/g, "/").replace(/\/$/, ""));
  return roots.flatMap((r) =>
    ["application.properties", "application.yml", "application.yaml"].map((f) => `${r}/src/main/resources/${f}`),
  );
}

export async function findHost(sourcePath: string, projectRoot: string | null, fs: SourceReader): Promise<string> {
  const configs: Map<string, string>[] = [];
  for (const path of configCandidates(sourcePath, projectRoot)) {
    const text = await fs.read(path).catch(() => null);
    if (text === null) continue;
    configs.push(path.endsWith(".properties") ? parseProperties(text) : parseYaml(text));
  }
  return hostFromConfig(configs);
}

/**
 * Body types of `endpoints`: classes of the controller's file, then
 * `<Type>.java|.kt` beside it or where its import points (same source root).
 */
export async function bodyLookup(
  sourcePath: string,
  file: SourceFile,
  endpoints: Endpoint[],
  fs: SourceReader,
): Promise<(name: string) => ClassDecl | null> {
  const known = new Map<string, ClassDecl>();
  const add = (f: SourceFile) => {
    for (const c of allClasses(f)) if (!known.has(c.name)) known.set(c.name, c);
  };
  add(file);
  const sourceRoot = (path: string, f: SourceFile) => {
    let root = dirname(path);
    for (let i = f.packageName ? f.packageName.split(".").length : 0; i > 0; i--) root = dirname(root);
    return root;
  };
  const ext = /\.kt$/.test(sourcePath) ? [".kt", ".java"] : [".java", ".kt"];
  /** Loads `name` as seen from `from` (its imports, then its directory). */
  const load = async (name: string, from: { path: string; file: SourceFile }) => {
    if (known.has(name) || !/^[A-Z]\w*$/.test(name)) return null;
    const imported = from.file.imports.find((i) => i.endsWith(`.${name}`));
    const dir = dirname(from.path);
    const pkgDir = imported && `${sourceRoot(from.path, from.file)}/${imported.split(".").slice(0, -1).join("/")}`;
    for (const d of pkgDir ? [pkgDir, dir] : [dir])
      for (const x of ext) {
        const path = `${d}/${name}${x}`;
        const text = await fs.read(path).catch(() => null);
        if (text === null) continue;
        const loaded = parseSource(text);
        add(loaded);
        return { path, file: loaded };
      }
    return null;
  };
  const typeName = (t: string) => bareType(t).replace(/<.*$/, "");
  const origin = { path: sourcePath.replace(/\\/g, "/"), file };
  const names = new Set(endpoints.flatMap((e) => (e.bodyType ? [typeName(e.bodyType)] : [])));
  for (const n of names) {
    const from = (await load(n, origin)) ?? origin;
    // Property types one level down, as seen from the body type's file.
    const c = known.get(n);
    for (const p of c ? [...c.ctorParams, ...c.fields.filter((f) => !f.isStatic)] : [])
      await load(typeName(p.type), from);
  }
  return (name) => known.get(name) ?? null;
}
