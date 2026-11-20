/**
 * Spring Web request mappings of a Java / Kotlin source: `@RequestMapping` /
 * `@GetMapping`… methods of `@RestController` / `@Controller` classes, with
 * the class-level mapping applied. Constants are resolved within the file, and
 * through an {@link ExternalConstant} in other classes (`constants.ts`).
 */
import {
  allClasses,
  parseSource,
  type Annotation,
  type ClassDecl,
  type Expr,
  type Param,
  type SourceFile,
} from "./source";

export interface QueryParam {
  name: string;
  /** `defaultValue`, if any. */
  value: string | null;
}

export interface Endpoint {
  className: string;
  methodName: string;
  /** Offset of the method name (gutter line). */
  offset: number;
  /** The method declaration, annotations included. */
  range: { from: number; to: number };
  /** Offset of the controller class name. */
  classOffset: number;
  httpMethod: string;
  /** Class × method paths (`/` joined, `{var}` kept), first one first. */
  paths: string[];
  query: QueryParam[];
  headers: { name: string; value: string }[];
  /** `consumes` (first). */
  consumes: string | null;
  /** `produces` (first). */
  produces: string | null;
  /** `@RequestBody` parameter type as written, if any. */
  bodyType: string | null;
}

export interface Controller {
  name: string;
  offset: number;
  /** The class declaration, annotations included. */
  range: { from: number; to: number };
  endpoints: Endpoint[];
}

const SHORTCUTS: Record<string, string> = {
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  DeleteMapping: "DELETE",
  PatchMapping: "PATCH",
};

const CONTROLLER = new Set(["RestController", "Controller"]);

const MEDIA_TYPES: Record<string, string> = {
  ALL: "*/*",
  APPLICATION_JSON: "application/json",
  APPLICATION_JSON_UTF8: "application/json;charset=UTF-8",
  APPLICATION_XML: "application/xml",
  APPLICATION_ATOM_XML: "application/atom+xml",
  APPLICATION_FORM_URLENCODED: "application/x-www-form-urlencoded",
  APPLICATION_OCTET_STREAM: "application/octet-stream",
  APPLICATION_PDF: "application/pdf",
  APPLICATION_PROBLEM_JSON: "application/problem+json",
  APPLICATION_PROBLEM_XML: "application/problem+xml",
  APPLICATION_NDJSON: "application/x-ndjson",
  APPLICATION_STREAM_JSON: "application/stream+json",
  APPLICATION_CBOR: "application/cbor",
  APPLICATION_GRAPHQL_RESPONSE: "application/graphql-response+json",
  IMAGE_GIF: "image/gif",
  IMAGE_JPEG: "image/jpeg",
  IMAGE_PNG: "image/png",
  MULTIPART_FORM_DATA: "multipart/form-data",
  MULTIPART_MIXED: "multipart/mixed",
  TEXT_EVENT_STREAM: "text/event-stream",
  TEXT_HTML: "text/html",
  TEXT_MARKDOWN: "text/markdown",
  TEXT_PLAIN: "text/plain",
  TEXT_XML: "text/xml",
};

/** The value of constant `name` of another class (`qualifier`, or an inherited / statically imported one when absent). */
export type ExternalConstant = (qualifier: string | undefined, name: string) => string | null;

/** Evaluates string-valued annotation arguments within one file. */
export class Constants {
  private readonly fields = new Map<string, Expr>();
  private readonly classes: Set<string>;
  constructor(
    file: SourceFile,
    private readonly external?: ExternalConstant,
  ) {
    const classes = allClasses(file);
    for (const f of [...file.fields, ...classes.flatMap((c) => c.fields)])
      if (f.init && !this.fields.has(f.name)) this.fields.set(f.name, f.init);
    this.classes = new Set(classes.map((c) => c.name));
  }

  /** The value of this file's constant `name`. */
  named(name: string): string | null {
    const init = this.fields.get(name);
    return init ? this.value(init, false, new Set([name])) : null;
  }

  /** Every element of an array (`{a, b}`, `[a, b]`, `arrayOf(a, b)`) or the single value; unresolvable ones dropped. */
  strings(expr: Expr | undefined, enums = false): string[] {
    if (!expr?.length) return [];
    const first = expr[0]!;
    let inner: Expr | null = null;
    if (first.kind === "p" && (first.text === "{" || first.text === "[")) inner = expr.slice(1, -1);
    else if (first.kind === "id" && /^(arrayOf|listOf|setOf)$/.test(first.text) && expr[1]?.text === "(")
      inner = expr.slice(2, -1);
    if (!inner) {
      const v = this.value(expr, enums, new Set());
      return v === null ? [] : [v];
    }
    return splitTop(inner)
      .map((e) => this.value(e, enums, new Set()))
      .filter((v): v is string => v !== null);
  }

