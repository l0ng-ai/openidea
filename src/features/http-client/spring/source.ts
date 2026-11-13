/**
 * A declaration-level reader for Java and Kotlin sources: classes, methods,
 * fields and their annotations with unevaluated argument expressions. Enough
 * to read Spring Web mappings (no types, no statements); comments, strings and
 * bracket nesting are handled exactly, the rest is skipped.
 */

export interface Tok {
  kind: "id" | "str" | "num" | "p";
  text: string;
  /** String literals: the contents (escapes decoded). */
  value?: string;
  start: number;
  end: number;
  /** A line break precedes the token. */
  nl: boolean;
}

/** Unevaluated expression: its tokens. */
export type Expr = Tok[];

export interface Annotation {
  /** Simple name (`GetMapping` of `@org.springframework…GetMapping`). */
  name: string;
  /** Arguments by name; a positional argument is `value`. */
  args: Map<string, Expr>;
}

export interface Param {
  name: string;
  /** Type as written, without spaces (`List<String>`); "" when unknown. */
  type: string;
  annotations: Annotation[];
}

export interface Field {
  name: string;
  type: string;
  isStatic: boolean;
  init: Expr | null;
}

export interface Method {
  name: string;
  annotations: Annotation[];
  params: Param[];
  /** Offset of the name. */
  nameStart: number;
  /** Whole declaration, annotations included. */
  start: number;
  end: number;
}

export interface ClassDecl {
  name: string;
  annotations: Annotation[];
  nameStart: number;
  /** Whole declaration, annotations included. */
  start: number;
  end: number;
  /** Kotlin `object` / companion: its properties are static. */
  isObject: boolean;
  methods: Method[];
  fields: Field[];
  /** Java record components / Kotlin primary constructor parameters (`val`/`var` ones are properties). */
  ctorParams: Param[];
  classes: ClassDecl[];
  /** The class it extends (`extends Base<T>` / Kotlin `: Base()`), as written. */
  superclass?: string;
}

export interface SourceFile {
  packageName: string;
  imports: string[];
  classes: ClassDecl[];
  /** Top-level properties (Kotlin). */
  fields: Field[];
}

const ID_START = /[A-Za-z_$]/;
const ID_PART = /[\w$]/;

export function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let nl = false;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (c === "\n") {
      nl = true;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "\f") {
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close < 0 ? n : close + 2;
      if (text.slice(i, end).includes("\n")) nl = true;
      i = end;
      continue;
    }
    const start = i;
    if (c === '"' && text.startsWith('"""', i)) {
      const close = text.indexOf('"""', i + 3);
      const end = close < 0 ? n : close + 3;
      const body = text.slice(i + 3, close < 0 ? n : close);
      // Java text blocks start after a line break; Kotlin raw strings keep it.
      out.push({ kind: "str", text: text.slice(i, end), value: body.replace(/^[ \t]*\r?\n/, ""), start, end, nl });
      i = end;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let value = "";
      while (j < n && text[j] !== c && text[j] !== "\n") {
        if (text[j] === "\\" && j + 1 < n) {
          const e = text[j + 1]!;
          value += e === "n" ? "\n" : e === "t" ? "\t" : e;
          j += 2;
        } else value += text[j++];
      }
      const end = Math.min(n, j + 1);
      out.push({ kind: "str", text: text.slice(i, end), value, start, end, nl });
      i = end;
    } else if (c === "`") {
      const close = text.indexOf("`", i + 1);
      const end = close < 0 || text.slice(i, close).includes("\n") ? i + 1 : close + 1;
      out.push({ kind: "id", text: end > i + 1 ? text.slice(i + 1, end - 1) : "`", start, end, nl });
      i = end;
    } else if (ID_START.test(c)) {
      let j = i + 1;
      while (j < n && ID_PART.test(text[j]!)) j++;
      out.push({ kind: "id", text: text.slice(i, j), start, end: j, nl });
      i = j;
    } else if (/\d/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(text[j]!)) j++;
      out.push({ kind: "num", text: text.slice(i, j), start, end: j, nl });
      i = j;
    } else {
      out.push({ kind: "p", text: c, start, end: i + 1, nl });
      i++;
    }
    nl = false;
  }
  return out;
}

