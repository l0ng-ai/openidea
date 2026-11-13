/**
 * Live template model (IDEA syntax) and expansion to CodeMirror snippets.
 *
 * Body syntax: `$NAME$` variables (repeated occurrences are linked), `$END$`
 * (final caret), `$SELECTION$` (the text being surrounded), `$$` (a literal
 * dollar). Leading tabs in body lines are indent units relative to the line
 * the template is expanded on.
 *
 * Variables may carry an expression: string literals, references to other
 * variables and calls such as `className()`, `capitalize(fileNameWithoutExtension())`,
 * `date("yyyy-MM-dd")`, `suggestVariableName()` or `complete()`.
 */

export interface TemplateVariable {
  name: string;
  expression?: string;
  /** Used when the expression is empty or yields nothing. */
  defaultValue?: string;
  /** Don't stop at the variable when the expression produced a value. */
  skipIfDefined?: boolean;
}

export interface LiveTemplate {
  /** Read-only contribution, withdrawn with its plugin. */
  pluginOrigin?: string;
  id: string;
  /** Settings grouping, e.g. "Rust", "Surround". */
  group: string;
  abbrev: string;
  description: string;
  body: string;
  /** Language ids (`rust`, `typescript`…) or `any`. */
  contexts: string[];
  variables?: TemplateVariable[];
  enabled?: boolean;
  /** `code` (default) skips strings and comments; `any` expands everywhere. */
  scope?: "code" | "any";
}

export type Segment = { t: "text"; v: string } | { t: "var"; name: string } | { t: "end" } | { t: "selection" };

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseBody(body: string): Segment[] {
  const out: Segment[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };
  let i = 0;
  while (i < body.length) {
    const c = body[i]!;
    if (c !== "$") {
      text += c;
      i++;
      continue;
    }
    if (body[i + 1] === "$") {
      text += "$";
      i += 2;
      continue;
    }
    const close = body.indexOf("$", i + 1);
    const name = close > 0 ? body.slice(i + 1, close) : "";
    if (!VAR_NAME.test(name)) {
      text += c;
      i++;
      continue;
    }
    flush();
    if (name === "END") out.push({ t: "end" });
    else if (name === "SELECTION") out.push({ t: "selection" });
    else out.push({ t: "var", name });
    i = close + 1;
  }
  flush();
  return out;
}

/** Variable names in order of first appearance (excluding END / SELECTION). */
export function bodyVariables(body: string): string[] {
  const seen: string[] = [];
  for (const s of parseBody(body)) if (s.t === "var" && !seen.includes(s.name)) seen.push(s.name);
  return seen;
}

export const usesSelection = (body: string) => parseBody(body).some((s) => s.t === "selection");

// ---------------------------------------------------------------------------
// Expressions

type Expr = { k: "str"; v: string } | { k: "ref"; name: string } | { k: "call"; fn: string; args: Expr[] };

export function parseExpression(src: string): Expr | null {
  let i = 0;
  const ws = () => {
    while (i < src.length && /\s/.test(src[i]!)) i++;
  };
  const parse = (): Expr | null => {
    ws();
    const c = src[i];
    if (c === '"' || c === "'") {
      const q = c;
      let v = "";
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === "\\" && i + 1 < src.length) i++;
        v += src[i++];
      }
      if (src[i] !== q) return null;
      i++;
      return { k: "str", v };
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (!m) return null;
    i += m[0].length;
    ws();
    if (src[i] !== "(") return { k: "ref", name: m[0] };
    i++;
    const args: Expr[] = [];
    ws();
    if (src[i] === ")") {
      i++;
      return { k: "call", fn: m[0], args };
    }
    for (;;) {
      const a = parse();
      if (!a) return null;
      args.push(a);
      ws();
      if (src[i] === ",") {
        i++;
        continue;
      }
      if (src[i] === ")") {
        i++;
        return { k: "call", fn: m[0], args };
      }
      return null;
    }
  };
  const e = parse();
  ws();
  return e && i === src.length ? e : null;
}

/** Functions available to variable expressions; return `""` when unknown. */
export type TemplateFunctions = Record<string, (...args: string[]) => string>;

const words = (s: string): string[] =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const decapitalize = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
export const camelCase = (s: string) =>
  words(s)
    .map((w, i) => (i ? capitalize(w.toLowerCase()) : w.toLowerCase()))
    .join("");