  string(expr: Expr | undefined, enums = false): string | null {
    return this.strings(expr, enums)[0] ?? null;
  }

  private value(expr: Expr, enums: boolean, seen: Set<string>): string | null {
    let out = "";
    for (const part of splitPlus(expr)) {
      const v = this.part(part, enums, seen);
      if (v === null) return null;
      out += v;
    }
    return out;
  }

  private part(part: Expr, enums: boolean, seen: Set<string>): string | null {
    // Kotlin templates of constants; other `${…}` are property placeholders, kept.
    if (part.length === 1 && part[0]!.kind === "str")
      return (part[0]!.value ?? "").replace(
        /\$\{(\w+)\}|\$([A-Za-z_]\w*)/g,
        (m, a: string | undefined, b: string | undefined) => {
          const name = (a ?? b)!;
          const init = seen.has(name) ? undefined : this.fields.get(name);
          if (init) return this.value(init, false, new Set([...seen, name])) ?? m;
          return seen.has(name) ? m : (this.external?.(undefined, name) ?? m);
        },
      );
    if (part.length === 1 && part[0]!.kind === "num") return part[0]!.text;
    if (part[0]?.text === "(" && part[part.length - 1]?.text === ")") return this.value(part.slice(1, -1), enums, seen);
    // `NAME`, `Paths.NAME`, `MediaType.APPLICATION_JSON_VALUE`, `RequestMethod.GET`.
    if (!part.every((t, i) => (i % 2 ? t.kind === "p" && t.text === "." : t.kind === "id"))) return null;
    const names = part.filter((t) => t.kind === "id").map((t) => t.text);
    const last = names[names.length - 1]!;
    const qualifier = names[names.length - 2];
    if (qualifier === "MediaType") return MEDIA_TYPES[last.replace(/_VALUE$/, "")] ?? null;
    // `Other.NAME` of a class declared elsewhere.
    if (qualifier && !this.classes.has(qualifier)) {
      const v = this.external?.(qualifier, last);
      if (v != null) return v;
    }
    const init = this.fields.get(last);
    if (init && !seen.has(last)) {
      seen.add(last);
      return this.value(init, enums, seen);
    }
    if (!qualifier && !enums) {
      const v = this.external?.(undefined, last);
      if (v != null) return v;
    }
    return enums ? last : null;
  }
}

function splitTop(expr: Expr): Expr[] {
  const parts: Expr[] = [];
  let cur: Expr = [];
  let depth = 0;
  for (const t of expr) {
    if (t.kind === "p" && "([{".includes(t.text)) depth++;
    if (t.kind === "p" && ")]}".includes(t.text)) depth--;
    if (depth === 0 && t.kind === "p" && t.text === ",") {
      parts.push(cur);
      cur = [];
    } else cur.push(t);
  }
  if (cur.length) parts.push(cur);
  return parts;
}

function splitPlus(expr: Expr): Expr[] {
  const parts: Expr[] = [];
  let cur: Expr = [];
  let depth = 0;
  for (const t of expr) {
    if (t.kind === "p" && "([{".includes(t.text)) depth++;
    if (t.kind === "p" && ")]}".includes(t.text)) depth--;
    if (depth === 0 && t.kind === "p" && t.text === "+") {
      parts.push(cur);
      cur = [];
    } else cur.push(t);
  }
  parts.push(cur);
  return parts;
}

function mapping(annotations: Annotation[]): { ann: Annotation; method: string | null } | null {
  for (const ann of annotations) {
    if (SHORTCUTS[ann.name]) return { ann, method: SHORTCUTS[ann.name]! };
    if (ann.name === "RequestMapping") return { ann, method: null };
  }
  return null;
}

function mappingPaths(ann: Annotation | undefined, c: Constants): string[] {
  if (!ann) return [];
  return c.strings(ann.args.get("path") ?? ann.args.get("value"));
}

export function joinPaths(base: string, path: string): string {
  const joined = `/${base}/${path}`.replace(/\/{2,}/g, "/");
  return joined.length > 1 ? joined.replace(/\/$/, "") : "/";
}

function annotation(p: Param, name: string): Annotation | undefined {
  return p.annotations.find((a) => a.name === name);
}

/** Map-typed `@RequestParam` / `@RequestHeader` collect all of them: nothing to generate. */
const isMap = (type: string) =>
  /^(java\.util\.)?(Map|MultiValueMap|HttpHeaders|LinkedMultiValueMap|HashMap)\b/.test(type);