const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/** Index of the matching closing bracket for every opening one (unbalanced: the end). */
function matchBrackets(toks: Tok[]): Int32Array {
  const match = new Int32Array(toks.length).fill(-1);
  const stack: number[] = [];
  toks.forEach((t, i) => {
    if (t.kind !== "p") return;
    if (OPEN[t.text]) stack.push(i);
    else if (t.text === ")" || t.text === "]" || t.text === "}") {
      // Pop to the matching opener (unclosed ones inside end here too); stray closers are ignored.
      for (let k = stack.length - 1; k >= 0; k--) {
        if (OPEN[toks[stack[k]!]!.text] === t.text) {
          for (const o of stack.splice(k)) match[o] = i;
          break;
        }
      }
    }
  });
  for (const o of stack) match[o] = toks.length;
  return match;
}

const CLASS_KW = new Set(["class", "interface", "enum", "record", "object"]);
const MODIFIERS = new Set([
  "public",
  "private",
  "protected",
  "internal",
  "static",
  "final",
  "abstract",
  "open",
  "override",
  "const",
  "data",
  "sealed",
  "inline",
  "suspend",
  "lateinit",
  "default",
  "synchronized",
  "native",
  "transient",
  "volatile",
  "strictfp",
  "operator",
  "infix",
  "external",
  "annotation",
  "inner",
  "value",
  "companion",
  "fun",
  "val",
  "var",
]);
const NOT_METHOD = new Set(["if", "for", "while", "switch", "catch", "synchronized", "return", "new", "throw", "when"]);

class Reader {
  readonly match: Int32Array;
  constructor(readonly toks: Tok[]) {
    this.match = matchBrackets(toks);
  }

  is(i: number, text: string): boolean {
    const t = this.toks[i];
    return !!t && t.text === text && (t.kind === "p" || t.kind === "id");
  }

  /** A type name at `i` (`a.b.Base<T>`): its text and the index after it. */
  typeName(i: number, to: number): { name: string; end: number } | null {
    let j = i;
    while (j < to && this.toks[j]?.kind === "id" && (j === i || this.is(j - 1, "."))) {
      j++;
      if (!this.is(j, ".") || this.toks[j + 1]?.kind !== "id") break;
      j++;
    }
    if (j === i) return null;
    if (this.is(j, "<")) {
      let depth = 0;
      for (; j < to; j++) {
        if (this.is(j, "<")) depth++;
        else if (this.is(j, ">") && --depth === 0) break;
      }
      j++;
    }
    return { name: joined(this.toks.slice(i, j)), end: j };
  }

  /** Kotlin: a token on a new line that starts a member ends the previous one. */
  startsMember(i: number): boolean {
    const t = this.toks[i];
    if (!t || !t.nl) return false;
    return t.text === "@" || t.text === "}" || (t.kind === "id" && (MODIFIERS.has(t.text) || CLASS_KW.has(t.text)));
  }

