/** Source-only Feign relationships. Request generation's default GET is not a
 * server constraint: unconstrained controller mappings accept every method. */
import { joinPaths } from "./endpoints";
import { allClasses, parseSource, type Annotation, type Expr, type SourceFile, type Tok } from "./source";

const WEB = "org.springframework.web.bind.annotation";
const FEIGN = "org.springframework.cloud.openfeign.FeignClient";
const VERBS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"]);
const SHORTCUTS: Record<string, string> = {
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  PatchMapping: "PATCH",
  DeleteMapping: "DELETE",
};
export const MAX_NAVIGATION_SOURCE = 128 * 1024;

export interface HttpShape {
  paths: string[];
  methods: string[];
}
export interface FeignMethod extends HttpShape {
  name: string;
  from: number;
  to: number;
  nameFrom: number;
  /** Literal URL spans, excluding quotes, for modifier-click navigation. */
  links: { from: number; to: number }[];
  service: string | null;
}
export interface ControllerMethod extends HttpShape {
  name: string;
  from: number;
  to: number;
}

function owned(a: Annotation, file: SourceFile, qualified: string): boolean {
  if (a.duplicateArgs) return false;
  if (a.qualifiedName) return a.qualifiedName === qualified;
  if (a.name !== qualified.slice(qualified.lastIndexOf(".") + 1)) return false;
  if (allClasses(file).some((c) => c.name === a.name)) return false;
  const explicit = file.imports.filter((i) => i.endsWith(`.${a.name}`));
  if (explicit.length) return explicit.every((i) => i === qualified);
  return file.imports.includes(`${qualified.slice(0, qualified.lastIndexOf("."))}.*`);
}

function literal(t: Tok | undefined): string | null {
  return t?.kind === "str" && /^"[^"\\\r\n]*"$/.test(t.text) && !t.value?.includes("$") ? (t.value ?? "") : null;
}

function strings(expr: Expr | undefined): { values: string[]; links: { from: number; to: number }[] } | null {
  if (!expr) return { values: [""], links: [] };
  let tokens = expr;
  if (
    (tokens[0]?.text === "{" && tokens.at(-1)?.text === "}") ||
    (tokens[0]?.text === "[" && tokens.at(-1)?.text === "]")
  )
    tokens = tokens.slice(1, -1);
  else if (tokens[0]?.text === "arrayOf" && tokens[1]?.text === "(" && tokens.at(-1)?.text === ")")
    tokens = tokens.slice(2, -1);
  const values: string[] = [];
  const links: { from: number; to: number }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (i % 2) {
      if (t.kind !== "p" || t.text !== ",") return null;
      continue;
    }
    const value = literal(t);
    if (value === null || values.length === 64) return null;
    values.push(value);
    if (t.end > t.start + 2) links.push({ from: t.start + 1, to: t.end - 1 });
  }
  return values.length ? { values, links } : { values: [""], links: [] };
}

function single(a: Annotation, key: string): string | null {
  const expr = a.args.get(key);
  return expr === undefined ? "" : expr.length === 1 ? literal(expr[0]) : null;
}

function service(a: Annotation): string | null {
  if (single(a, "url") !== "") return null;
  const name = single(a, "name"),
    value = single(a, "value");
  if (name === null || value === null || (name && value && name !== value)) return null;
  const selected = name || value;
  return /^[\w.-]{1,255}$/.test(selected) ? selected : null;
}

function mapping(annotations: Annotation[], file: SourceFile) {
  const found = annotations.filter(
    (a) => (a.name === "RequestMapping" || a.name in SHORTCUTS) && owned(a, file, `${WEB}.${a.name}`),
  );
  return found.length === 1 ? found[0]! : null;
}

function paths(a: Annotation | null) {
  if (!a) return strings(undefined);
  const value = strings(a.args.get("value")),
    path = strings(a.args.get("path"));
  if (!value || !path) return null;
  if (a.args.has("value") && a.args.has("path") && JSON.stringify(value.values) !== JSON.stringify(path.values))
    return null;
  return a.args.has("path") ? path : value;
}

