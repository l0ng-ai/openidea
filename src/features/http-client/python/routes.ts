/**
 * Flask and FastAPI routes read from Python sources: route decorators on apps, blueprints
 * and routers, with the prefixes their `Blueprint(url_prefix=…)` / `APIRouter(prefix=…)` and
 * `register_blueprint(…)` / `include_router(…)` / `mount(…)` calls add, across modules. A text
 * scan, not a Python parser: string literals and comments are masked first so brackets and
 * keywords inside them don't count. A path or prefix may be a module constant or a settings
 * attribute (`settings.API_V1_STR`, a class attribute of the instance); a route whose path or
 * prefix is only known at runtime (an f-string, a computed value) is left out rather than shown
 * under a wrong URL.
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
/** A span of the masked code: an argument, a constant's value. */
type Span = [number, number];

/** A Flask / FastAPI app, blueprint or router assigned to a name. */
interface WebObject {
  file: PythonFile;
  name: string;
  kind: Kind;
  /** `url_prefix=` / `prefix=` of the constructor. */
  prefix: Span | null;
}

/**
 * `parent.register_blueprint(child, url_prefix=…)`, `parent.include_router(child, prefix=…)`,
 * `parent.mount(path, child)`.
 */
interface Registration {
  parent: string;
  child: string;
  prefix: Span | null;
  mount: boolean;
}

/** A route decorator, or `add_url_rule(…)`. */
interface Decorator {
  receiver: string;
  verb: string;
  path: Span;
  methods: Span | null;
  handler: string;
  offset: number;
}

/** A parsed Python source; `parsePython` makes one, `routesOf` reads many. */
export interface PythonFile {
  source: PythonSource;
  module: string;
  code: string;
  strings: Map<number, string | null>;
  /** Local name → imported module and name (`null`: the module itself). */
  imports: Map<string, { module: string; name: string | null }>;
  objects: WebObject[];
  decorators: Decorator[];
  registrations: Registration[];
  /** Module-level `NAME = value`. */
  constants: Map<string, Span>;
  /** Module-level `name = Cls(…)`: the class expression. */
  instances: Map<string, string>;
  /** Class name → its attributes (`API_V1_STR: str = "/api/v1"`). */
  classes: Map<string, Map<string, Span>>;
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

const expression = (code: string, [a, b]: [number, number]) => code.slice(a, b).trim();

function parseImports(code: string, module: string, isPackage: boolean): PythonFile["imports"] {
  const imports: PythonFile["imports"] = new Map();
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

/** End of the statement starting at `from`: the next newline outside brackets. */
function statementEnd(code: string, from: number): number {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "\n" && depth <= 0 && code[i - 1] !== "\\") return i;
  }
  return code.length;
}

