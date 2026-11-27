/**
 * Flask and FastAPI routes read from Python sources: route decorators on apps, blueprints
 * and routers, with the prefixes their `Blueprint(url_prefix=…)` / `APIRouter(prefix=…)` and
 * `register_blueprint(…)` / `include_router(…)` calls add, across modules. A text scan, not a
 * Python parser: string literals and comments are masked first so brackets and keywords inside
 * them don't count; a path built at runtime (an f-string, a constant) is skipped.
 */

export interface PythonSource {
  /** Absolute path. */
  path: string;
  /** Path relative to its project folder, `/`-separated. */
  rel: string;
  text: string;
}

export interface PythonRoute {
  framework: "Flask" | "FastAPI";
  method: string;
  /** The full path, path parameters as `{name}`. */
  url: string;
  /** Dotted module of the file (`app.routers.items`). */
  module: string;
  /** The view function. */
  handler: string;
  path: string;
  rel: string;
  /** 0-based line and UTF-16 column of the decorator. */
  line: number;
  col: number;
}

type Kind = "Flask" | "FastAPI" | "Blueprint" | "APIRouter";

/** A Flask / FastAPI app, blueprint or router assigned to a name. */
interface WebObject {
  module: string;
  name: string;
  kind: Kind;
  /** `url_prefix=` / `prefix=` of the constructor. */
  prefix: string;
}

/** `parent.register_blueprint(child, url_prefix=…)` / `parent.include_router(child, prefix=…)`. */
interface Registration {
  file: ParsedFile;
  parent: string;
  child: string;
  prefix: string | null;
}

interface Decorator {
  receiver: string;
  verb: string;
  paths: string[];
  methods: string[] | null;
  handler: string;
  offset: number;
}

interface ParsedFile {
  source: PythonSource;
  module: string;
  /** Local name → imported module and name (`null`: the module itself). */
  imports: Map<string, { module: string; name: string | null }>;
  objects: WebObject[];
  decorators: Decorator[];
  registrations: Registration[];
  usesFastApi: boolean;
}

const VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);