  /** `@Name(args)` at `i` (the `@`); returns the annotation and the next index. */
  annotation(i: number): [Annotation, number] | null {
    if (!this.is(i, "@") || this.toks[i + 1]?.kind !== "id" || this.is(i + 1, "interface")) return null;
    let j = i + 1;
    let name = this.toks[j]!.text;
    // Kotlin use-site targets: `@field:JsonProperty`.
    if (this.is(j + 1, ":") && this.toks[j + 2]?.kind === "id") {
      j += 2;
      name = this.toks[j]!.text;
    }
    while (this.is(j + 1, ".") && this.toks[j + 2]?.kind === "id") {
      j += 2;
      name = this.toks[j]!.text;
    }
    j++;
    const args = new Map<string, Expr>();
    if (this.is(j, "(") && !this.toks[j]!.nl) {
      const close = this.match[j]!;
      const positional: Tok[][] = [];
      for (const part of this.split(j + 1, close)) {
        if (!part.length) continue;
        if (part[0]!.kind === "id" && part[1]?.text === "=" && part[1].kind === "p" && part[2]?.text !== "=")
          args.set(part[0]!.text, part.slice(2));
        else positional.push(part);
      }
      // Kotlin `vararg value`: `@GetMapping("/a", "/b")` is an array.
      if (positional.length === 1) args.set("value", positional[0]!);
      else if (positional.length > 1) {
        const p = (text: string, at: Tok): Tok => ({ kind: "p", text, start: at.start, end: at.start, nl: false });
        const first = positional[0]![0]!;
        args.set("value", [
          p("[", first),
          ...positional.flatMap((x, k) => (k ? [p(",", x[0]!), ...x] : x)),
          p("]", first),
        ]);
      }
      j = close + 1;
    }
    return [{ name, args }, j];
  }

  /** Splits `[from, to)` at top-level commas (brackets and generics nest). */
  split(from: number, to: number): Tok[][] {
    const parts: Tok[][] = [];
    let cur: Tok[] = [];
    let angle = 0;
    for (let i = from; i < to; i++) {
      const t = this.toks[i]!;
      if (t.kind === "p" && OPEN[t.text]) {
        const close = Math.min(this.match[i]!, to - 1);
        for (let k = i; k <= close; k++) cur.push(this.toks[k]!);
        i = close;
        continue;
      }
      if (t.kind === "p" && t.text === "<") angle++;
      if (t.kind === "p" && t.text === ">" && angle > 0) angle--;
      if (t.kind === "p" && t.text === "," && angle === 0) {
        parts.push(cur);
        cur = [];
        continue;
      }
      cur.push(t);
    }
    parts.push(cur);
    return parts.filter((p, idx) => p.length || idx < parts.length - 1);
  }

  params(open: number): Param[] {
    const close = this.match[open]!;
    const out: Param[] = [];
    for (const part of this.split(open + 1, close)) {
      const annotations: Annotation[] = [];
      const rest: Tok[] = [];
      const sub = new Reader(part);
      for (let i = 0; i < part.length;) {
        const a = sub.annotation(i);
        if (a) {
          annotations.push(a[0]);
          i = a[1];
        } else rest.push(part[i++]!);
      }
      const colon = rest.findIndex((t) => t.kind === "p" && t.text === ":");
      if (colon >= 0) {
        // Kotlin `name: Type = default`.
        const head = rest
          .slice(0, colon)
          .filter((t) => t.kind === "id" && !MODIFIERS.has(t.text) && t.text !== "vararg");
        const eq = rest.findIndex((t, k) => k > colon && t.kind === "p" && t.text === "=");
        const name = head[head.length - 1]?.text;
        if (name) out.push({ name, type: joined(rest.slice(colon + 1, eq < 0 ? undefined : eq)), annotations });
      } else {
        const toks = rest.filter((t) => !(t.kind === "id" && t.text === "final"));
        const last = toks[toks.length - 1];
        if (last?.kind === "id") out.push({ name: last.text, type: joined(toks.slice(0, -1)), annotations });
      }
    }
    return out;
  }