function methods(a: Annotation | null, file: SourceFile): string[] | null {
  if (!a) return ["*"];
  if (SHORTCUTS[a.name]) return [SHORTCUTS[a.name]!];
  const expr = a.args.get("method");
  if (!expr) return ["*"];
  const written = expr
    .map((t) => t.text)
    .join("")
    .replace(/^(?:\{|\[)|(?:\}|\])$/g, "");
  if (!written) return ["*"];
  const names = written
    .split(",")
    .filter(Boolean)
    .map((name) => {
      const verb = name.split(".").at(-1)!;
      if (!VERBS.has(verb)) return null;
      if (name === `${WEB}.RequestMethod.${verb}`) return verb;
      if (
        name === `RequestMethod.${verb}` &&
        (file.imports.includes(`${WEB}.RequestMethod`) || file.imports.includes(`${WEB}.*`))
      )
        return verb;
      return name === verb &&
        (file.imports.includes(`${WEB}.RequestMethod.${verb}`) || file.imports.includes(`${WEB}.RequestMethod.*`))
        ? verb
        : null;
    });
  return names.every((n): n is string => n !== null) ? names : null;
}

function combine(base: string[], own: string[]): string[] {
  return base.flatMap((b) => own.map((p) => joinPaths(b, p))).slice(0, 256);
}

export function feignMethods(text: string): FeignMethod[] {
  if (text.length > MAX_NAVIGATION_SOURCE || !text.includes("FeignClient")) return [];
  const file = parseSource(text);
  const result: FeignMethod[] = [];
  for (const cls of allClasses(file)) {
    const feign = cls.annotations.find((a) => owned(a, file, FEIGN));
    if (!feign || cls.kind !== "interface") continue;
    const prefix = single(feign, "path");
    if (prefix === null) continue;
    for (const method of cls.methods) {
      if (method.hasBody) continue;
      const annotation = mapping(method.annotations, file);
      if (!annotation) continue;
      const urls = paths(annotation),
        verbs = methods(annotation, file);
      if (!urls || !verbs) continue;
      result.push({
        name: `${cls.name}.${method.name}`,
        from: method.start,
        to: method.end,
        nameFrom: method.nameStart,
        paths: combine([prefix], urls.values),
        methods: verbs.map((v) => (v === "*" ? "GET" : v)),
        links: urls.links,
        service: service(feign),
      });
    }
  }
  return result;
}

export function controllerMethods(text: string, file?: SourceFile): ControllerMethod[] {
  if (text.length > MAX_NAVIGATION_SOURCE || !text.includes("Controller")) return [];
  file ??= parseSource(text);
  const result: ControllerMethod[] = [];
  for (const cls of allClasses(file)) {
    if (
      !cls.annotations.some(
        (a) =>
          ["Controller", "RestController"].includes(a.name) &&
          owned(
            a,
            file,
            a.name === "Controller" ? "org.springframework.stereotype.Controller" : `${WEB}.RestController`,
          ),
      )
    )
      continue;
    const classMapping = mapping(cls.annotations, file);
    if (!classMapping && cls.annotations.some((a) => a.name === "RequestMapping")) continue;
    const base = paths(classMapping),
      classMethods = methods(classMapping, file);
    if (!base || !classMethods) continue;
    for (const method of cls.methods) {
      const annotation = mapping(method.annotations, file);
      if (!annotation) continue;
      const own = paths(annotation),
        verbs = methods(annotation, file);
      if (!own || !verbs) continue;
      result.push({
        name: `${cls.name}.${method.name}`,
        from: method.nameStart,
        to: method.nameStart + method.name.length,
        paths: combine(base.values, own.values),
        methods: verbs.includes("*")
          ? classMethods
          : classMethods.includes("*")
            ? verbs
            : [...new Set([...classMethods, ...verbs])],
      });
    }
  }
  return result;
}

/** Literal segments or whole `{variable}` segments; Ant/regex paths remain unresolved. */
export function sameHttpPath(a: string, b: string): boolean {
  const segments = (s: string) => s.split("/").filter(Boolean);
  const x = segments(a),
    y = segments(b);
  const variable = (s: string) => /^\{[\w.-]+\}$/.test(s);
  const supported = (s: string) => variable(s) || !/[{}*$?]/.test(s);
  return (
    x.length === y.length &&
    [...x, ...y].every(supported) &&
    x.every((s, i) => s === y[i] || variable(s) || variable(y[i]!))
  );
}

export function callsEndpoint(client: HttpShape, server: HttpShape): boolean {
  return (
    client.methods.some(
      (m) =>
        server.methods.includes("*") || server.methods.includes(m) || (m === "HEAD" && server.methods.includes("GET")),
    ) && client.paths.some((p) => server.paths.some((s) => sameHttpPath(p, s)))
  );
}