/** Module-level assignments, and the attributes assigned in the body of each top-level class. */
function parseAssignments(file: PythonFile) {
  const { code } = file;
  const assignment = /^([ \t]*)(\w+)[ \t]*(?::[^=\n]*)?=(?!=)[ \t]*/my;
  let cls: { name: string; attrs: Map<string, Span>; indent: string | null } | null = null;
  for (const line of code.matchAll(/^(?=[ \t]*\S)/gm)) {
    const at = line.index;
    const text = code.slice(at, code.indexOf("\n", at) < 0 ? code.length : code.indexOf("\n", at));
    if (!/^[ \t]/.test(text)) {
      const c = /^class[ \t]+(\w+)/.exec(text);
      cls = c ? { name: c[1]!, attrs: new Map(), indent: null } : null;
      if (cls) file.classes.set(cls.name, cls.attrs);
    } else if (cls && cls.indent === null) cls.indent = /^[ \t]+/.exec(text)![0];
    assignment.lastIndex = at;
    const m = assignment.exec(code);
    if (!m) continue;
    const span: Span = [at + m[0].length, statementEnd(code, at + m[0].length)];
    if (!m[1]) {
      file.constants.set(m[2]!, span);
      const instance = /^([\w.]+)[ \t]*\(/.exec(code.slice(span[0], span[1]));
      if (instance) file.instances.set(m[2]!, instance[1]!);
    } else if (cls && m[1] === cls.indent) cls.attrs.set(m[2]!, span);
  }
}

/** Parses one source for `routesOf`. */
export function parsePython(source: PythonSource): PythonFile {
  const { code, strings } = maskPython(source.text);
  const module = moduleOf(source.rel);
  const file: PythonFile = {
    source,
    module,
    code,
    strings,
    imports: parseImports(code, module, /(^|\/)__init__\.py$/.test(source.rel)),
    objects: [],
    decorators: [],
    registrations: [],
    constants: new Map(),
    instances: new Map(),
    classes: new Map(),
  };
  parseAssignments(file);
  const ctor = /^[ \t]*(\w+)[ \t]*(?::[^=\n]*)?=[ \t]*(?:\w+\.)?(Flask|FastAPI|Blueprint|APIRouter)[ \t]*\(/gm;
  for (const m of code.matchAll(ctor)) {
    const { named } = callArgs(code, m.index + m[0].length - 1);
    const kind = m[2] as Kind;
    file.objects.push({
      file,
      name: m[1]!,
      kind,
      prefix: named.get(kind === "Blueprint" ? "url_prefix" : "prefix") ?? null,
    });
  }
  const decorator = /^[ \t]*@[ \t]*([\w.]+)\.(\w+)[ \t]*\(/gm;
  for (const m of code.matchAll(decorator)) {
    const verb = m[2]!;
    if (verb !== "route" && verb !== "api_route" && !VERBS.has(verb)) continue;
    const open = m.index + m[0].length - 1;
    const { positional, named } = callArgs(code, open);
    const path = positional[0] ?? named.get("rule") ?? named.get("path");
    if (!path) continue;
    const handler = /^[\s\S]*?\b(?:async[ \t]+)?def[ \t]+(\w+)/.exec(code.slice(closing(code, open) + 1))?.[1] ?? "";
    file.decorators.push({
      receiver: m[1]!,
      verb,
      path,
      methods: named.get("methods") ?? null,
      handler,
      offset: m.index + m[0].indexOf("@"),
    });
  }
  // `app.add_url_rule("/", view_func=index)`: Flask's route without a decorator.
  for (const m of code.matchAll(/([\w.]+)\.add_url_rule[ \t]*\(/g)) {
    const { positional, named } = callArgs(code, m.index + m[0].length - 1);
    const path = positional[0] ?? named.get("rule");
    const view = named.get("view_func") ?? positional[2];
    if (!path) continue;
    const handler = view
      ? (/^([\w.]+)/
          .exec(expression(code, view))?.[1]
          ?.replace(/\.as_view$/, "")
          .split(".")
          .pop() ?? "")
      : "";
    file.decorators.push({
      receiver: m[1]!,
      verb: "route",
      path,
      methods: named.get("methods") ?? null,
      handler,
      offset: m.index,
    });
  }
  for (const m of code.matchAll(/([\w.]+)\.(register_blueprint|include_router|mount)[ \t]*\(/g)) {
    const { positional, named } = callArgs(code, m.index + m[0].length - 1);
    const mount = m[2] === "mount";
    const child = mount
      ? (positional[1] ?? named.get("app"))
      : (positional[0] ?? named.get("blueprint") ?? named.get("router"));
    if (!child) continue;
    const prefix = mount
      ? (positional[0] ?? named.get("path") ?? null)
      : (named.get(m[2] === "register_blueprint" ? "url_prefix" : "prefix") ?? null);
    file.registrations.push({ parent: m[1]!, child: expression(code, child), prefix, mount });
  }
  return file;
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
  return routesOf(sources.map(parsePython));
}

/**
 * Modules that a prefix, path or method list names a value from (`settings.API_V1_STR` after
 * `from app.core.config import settings`) and that `files` lacks: a settings module imports
 * neither framework, so the scan doesn't return it.
 */
export function missingModules(files: readonly PythonFile[]): Array<{ file: PythonFile; module: string }> {
  const known = (module: string) => files.some((f) => f.module === module || f.module.endsWith(`.${module}`));
  const out: Array<{ file: PythonFile; module: string }> = [];
  for (const file of files) {
    const spans = [
      ...file.objects.map((o) => o.prefix),
      ...file.registrations.map((r) => r.prefix),
      ...file.decorators.flatMap((d) => [d.path, d.methods]),
    ];
    for (const span of spans) {
      const head = span && /^(\w+)(?:\.\w+)?$/.exec(expression(file.code, span))?.[1];
      const bound = head ? file.imports.get(head) : undefined;
      if (!bound) continue;
      // `from a import b`: `b` is a name in module `a`, or the module `a.b`.
      const candidates = bound.name ? [bound.module, `${bound.module}.${bound.name}`] : [bound.module];
      if (candidates.some(known)) continue;
      for (const module of candidates) if (!out.some((m) => m.module === module)) out.push({ file, module });
    }
  }
  return out;
}

/** Depth of constant lookups through other names and modules. */
const MAX_HOPS = 6;

/** Every Flask and FastAPI route of the parsed `files`. */
export function routesOf(files: readonly PythonFile[]): PythonRoute[] {
  const objects = files.flatMap((f) => f.objects);
  // A module imported as `app.routers.items` may live at `src/app/routers/items.py`: match on the dotted suffix.
  const sameModule = (actual: string, wanted: string) => actual === wanted || actual.endsWith(`.${wanted}`);
  const fileOf = (module: string) => files.find((f) => sameModule(f.module, module));
  const find = (module: string, name: string) =>
    objects.find((o) => o.name === name && sameModule(o.file.module, module));

  /** The object a dotted name in `file` refers to: one of its own, or one it imports. */
  const resolve = (file: PythonFile, dotted: string): WebObject | undefined => {
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

  /** The strings a span evaluates to: a literal, a list or tuple of them, or a name for one; null when unknown. */
  const valueOf = (file: PythonFile, span: Span, hops = 0): string[] | null => {
    const { code, strings } = file;
    const single = literal(code, strings, span);
    if (single !== null) return [single];
    const text = expression(code, span);
    if (/^[[(][\s\S]*[\])]$/.test(text)) {
      const open = code.indexOf(text[0]!, span[0]);
      const items = callArgs(code, open).positional.map((item) => valueOf(file, item, hops));
      return items.every((v) => v !== null) ? items.flat() : null;
    }
    return /^[\w.]+$/.test(text) && hops < MAX_HOPS ? named(file, text, hops + 1) : null;
  };

  /** The value of `NAME`, `module.NAME` or `instance.ATTR` as seen from `file`. */
  const named = (file: PythonFile, dotted: string, hops: number): string[] | null => {
    const [head, attr, ...more] = dotted.split(".");
    if (!head || more.length) return null;
    if (!attr) {
      const own = file.constants.get(head);
      if (own) return valueOf(file, own, hops);
      const bound = file.imports.get(head);
      const from = bound?.name ? fileOf(bound.module) : undefined;
      return from && bound?.name ? named(from, bound.name, hops + 1) : null;
    }
    if (file.instances.has(head)) return classAttr(file, file.instances.get(head)!, attr, hops);
    const bound = file.imports.get(head);
    if (!bound) return null;
    if (!bound.name) {
      const module = fileOf(bound.module);
      return module ? named(module, attr, hops + 1) : null;
    }
    // `from app.core.config import settings` then `settings.X`; or `from app import config` then `config.X`.
    const owner = fileOf(bound.module);
    if (owner?.instances.has(bound.name)) return classAttr(owner, owner.instances.get(bound.name)!, attr, hops);
    const module = fileOf(`${bound.module}.${bound.name}`);
    return module ? named(module, attr, hops + 1) : null;
  };

  /** An attribute of the class `cls` (named in `file`): `Settings().API_V1_STR`. */
  const classAttr = (file: PythonFile, cls: string, attr: string, hops: number): string[] | null => {
    const [head, name, ...more] = cls.split(".");
    if (!head || more.length) return null;
    let owner: PythonFile | undefined = file;
    let className = head;
    if (name) {
      owner = file.imports.get(head)?.name ? undefined : fileOf(file.imports.get(head)?.module ?? "");
      className = name;
    } else if (!file.classes.has(head)) {
      const bound = file.imports.get(head);
      owner = bound?.name ? fileOf(bound.module) : undefined;
      className = bound?.name ?? head;
    }
    const span = owner?.classes.get(className)?.get(attr);
    return owner && span ? valueOf(owner, span, hops + 1) : null;
  };

  /** One value of a prefix, `""` when none was given, null when it can't be known here. */
  const prefixOf = (file: PythonFile, span: Span | null): string | null => {
    if (!span) return "";
    const values = valueOf(file, span);
    return values?.length === 1 ? values[0]! : null;
  };

  const parentsOf = new Map<WebObject, Array<{ parent: WebObject; prefix: string | null; given: boolean }>>();
  for (const file of files) {
    for (const r of file.registrations) {
      const parent = resolve(file, r.parent);
      const child = resolve(file, r.child);
      if (!parent || !child || parent === child) continue;
      // Only FastAPI apps mount sub-applications; blueprints and routers register.
      if (r.mount !== (child.kind === "FastAPI" && parent.kind === "FastAPI")) continue;
      const entry = { parent, prefix: prefixOf(file, r.prefix), given: r.prefix !== null };
      parentsOf.set(child, [...(parentsOf.get(child) ?? []), entry]);
    }
  }

  /** Every full prefix of `o`, one per chain of registrations up to an app; null where one is unknown. */
  const prefixes = (o: WebObject, seen: Set<WebObject>): Array<string | null> => {
    const own = o.kind === "Flask" || o.kind === "FastAPI" ? "" : prefixOf(o.file, o.prefix);
    const parents = parentsOf.get(o)?.filter((p) => !seen.has(p.parent));
    if (!parents?.length) return [own];
    const next = new Set(seen).add(o);
    return parents.flatMap(({ parent, prefix, given }) =>
      prefixes(parent, next).map((up) => {
        // A blueprint's `url_prefix` given at registration replaces its own; a router's adds to it.
        const added =
          o.kind === "Blueprint"
            ? given
              ? prefix
              : own
            : prefix === null || own === null
              ? null
              : joinPath(prefix, own);
        return up === null || added === null ? null : joinPath(up, added);
      }),
    );
  };

  const routes: PythonRoute[] = [];
  for (const file of files) {
    const lines = lineStarts(file.source.text);
    for (const d of file.decorators) {
      // Only receivers known to be an app, blueprint or router: `@mock.patch("…")` is not a route.
      const target = resolve(file, d.receiver);
      if (!target) continue;
      const fastapi = target.kind === "FastAPI" || target.kind === "APIRouter";
      if (!fastapi && ["head", "options", "trace"].includes(d.verb)) continue;
      const paths = valueOf(file, d.path);
      const methods = d.methods ? valueOf(file, d.methods) : VERBS.has(d.verb) ? [d.verb] : ["GET"];
      if (!paths?.length || !methods?.length) continue;
      const at = position(lines, d.offset);
      for (const prefix of new Set(prefixes(target, new Set()))) {
        if (prefix === null) continue;
        for (const path of paths) {
          for (const method of methods) {
            routes.push({
              framework: fastapi ? "FastAPI" : "Flask",
              method: method.toUpperCase(),
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