export const pascalCase = (s: string) => capitalize(camelCase(s));
export const snakeCase = (s: string) =>
  words(s)
    .map((w) => w.toLowerCase())
    .join("_");
export const kebabCase = (s: string) =>
  words(s)
    .map((w) => w.toLowerCase())
    .join("-");

/** `SimpleDateFormat`-style subset: yyyy yy MM M dd d HH H mm ss EEE MMM. */
export function formatDate(d: Date, format?: string): string {
  if (!format) {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const map: Record<string, () => string> = {
    yyyy: () => String(d.getFullYear()),
    yy: () => pad(d.getFullYear() % 100),
    MMMM: () => d.toLocaleString("en", { month: "long" }),
    MMM: () => d.toLocaleString("en", { month: "short" }),
    MM: () => pad(d.getMonth() + 1),
    M: () => String(d.getMonth() + 1),
    dd: () => pad(d.getDate()),
    d: () => String(d.getDate()),
    HH: () => pad(d.getHours()),
    H: () => String(d.getHours()),
    mm: () => pad(d.getMinutes()),
    ss: () => pad(d.getSeconds()),
    EEEE: () => d.toLocaleString("en", { weekday: "long" }),
    EEE: () => d.toLocaleString("en", { weekday: "short" }),
  };
  return format.replace(/yyyy|yy|MMMM|MMM|MM|M|dd|d|HH|H|mm|ss|EEEE|EEE|'[^']*'/g, (t) =>
    t.startsWith("'") ? t.slice(1, -1) : (map[t]?.() ?? t),
  );
}

const PURE_FUNCTIONS: TemplateFunctions = {
  capitalize,
  decapitalize,
  camelCase,
  pascalCase,
  snakeCase,
  lowercaseAndDash: kebabCase,
  kebabCase,
  capitalizeAndUnderscore: (s) => snakeCase(s).toUpperCase(),
  upperCase: (s) => s.toUpperCase(),
  lowerCase: (s) => s.toLowerCase(),
  concat: (...a) => a.join(""),
  substringBefore: (s, d) => (d && s.includes(d) ? s.slice(0, s.indexOf(d)) : s),
  date: (f) => formatDate(new Date(), f || undefined),
  time: (f) => formatDate(new Date(), f || "HH:mm"),
  // Interactive helpers: no value, the field stays a plain tab stop.
  complete: () => "",
  completeSmart: () => "",
  // IDEA's database macros: the editor completes the object / columns at the field.
  dbObjectName: () => "",
  dbColumns: () => "",
  showParameterInfo: () => "",
  enum: (...a) => a[0] ?? "",
};

export function evaluateExpression(src: string, fns: TemplateFunctions, values: Record<string, string> = {}): string {
  const e = parseExpression(src.trim());
  if (!e) return "";
  const ev = (x: Expr): string => {
    if (x.k === "str") return x.v;
    if (x.k === "ref") return values[x.name] ?? "";
    const f = fns[x.fn] ?? PURE_FUNCTIONS[x.fn];
    if (!f) return "";
    try {
      return f(...x.args.map(ev)) ?? "";
    } catch {
      return "";
    }
  };
  return ev(e);
}

/** Function names an expression calls (to fetch e.g. the clipboard only when needed). */
export function calledFunctions(src: string): string[] {
  const out: string[] = [];
  const walk = (x: Expr | null) => {
    if (x?.k !== "call") return;
    out.push(x.fn);
    x.args.forEach(walk);
  };
  walk(parseExpression(src.trim()));
  return out;
}

// ---------------------------------------------------------------------------
// Expansion

export interface ExpansionEnv {
  fns?: TemplateFunctions;
  /** Text for `$SELECTION$`; its first line is expected to start at its indentation. */
  selection?: string;
  /** Indentation of the selection's first line in the document (stripped from later lines). */
  selectionIndent?: string;
  /** Variables with fixed values (e.g. postfix `$EXPR$`); inserted as plain text. */
  predefined?: Record<string, string>;
}

export interface Expansion {
  /** `@codemirror/autocomplete` snippet template. */
  snippet: string;
  /** The first tab stop asks for completion (`complete()`). */
  completeFirst: boolean;
  /** Per tab stop, in order: whether it asks for completion. */
  completing: boolean[];
  /** Plain-text result with fields at their default values (for previews/tests). */
  preview: string;
}