/** `name=value` of a `params`/`headers` condition. Only the first "=" divides it: `Accept=text/plain;charset=UTF-8`. */
function condition(cond: string): [name: string, value: string | undefined] {
  const at = cond.indexOf("=");
  return at < 0 ? [cond, undefined] : [cond.slice(0, at), cond.slice(at + 1)];
}

function endpoint(cls: ClassDecl, method: ClassDecl["methods"][number], c: Constants): Endpoint | null {
  const m = mapping(method.annotations);
  if (!m) return null;
  const classMapping = cls.annotations.find((a) => a.name === "RequestMapping");
  const httpMethod =
    m.method ??
    c.string(m.ann.args.get("method"), true) ??
    (classMapping && c.string(classMapping.args.get("method"), true)) ??
    "GET";
  const bases = mappingPaths(classMapping, c);
  const own = mappingPaths(m.ann, c);
  const paths: string[] = [];
  for (const b of bases.length ? bases : [""]) for (const p of own.length ? own : [""]) paths.push(joinPaths(b, p));

  const query: QueryParam[] = [];
  const headers: { name: string; value: string }[] = [];
  let bodyType: string | null = null;
  for (const p of method.params) {
    const rp = annotation(p, "RequestParam");
    const rh = annotation(p, "RequestHeader");
    if (rp && !isMap(p.type)) {
      const name = c.string(rp.args.get("value")) || c.string(rp.args.get("name")) || p.name;
      query.push({ name, value: c.string(rp.args.get("defaultValue")) });
    } else if (rh && !isMap(p.type)) {
      const name = c.string(rh.args.get("value")) || c.string(rh.args.get("name")) || p.name;
      headers.push({ name, value: c.string(rh.args.get("defaultValue")) ?? `{{${name}}}` });
    } else if (annotation(p, "RequestBody")) bodyType = p.type || "Object";
  }
  // `params = "a=1"` / `headers = "X-Api=1"` narrow the mapping: the request must carry them.
  for (const cond of [...c.strings(classMapping?.args.get("params")), ...c.strings(m.ann.args.get("params"))]) {
    const [name, value] = condition(cond);
    if (name && !cond.includes("!") && !query.some((q) => q.name === name.trim()))
      query.push({ name: name.trim(), value: value?.trim() ?? null });
  }
  for (const cond of [...c.strings(classMapping?.args.get("headers")), ...c.strings(m.ann.args.get("headers"))]) {
    const [name, value] = condition(cond);
    if (name && !cond.includes("!") && value !== undefined) headers.push({ name: name.trim(), value: value.trim() });
  }
  const first = (key: string) =>
    c.string(m.ann.args.get(key)) ?? (classMapping && c.string(classMapping.args.get(key))) ?? null;
  return {
    className: cls.name,
    methodName: method.name,
    offset: method.nameStart,
    range: { from: method.start, to: method.end },
    classOffset: cls.nameStart,
    httpMethod: httpMethod.toUpperCase(),
    paths,
    query,
    headers,
    consumes: first("consumes"),
    produces: first("produces"),
    bodyType,
  };
}

export function controllersOf(file: SourceFile, external?: ExternalConstant): Controller[] {
  const constants = new Constants(file, external);
  const out: Controller[] = [];
  for (const cls of allClasses(file)) {
    if (!cls.annotations.some((a) => CONTROLLER.has(a.name))) continue;
    const endpoints = cls.methods.map((m) => endpoint(cls, m, constants)).filter((e): e is Endpoint => !!e);
    out.push({ name: cls.name, offset: cls.nameStart, range: { from: cls.start, to: cls.end }, endpoints });
  }
  return out;
}

/** Controllers of a Java / Kotlin source, with their endpoints. */
export function springControllers(text: string, external?: (file: SourceFile) => ExternalConstant): Controller[] {
  // Cheap guard: most files are not controllers.
  if (!/@(?:[\w.]+\.)?(?:Rest)?Controller\b/.test(text)) return [];
  const file = parseSource(text);
  return controllersOf(file, external?.(file));
}

/** The controller and endpoint whose declaration holds `offset`. */
export function springAt(
  controllers: Controller[],
  offset: number,
): { controller: Controller | null; endpoint: Endpoint | null } {
  // Innermost controller (nested classes come after their outer one).
  const controller = controllers.filter((c) => c.range.from <= offset && offset <= c.range.to).pop() ?? null;
  const endpoint = controller?.endpoints.find((e) => e.range.from <= offset && offset <= e.range.to) ?? null;
  return { controller, endpoint };
}