/** Dotted module of a `.py` file: `app/routers/items.py` → `app.routers.items`, `pkg/__init__.py` → `pkg`. */
export function moduleOf(rel: string): string {
  return rel
    .replace(/\.py$/, "")
    .replace(/(^|\/)__init__$/, "")
    .replace(/\//g, ".");
}

/**
 * `text` with comments and the contents of string literals replaced by spaces (newlines kept,
 * so offsets and lines stay), and each literal's value by the offset of its opening quote;
 * `null` for an f-string, whose value is only known at runtime.
 */
export function maskPython(text: string): { code: string; strings: Map<number, string | null> } {
  const out: string[] = [];
  const strings = new Map<number, string | null>();
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "#") {
      while (i < text.length && text[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (c !== '"' && c !== "'") {
      out.push(c);
      i++;
      continue;
    }
    // A prefix (`r`, `f`, `rb`, …) right before the quote decides escapes and f-strings.
    const prefix = /[A-Za-z]{1,2}$/.exec(text.slice(Math.max(0, i - 2), i))?.[0]?.toLowerCase() ?? "";
    const raw = prefix.includes("r");
    const quote = text.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
    const start = i;
    i += quote.length;
    let value = "";
    while (i < text.length && !text.startsWith(quote, i)) {
      if (quote.length === 1 && text[i] === "\n") break;
      if (text[i] === "\\" && i + 1 < text.length) {
        value += raw ? text.slice(i, i + 2) : text[i + 1];
        i += 2;
        continue;
      }
      value += text[i];
      i++;
    }
    const end = Math.min(text.length, i + (text.startsWith(quote, i) ? quote.length : 0));
    strings.set(start, prefix.includes("f") ? null : value);
    out.push(quote);
    for (let k = start + quote.length; k < end - quote.length; k++) out.push(text[k] === "\n" ? "\n" : " ");
    if (end - start >= 2 * quote.length) out.push(quote);
    i = end;
  }
  return { code: out.join(""), strings };
}

/** Index of the `)` / `]` closing the bracket at `open` in masked code, or the end of the code. */
function closing(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return code.length;
}

/** The top-level arguments of a call whose `(` is at `open`: positional ones, and keyword ones by name. */
function callArgs(
  code: string,
  open: number,
): { positional: Array<[number, number]>; named: Map<string, [number, number]> } {
  const end = closing(code, open);
  const positional: Array<[number, number]> = [];
  const named = new Map<string, [number, number]>();
  let depth = 0;
  let from = open + 1;
  const take = (to: number) => {
    let a = from;
    while (a < to && /\s/.test(code[a]!)) a++;
    if (a >= to) return;
    const kw = /^(\w+)\s*=(?!=)\s*/.exec(code.slice(a, to));
    if (kw) named.set(kw[1]!, [a + kw[0].length, to]);
    else positional.push([a, to]);
  };
  for (let i = open + 1; i < end; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      take(i);
      from = i + 1;
    }
  }
  take(end);
  return { positional, named };
}

/** The string literal an argument is, or null. */
function literal(code: string, strings: Map<number, string | null>, [a, b]: [number, number]): string | null {
  a += /^[rRbBuU]{0,2}(?=["'])/.exec(code.slice(a, b))?.[0].length ?? 0;
  const value = strings.get(a);
  if (value === undefined || value === null) return null;
  // Only the literal itself, not `"a" + x`.
  const quote = code[a] === code[a + 1] && code[a] === code[a + 2] ? 3 : 1;
  let end = a + quote;
  while (end < b && code[end] !== code[a]) end++;
  return code.slice(end + quote, b).trim() ? null : value;
}

/** String literals of a `[…]` / `(…)` / `{…}` argument, or of a single literal. */
function literals(code: string, strings: Map<number, string | null>, [a, b]: [number, number]): string[] {
  const single = literal(code, strings, [a, b]);
  if (single !== null) return [single];
  const out: string[] = [];
  for (const [at, value] of strings) if (at > a && at < b && value !== null) out.push(value);
  return out;
}

const expression = (code: string, [a, b]: [number, number]) => code.slice(a, b).trim();

function parseImports(code: string, module: string, isPackage: boolean): ParsedFile["imports"] {
  const imports: ParsedFile["imports"] = new Map();
  const pkg = isPackage ? module.split(".") : module.split(".").slice(0, -1);
  const absolute = (dots: string, name: string) => {
    if (!dots) return name;
    const base = pkg.slice(0, Math.max(0, pkg.length - (dots.length - 1)));
    return [...base, ...(name ? [name] : [])].join(".");
  };
  for (const m of code.matchAll(/^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n]*)/gm)) {
    const from = absolute(m[1]!, m[2]!);
    for (const part of m[3]!.replace(/[()\\]/g, " ").split(",")) {
      const [name, alias] = part.trim().split(/\s+as\s+/);
      if (name && /^\w+$/.test(name)) imports.set(alias?.trim() || name, { module: from, name });
    }
  }
  for (const m of code.matchAll(/^[ \t]*import[ \t]+([^\n]+)/gm)) {
    for (const part of m[1]!.split(",")) {
      const [name, alias] = part.trim().split(/\s+as\s+/);
      if (!name || !/^[\w.]+$/.test(name)) continue;
      // `import a.b` binds `a`; `import a.b as c` binds `c` to `a.b`.
      if (alias) imports.set(alias.trim(), { module: name, name: null });
      else imports.set(name.split(".")[0]!, { module: name.split(".")[0]!, name: null });
    }
  }
  return imports;
}

function parseFile(source: PythonSource): ParsedFile {
  const { code, strings } = maskPython(source.text);
  const module = moduleOf(source.rel);
  const file: ParsedFile = {
    source,
    module,
    imports: parseImports(code, module, /(^|\/)__init__\.py$/.test(source.rel)),
    objects: [],
    decorators: [],
    registrations: [],
    usesFastApi: /\bfastapi\b/.test(code),
  };
  const ctor = /^[ \t]*(\w+)[ \t]*(?::[^=\n]*)?=[ \t]*(?:\w+\.)?(Flask|FastAPI|Blueprint|APIRouter)[ \t]*\(/gm;
  for (const m of code.matchAll(ctor)) {
    const open = m.index + m[0].length - 1;
    const { named } = callArgs(code, open);
    const kind = m[2] as Kind;
    const arg = named.get(kind === "Blueprint" ? "url_prefix" : "prefix");
    file.objects.push({ module, name: m[1]!, kind, prefix: (arg && literal(code, strings, arg)) ?? "" });
  }
  const decorator = /^[ \t]*@[ \t]*([\w.]+)\.(\w+)[ \t]*\(/gm;
  for (const m of code.matchAll(decorator)) {
    const verb = m[2]!;
    if (verb !== "route" && verb !== "api_route" && !VERBS.has(verb)) continue;
    const open = m.index + m[0].length - 1;
    const { positional, named } = callArgs(code, open);
    const pathArg = positional[0] ?? named.get("rule") ?? named.get("path");
    const path = pathArg ? literal(code, strings, pathArg) : null;
    if (path === null) continue;
    const methodsArg = named.get("methods");
    const methods =
      verb === "route" || verb === "api_route" ? (methodsArg ? literals(code, strings, methodsArg) : null) : [verb];
    const handler = /^[\s\S]*?\b(?:async[ \t]+)?def[ \t]+(\w+)/.exec(code.slice(closing(code, open) + 1))?.[1] ?? "";
    file.decorators.push({
      receiver: m[1]!,
      verb,
      paths: [path],
      methods,
      handler,
      offset: m.index + m[0].indexOf("@"),
    });
  }
  file.registrations = parseRegistrations(file, code, strings);
  return file;
}

function parseRegistrations(file: ParsedFile, code: string, strings: Map<number, string | null>): Registration[] {
  const out: Registration[] = [];
  for (const m of code.matchAll(/([\w.]+)\.(register_blueprint|include_router)[ \t]*\(/g)) {
    const open = m.index + m[0].length - 1;
    const { positional, named } = callArgs(code, open);
    const child = positional[0] ?? named.get("blueprint") ?? named.get("router");
    if (!child) continue;
    const prefixArg = named.get(m[2] === "register_blueprint" ? "url_prefix" : "prefix");
    out.push({
      file,
      parent: m[1]!,
      child: expression(code, child),
      prefix: prefixArg ? literal(code, strings, prefixArg) : null,
    });
  }
  return out;
}

/** Joins a prefix and a rule the way Flask and FastAPI do: one `/` between them. */
function joinPath(prefix: string, rule: string): string {
  if (!prefix) return rule;
  if (!rule) return prefix;
  return `${prefix.replace(/\/+$/, "")}/${rule.replace(/^\/+/, "")}`;
}

/** Path parameters as `{name}`: Flask's `<int:id>` / `<id>`, FastAPI's `{path:path}`. */
export function normalizePath(path: string): string {
  const out = path.replace(/<(?:[^:<>]+:)?(\w+)>/g, "{$1}").replace(/\{(\w+):[^}]*\}/g, "{$1}");
  return out.startsWith("/") ? out : `/${out}`;
}

/** Every Flask and FastAPI route of `sources`. */
export function pythonRoutes(sources: readonly PythonSource[]): PythonRoute[] {
  const files = sources.map(parseFile);
  const registrations = files.flatMap((f) => f.registrations);
  const objects = files.flatMap((f) => f.objects);
  // A module imported as `app.routers.items` may live at `src/app/routers/items.py`: match on the dotted suffix.
  const sameModule = (actual: string, wanted: string) => actual === wanted || actual.endsWith(`.${wanted}`);
  const find = (module: string, name: string) => objects.find((o) => o.name === name && sameModule(o.module, module));

  /** The object a dotted name in `file` refers to: one of its own, or one it imports. */
  const resolve = (file: ParsedFile, dotted: string): WebObject | undefined => {
    const [head, ...rest] = dotted.split(".");
    if (!head) return undefined;
    if (!rest.length) {
      const own = file.objects.find((o) => o.name === head);
      if (own) return own;
    }
    const bound = file.imports.get(head);
    if (!bound) return undefined;
    const path = [...(bound.name ? [bound.name] : []), ...rest];
    const name = path.pop();
    if (!name) return undefined;
    // `from app.routers import items` then `items.router`: `items` may be a module or a name in `app.routers`.
    return find([bound.module, ...path].join("."), name) ?? (path.length ? undefined : find(bound.module, name));
  };

  const parentsOf = new Map<WebObject, Array<{ parent: WebObject; prefix: string | null }>>();
  for (const r of registrations) {
    const parent = resolve(r.file, r.parent);
    const child = resolve(r.file, r.child);
    if (!parent || !child || parent === child) continue;
    parentsOf.set(child, [...(parentsOf.get(child) ?? []), { parent, prefix: r.prefix }]);
  }

  /** Every full prefix of `o`: one per chain of registrations up to an app. */
  const prefixes = (o: WebObject, seen: Set<WebObject>): string[] => {
    if (o.kind === "Flask" || o.kind === "FastAPI") return [o.prefix];
    const parents = parentsOf.get(o)?.filter((p) => !seen.has(p.parent));
    if (!parents?.length) return [o.prefix];
    const next = new Set(seen).add(o);
    return parents.flatMap(({ parent, prefix }) =>
      prefixes(parent, next).map((up) =>
        // A blueprint's `url_prefix` given at registration replaces its own; a router's adds to it.
        o.kind === "Blueprint" ? joinPath(up, prefix ?? o.prefix) : joinPath(joinPath(up, prefix ?? ""), o.prefix),
      ),
    );
  };

  const routes: PythonRoute[] = [];
  for (const file of files) {
    const lines = lineStarts(file.source.text);
    for (const d of file.decorators) {
      const target = resolve(file, d.receiver);
      // A receiver we can't trace (an app imported from a module outside the project) still routes.
      const fastapi = target ? target.kind === "FastAPI" || target.kind === "APIRouter" : file.usesFastApi;
      if (!target && d.receiver.includes(".")) continue;
      if (!fastapi && VERBS.has(d.verb) && ["head", "options", "trace"].includes(d.verb)) continue;
      const methods = (d.methods ?? ["GET"]).map((m) => m.toUpperCase());
      const at = position(lines, d.offset);
      for (const prefix of target ? [...new Set(prefixes(target, new Set()))] : [""]) {
        for (const path of d.paths) {
          for (const method of methods) {
            routes.push({
              framework: fastapi ? "FastAPI" : "Flask",
              method,
              url: normalizePath(joinPath(prefix, path)),
              module: file.module,
              handler: d.handler,
              path: file.source.path,
              rel: file.source.rel,
              ...at,
            });
          }
        }
      }
    }
  }
  return routes;
}

function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}

function position(starts: number[], offset: number): { line: number; col: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, col: offset - starts[lo]! };
}