const escapeText = (s: string) => s.replace(/[{}]/g, (m) => `\\${m}`);
/** Field defaults cannot contain braces or line breaks in CodeMirror snippets. */
const fieldDefault = (s: string) => s.replace(/[{}]/g, "").replace(/\r?\n[\s\S]*$/, "");

function dedentSelection(text: string, indent: string | undefined): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1]!.trim() === "") lines.pop();
  const rest = lines.slice(1).filter((l) => l.trim());
  let strip = indent ?? null;
  if (strip === null || rest.some((l) => !l.startsWith(strip!))) {
    const common = rest.length ? rest.map((l) => /^[ \t]*/.exec(l)![0]).reduce((a, b) => commonPrefix(a, b)) : "";
    strip = strip !== null ? commonPrefix(strip, common) : common;
  }
  return lines.map((l, i) => (i === 0 ? l.trimStart() : l.startsWith(strip!) ? l.slice(strip!.length) : l.trimStart()));
}

function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(0, i);
}

/** Expressions whose field is filled through completion. */
const COMPLETING = /\b(complete|completeSmart|dbObjectName|dbColumns)\(\)/;

/** Converts a template to a CodeMirror snippet with linked fields and a final caret. */
export function expandTemplate(t: Pick<LiveTemplate, "body" | "variables">, env: ExpansionEnv = {}): Expansion {
  const segments = parseBody(t.body);
  const fns = env.fns ?? {};
  const predefined = env.predefined ?? {};
  const declared = new Map((t.variables ?? []).map((v) => [v.name, v]));

  // Tab order: declared variables first (IDEA's order), then by appearance.
  const order: string[] = [];
  for (const v of t.variables ?? []) if (segments.some((s) => s.t === "var" && s.name === v.name)) order.push(v.name);
  for (const s of segments) if (s.t === "var" && !order.includes(s.name)) order.push(s.name);

  const values: Record<string, string> = { ...predefined };
  const stops = new Map<string, number>();
  const completing: boolean[] = [];
  for (const name of order) {
    if (name in predefined) continue;
    const v = declared.get(name);
    let value = v?.expression ? evaluateExpression(v.expression, fns, values) : "";
    if (!value && v?.defaultValue)
      value = evaluateExpression(v.defaultValue, fns, values) || v.defaultValue.replace(/^"|"$/g, "");
    values[name] = value;
    if (v?.skipIfDefined && value) continue;
    stops.set(name, stops.size + 1);
    completing.push(!!v?.expression && COMPLETING.test(v.expression));
  }

  let snippet = "";
  let preview = "";
  let hasEnd = false;
  for (const s of segments) {
    if (s.t === "text") {
      snippet += escapeText(s.v);
      preview += s.v;
    } else if (s.t === "end") {
      if (!hasEnd) snippet += "${0}";
      hasEnd = true;
    } else if (s.t === "selection") {
      const sel = env.selection ?? "";
      const lineStart = snippet.lastIndexOf("\n") + 1;
      const tabs = /^\t*/.exec(snippet.slice(lineStart))![0];
      const lines = dedentSelection(sel, env.selectionIndent);
      const joined = lines.map((l, i) => (i === 0 ? l : tabs + l)).join("\n");
      snippet += escapeText(joined);
      preview += joined;
    } else {
      const value = values[s.name] ?? "";
      const stop = stops.get(s.name);
      if (stop === undefined) {
        snippet += escapeText(value);
      } else {
        const d = fieldDefault(value);
        snippet += d ? `\${${stop}:${d}}` : `\${${stop}}`;
      }
      preview += value;
    }
  }
  if (!hasEnd) snippet += "${0}";
  return { snippet, completeFirst: completing[0] ?? false, completing, preview };
}

/**
 * Templates applicable to a language, optionally inside strings/comments.
 * `contexts`: finer contexts the editor reports at the caret (`sql-statement`…).
 */
export function applicableTemplates(
  templates: readonly LiveTemplate[],
  language: string,
  opts: { inCommentOrString?: boolean; contexts?: readonly string[] } = {},
): LiveTemplate[] {
  const extra = opts.contexts ?? [];
  return templates.filter(
    (t) =>
      t.enabled !== false &&
      t.contexts.some((c) => c === "any" || c === language || extra.includes(c)) &&
      !(opts.inCommentOrString && (t.scope ?? "code") === "code"),
  );
}
