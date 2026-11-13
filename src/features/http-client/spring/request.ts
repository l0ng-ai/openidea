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
  // Superclass properties first, as Jackson writes them.
  const chain = [cls];
  for (let c = cls; c.superclass && chain.length <= MAX_SUPERCLASSES;) {
    const parent = lookup(bareType(c.superclass).replace(/<.*$/, ""));
    if (!parent || chain.includes(parent)) break;
    chain.unshift((c = parent));
  }
  const obj: { [k: string]: Json } = {};
  for (const c of chain) {
    for (const p of c.ctorParams) if (!(p.name in obj)) obj[p.name] = skeleton(p.type, lookup, depth + 1);
    for (const f of c.fields) if (!f.isStatic && !(f.name in obj)) obj[f.name] = skeleton(f.type, lookup, depth + 1);
  }
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
  /** The project's files called `name` (from the index). */
  filesNamed?(name: string): Promise<string[]>;
}

/** How many superclasses of a body type are followed for their fields. */
const MAX_SUPERCLASSES = 5;

const dirname = (p: string) => p.replace(/[\\/][^\\/]*$/, "");

/** The Spring Boot configuration files (of `profile`) for `sourcePath` (its module's `src/main/resources`), most specific first. */
export function configCandidates(sourcePath: string, projectRoot: string | null, profile?: string): string[] {
  const norm = sourcePath.replace(/\\/g, "/");
  const at = norm.lastIndexOf("/src/main/");
  const roots = at >= 0 ? [norm.slice(0, at)] : [];
  if (projectRoot && !roots.includes(projectRoot)) roots.push(projectRoot.replace(/\\/g, "/").replace(/\/$/, ""));
  return roots.flatMap((r) =>
    ["properties", "yml", "yaml"].map((x) => `${r}/src/main/resources/application${profile ? `-${profile}` : ""}.${x}`),
  );
}

export async function findHost(sourcePath: string, projectRoot: string | null, fs: SourceReader): Promise<string> {
  const read = async (paths: string[]) => {
    const configs: Map<string, string>[] = [];
    for (const path of paths) {
      const text = await fs.read(path).catch(() => null);
      if (text !== null) configs.push(path.endsWith(".properties") ? parseProperties(text) : parseYaml(text));
    }
    return configs;
  };
  const base = await read(configCandidates(sourcePath, projectRoot));
  // `spring.profiles.active=dev`: `application-dev.*` overrides the base files (the last profile wins).
  const active = base.map((c) => resolved(c.get("spring.profiles.active"))).find(Boolean);
  const profiles = (active ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => /^[\w.-]+$/.test(p))
    .reverse();
  const profiled = await read(profiles.flatMap((p) => configCandidates(sourcePath, projectRoot, p)));
  return hostFromConfig([...profiled, ...base]);
}

/**
 * Body types of `endpoints`: classes of the controller's file, then `<Type>.java|.kt` beside
 * it or where its import points (same source root), else the project file of that name in the
 * imported (or same / wildcard-imported) package, e.g. a DTO in another Maven module. Their
 * superclasses are loaded too.
 */
export async function bodyLookup(
  sourcePath: string,
  file: SourceFile,
  endpoints: Endpoint[],
  fs: SourceReader,
): Promise<(name: string) => ClassDecl | null> {
  const known = new Map<string, ClassDecl>();
  /** Where each class was read: names in its declarations resolve from that file. */
  const origins = new Map<string, Origin>();
  const add = (o: Origin) => {
    for (const c of allClasses(o.file))
      if (!known.has(c.name)) {
        known.set(c.name, c);
        origins.set(c.name, o);
      }
  };
  const origin = { path: sourcePath.replace(/\\/g, "/"), file };
  add(origin);
  const sourceRoot = (path: string, f: SourceFile) => {
    let root = dirname(path);
    for (let i = f.packageName ? f.packageName.split(".").length : 0; i > 0; i--) root = dirname(root);
    return root;
  };
  const ext = /\.kt$/.test(sourcePath) ? [".kt", ".java"] : [".java", ".kt"];
  const readAt = async (path: string) => {
    const text = await fs.read(path).catch(() => null);
    if (text === null) return null;
    const loaded = { path, file: parseSource(text) };
    add(loaded);
    return loaded;
  };
  /** Loads `name` as seen from `from` (its imports, then its package). */
  const load = async (name: string, from: Origin) => {
    if (known.has(name)) return origins.get(name) ?? null;
    if (!/^[A-Z]\w*$/.test(name)) return null;
    const imported = from.file.imports.find((i) => i.endsWith(`.${name}`));
    const packages = imported
      ? [imported.split(".").slice(0, -1).join(".")]
      : [from.file.packageName, ...from.file.imports.filter((i) => i.endsWith(".*")).map((i) => i.slice(0, -2))];
    const root = sourceRoot(from.path, from.file);
    const dirs = new Set([...packages.map((p) => (p ? `${root}/${p.replace(/\./g, "/")}` : root)), dirname(from.path)]);
    for (const d of dirs)
      for (const x of ext) {
        const loaded = await readAt(`${d}/${name}${x}`);
        if (loaded) return loaded;
      }
    // Another source root or module: the project's files of that name, in one of those packages.
    if (!fs.filesNamed) return null;
    const suffixes = packages.map((p) => `/${p ? `${p.replace(/\./g, "/")}/` : ""}${name}`);
    for (const x of ext) {
      const paths = (await fs.filesNamed(`${name}${x}`).catch(() => [])).map((p) => p.replace(/\\/g, "/"));
      const path = paths.find((p) => suffixes.some((s) => p.endsWith(`${s}${x}`)));
      const loaded = path ? await readAt(path) : null;
      if (loaded) return loaded;
    }
    return null;
  };
  const typeName = (t: string) => bareType(t).replace(/<.*$/, "");
  /** `name`, its superclasses, and the property types of each, one level down. */
  const loadWithProperties = async (name: string, from: Origin, depth: number) => {
    const seen = new Set<string>();
    let [current, at]: [string | undefined, Origin | null] = [name, from];
    while (current && at && !seen.has(current) && seen.size < MAX_SUPERCLASSES) {
      seen.add(current);
      const loaded = await load(current, at);
      const c = known.get(current);
      if (!c || !loaded) break;
      if (depth > 0)
        for (const p of [...c.ctorParams, ...c.fields.filter((f) => !f.isStatic)])
          await loadWithProperties(typeName(p.type), loaded, depth - 1);
      [current, at] = [c.superclass && typeName(c.superclass), loaded];
    }
  };
  const names = new Set(endpoints.flatMap((e) => (e.bodyType ? [typeName(e.bodyType)] : [])));
  for (const n of names) await loadWithProperties(n, origin, 1);
  return (name) => known.get(name) ?? null;
}

interface Origin {
  path: string;
  file: SourceFile;
}