  /** Members of a body `[from, to)`; nested declarations recurse. */
  body(from: number, to: number, into: ClassDecl): void {
    let annotations: Annotation[] = [];
    let header: Tok[] = [];
    let declStart = -1;
    const reset = () => {
      annotations = [];
      header = [];
      declStart = -1;
    };
    const flushField = (init: Expr | null) => {
      const ids = header.filter((t) => t.kind === "id");
      const kw = header.findIndex((t) => t.kind === "id" && (t.text === "val" || t.text === "var"));
      const isStatic = into.isObject || ids.some((t) => t.text === "static" || t.text === "const");
      if (kw >= 0) {
        const name = header[kw + 1];
        const colon = header.findIndex((t, k) => k > kw && t.text === ":" && t.kind === "p");
        if (name?.kind === "id")
          into.fields.push({
            name: name.text,
            type: colon >= 0 ? joined(header.slice(colon + 1)) : "",
            isStatic,
            init,
          });
      } else {
        const typeToks = header.filter((t) => !(t.kind === "id" && MODIFIERS.has(t.text)));
        const name = typeToks[typeToks.length - 1];
        if (name?.kind === "id" && typeToks.length >= 2)
          into.fields.push({ name: name.text, type: joined(typeToks.slice(0, -1)), isStatic, init });
      }
    };
    let i = from;
    while (i < to) {
      const t = this.toks[i]!;
      if (header.length && this.startsMember(i) && !this.is(i, "}")) {
        flushField(null);
        reset();
      }
      const a = this.annotation(i);
      if (a) {
        if (declStart < 0) declStart = t.start;
        annotations.push(a[0]);
        i = a[1];
        continue;
      }
      if (t.kind === "p" && t.text === ";") {
        flushField(null);
        reset();
        i++;
        continue;
      }
      if (declStart < 0) declStart = t.start;
      const companion = t.kind === "id" && t.text === "object" && this.is(i + 1, "{");
      if (t.kind === "id" && CLASS_KW.has(t.text) && (this.toks[i + 1]?.kind === "id" || companion)) {
        const nameTok = companion ? t : this.toks[i + 1]!;
        const cls: ClassDecl = {
          name: companion ? "Companion" : nameTok.text,
          annotations,
          nameStart: nameTok.start,
          start: declStart,
          end: nameTok.end,
          isObject: t.text === "object",
          methods: [],
          fields: [],
          ctorParams: [],
          classes: [],
        };
        let j = companion ? i + 1 : i + 2;
        if (this.is(j, "<")) {
          let depth = 0;
          for (; j < to; j++) {
            if (this.is(j, "<")) depth++;
            else if (this.is(j, ">") && --depth === 0) break;
          }
          j++;
        }
        // Kotlin `class A @Inject constructor(…)`.
        while (j < to && (this.is(j, "@") || this.toks[j]?.kind === "id") && !this.toks[j]!.nl) {
          const ann = this.annotation(j);
          if (ann) j = ann[1];
          else if (this.toks[j]!.kind === "id" && (MODIFIERS.has(this.toks[j]!.text) || this.is(j, "constructor"))) j++;
          else break;
        }
        if (this.is(j, "(")) {
          cls.ctorParams = this.params(j);
          j = this.match[j]! + 1;
        }
        for (; j < to; j++) {
          if (this.is(j, "{") || this.is(j, ";") || this.startsMember(j)) break;
          // Java `extends Base`; Kotlin `: Base(…)` (a supertype called with arguments is the class).
          const javaSuper = this.toks[j]!.kind === "id" && this.toks[j]!.text === "extends";
          if (!cls.superclass && (javaSuper || this.is(j, ":") || this.is(j, ","))) {
            const type = this.typeName(j + 1, to);
            if (type && (javaSuper || this.is(type.end, "("))) cls.superclass = type.name;
          }
          if (OPEN[this.toks[j]!.text] && this.toks[j]!.kind === "p") j = this.match[j]!;
        }
        if (this.is(j, "{")) {
          const close = Math.min(this.match[j]!, to);
          this.body(j + 1, close, cls);
          cls.end = this.toks[close]?.end ?? this.toks[to - 1]!.end;
          j = close + 1;
        } else cls.end = this.toks[j - 1]!.end;
        into.classes.push(cls);
        reset();
        i = j;
        continue;
      }
      if (
        t.kind === "id" &&
        this.is(i + 1, "(") &&
        !NOT_METHOD.has(t.text) &&
        !header.some((h) => h.kind === "p" && (h.text === "=" || h.text === "."))
      ) {
        const params = this.params(i + 1);
        let j = this.match[i + 1]! + 1;
        for (; j < to; j++) {
          if (this.is(j, "{")) {
            j = this.match[j]! + 1;
            break;
          }
          if (this.is(j, ";")) {
            j++;
            break;
          }
          if (this.startsMember(j)) break;
          if (this.toks[j]!.kind === "p" && OPEN[this.toks[j]!.text]) j = this.match[j]!;
        }
        const end = this.toks[Math.min(j, this.toks.length) - 1]?.end ?? t.end;
        into.methods.push({ name: t.text, annotations, params, nameStart: t.start, start: declStart, end });
        reset();
        i = j;
        continue;
      }
      if (t.kind === "p" && t.text === "=") {
        const init: Tok[] = [];
        let j = i + 1;
        for (; j < to; j++) {
          if (this.is(j, ";") || this.is(j, "}")) break;
          const prev = this.toks[j - 1]!;
          const operand = prev.kind === "p" && /[+.(,=]/.test(prev.text);
          if (j > i + 1 && this.startsMember(j) && !operand) break;
          if (j > i + 1 && this.toks[j]!.nl && !operand && !/^[+.]$/.test(this.toks[j]!.text)) break;
          const tok = this.toks[j]!;
          if (tok.kind === "p" && OPEN[tok.text]) {
            const close = Math.min(this.match[j]!, to - 1);
            for (let k = j; k <= close; k++) init.push(this.toks[k]!);
            j = close;
          } else init.push(tok);
        }
        flushField(init);
        reset();
        i = this.is(j, ";") ? j + 1 : j;
        continue;
      }
      if (t.kind === "p" && OPEN[t.text]) {
        // Initializer blocks, enum constant arguments…
        i = this.match[i]! + 1;
        if (t.text === "{") reset();
        continue;
      }
      if (t.kind === "p" && t.text === ",") {
        // Enum constants / `int a, b;`.
        reset();
        i++;
        continue;
      }
      header.push(t);
      i++;
    }
    if (header.length) flushField(null);
  }
}

function joined(toks: Tok[]): string {
  return toks.map((t) => t.text).join("");
}

export function parseSource(text: string): SourceFile {
  const toks = tokenize(text);
  const r = new Reader(toks);
  let packageName = "";
  const imports: string[] = [];
  let i = 0;
  // `package a.b;` / `import a.b.C;` (Kotlin: no semicolons; `import a.b.C as D`).
  for (;;) {
    const t = toks[i];
    if (!t || t.kind !== "id" || (t.text !== "package" && t.text !== "import")) {
      if (t && r.is(i, "@") && toks[i + 1]?.text === "file") {
        const a = r.annotation(i);
        if (a) {
          i = a[1];
          continue;
        }
      }
      break;
    }
    let j = i + 1;
    let name = "";
    while (j < toks.length && !toks[j]!.nl && !r.is(j, ";")) {
      if (toks[j]!.kind === "id" && toks[j]!.text === "as") break;
      name += toks[j]!.text;
      j++;
    }
    while (j < toks.length && !toks[j]!.nl && !r.is(j, ";")) j++;
    if (r.is(j, ";")) j++;
    if (t.text === "package") packageName = name;
    else imports.push(name.replace(/^static/, ""));
    i = j;
  }
  const root: ClassDecl = {
    name: "",
    annotations: [],
    nameStart: 0,
    start: 0,
    end: text.length,
    isObject: true,
    methods: [],
    fields: [],
    ctorParams: [],
    classes: [],
  };
  r.body(i, toks.length, root);
  return { packageName, imports, classes: root.classes, fields: root.fields };
}

/** Every class of the file, nested ones included. */
export function allClasses(file: SourceFile): ClassDecl[] {
  const out: ClassDecl[] = [];
  const walk = (cs: ClassDecl[]) => {
    for (const c of cs) {
      out.push(c);
      walk(c.classes);
    }
  };
  walk(file.classes);
  return out;
}
