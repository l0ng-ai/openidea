/**
 * Java / Kotlin run targets: `main` methods (the class to launch) and JUnit 4/5 /
 * TestNG test methods and classes, with their binary class names (`pkg.Outer$Inner`).
 *
 * A small token scanner rather than per-line regexes, so annotations on earlier
 * lines (with arguments), multi-line signatures, nested and `@Nested` classes,
 * Kotlin objects / companions and comments or strings are handled. Contained
 * here so it can move to the tree-sitter structure service later.
 */

export interface JvmTarget {
  line: number;
  kind: "main" | "test" | "suite";
  /** Binary name of the class (`com.acme.Outer$Inner`). */
  className: string;
  /** Test method name (tests only). */
  method?: string;
  /** The class is a `@SpringBootApplication`. */
  spring?: boolean;
  /** Java 25 instance `main` (JEP 512): a subclass cannot inherit it on older JDKs. */
  instance?: boolean;
}

/** A class with `extends X` and no `main` of its own: it may inherit one. */
export interface JvmMainCandidate {
  /** Position of the class name (0-based line, UTF-16 column). */
  line: number;
  col: number;
  className: string;
  /** The superclass as written (`a.b.Base`), so an answer lapses when the `extends` clause changes. */
  base: string;
  spring?: boolean;
}

interface Token {
  text: string;
  line: number;
  col: number;
}

/** Blanks comments, strings, text blocks and char literals (newlines kept). */
export function stripCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  while (i < n) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      const stop = end < 0 ? n : end;
      out += blank(src.slice(i, stop));
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      out += blank(src.slice(i, stop));
      i = stop;
    } else if (c === '"' && src.startsWith('"""', i)) {
      const end = src.indexOf('"""', i + 3);
      const stop = end < 0 ? n : end + 3;
      out += '""' + blank(src.slice(i + 2, stop));
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      const stop = Math.min(n, j + 1);
      out += c + blank(src.slice(i + 1, stop - 1)) + (src[stop - 1] === c ? c : " ");
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  const re = /`[^`\n]+`|[A-Za-z_$][\w$]*|\d[\w.]*|\S/g;
  const lines = code.split("\n");
  for (let line = 0; line < lines.length; line++) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lines[line]!))) tokens.push({ text: m[0], line, col: m.index });
  }
  return tokens;
}

const TEST_ANNOTATIONS = new Set(["Test", "ParameterizedTest", "RepeatedTest", "TestFactory", "TestTemplate"]);
const TYPE_KEYWORDS = new Set(["class", "interface", "enum", "record", "object"]);
const NOT_TYPES = new Set(["new", "return", "throw", "else", "case", "assert", "yield", "await", "this", "super"]);
const KOTLIN_DECL = /^(fun|val|var|class|object|interface|enum|data|sealed|abstract|open|private|public|internal|@)$/;
const MEMBER_END = new Set([";", "{", "}", ")"]);
const isIdent = (t: string | undefined) => !!t && /^[A-Za-z_$`]/.test(t);
const unquote = (t: string) => t.replace(/^`|`$/g, "");

interface ClassFrame {
  name: string;
  /** Brace depth inside the class body. */
  depth: number;
  line: number;
  annotations: string[];
  kind: string;
  companion: boolean;
  /** Java `class … extends X` that may inherit a `main` (top-level or `static` nested). */
  inheritsFrom?: { col: number; base: string };
}

/** Targets of a Java (`kotlin = false`) or Kotlin source file. */
export function scanJvmTargets(src: string, relPath: string, kotlin: boolean): JvmTarget[] {
  return scan(src, relPath, kotlin).targets;
}

/** Java classes that extend another class but declare no `main`; see `inheritedMain.ts`. */
export function jvmMainCandidates(src: string, relPath: string): JvmMainCandidate[] {
  return scan(src, relPath, false).candidates;
}

function scan(src: string, relPath: string, kotlin: boolean) {
  const code = stripCommentsAndStrings(src);
  const pkg = /^\s*package\s+([\w.]+)/m.exec(code)?.[1] ?? "";
  const qualify = (binary: string) => (pkg ? `${pkg}.${binary}` : binary);
  const tokens = tokenize(code);
  const out: JvmTarget[] = [];
  const candidates: JvmMainCandidate[] = [];
  const classes: ClassFrame[] = [];
  /** A class header seen, waiting for its `{`. */
  let pendingClass: Omit<ClassFrame, "depth"> | null = null;
  let annotations: string[] = [];
  let depth = 0;
  let parens = 0;
  const testClasses = new Map<string, { line: number; parent: string | null }>();

  const binaryName = (frames: ClassFrame[]) => frames.map((f) => f.name).join("$");
  const top = () => classes[classes.length - 1];
  /** Directly in a class body (or at file level for Kotlin top-level functions). */
  const atMemberLevel = () => (top() ? depth === top()!.depth : depth === 0);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!.text;
    const prev = tokens[i - 1]?.text;
    if (t === "(") parens++;
    else if (t === ")") parens = Math.max(0, parens - 1);
    if (parens > 0 && t !== "(") continue;
    // A Kotlin class without a body ends where the next declaration starts.
    if (pendingClass && kotlin && tokens[i]!.line > pendingClass.line && KOTLIN_DECL.test(t)) pendingClass = null;

    if (t === "@") {
      const name = tokens[i + 1]?.text;
      if (name === "interface") continue; // `@interface Foo` declares an annotation type
      // Qualified annotation (`@org.junit.Test`, `@file:JvmName`): keep the last segment.
      let j = i + 1;
      let last = name ?? "";
      while (tokens[j + 1]?.text === "." || tokens[j + 1]?.text === ":") {
        last = tokens[j + 2]?.text ?? last;
        j += 2;
      }
      annotations.push(last);
      i = j;
      if (tokens[i + 1]?.text === "(") {
        // Skip the arguments.
        let d = 0;
        for (i = i + 1; i < tokens.length; i++) {
          if (tokens[i]!.text === "(") d++;
          else if (tokens[i]!.text === ")" && --d === 0) break;
        }
      }
      continue;
    }

    if (TYPE_KEYWORDS.has(t) && prev !== "." && prev !== "::") {
      // `companion object [Name]`, `object Foo`, `class Foo`, `enum class Foo`.
      const companion = t === "object" && prev === "companion";
      const next = tokens[i + 1]?.text;
      const name = isIdent(next) && !TYPE_KEYWORDS.has(next!) ? unquote(next!) : companion ? "Companion" : null;
      if (name) {
        pendingClass = { name, line: tokens[i]!.line, annotations, kind: t, companion };
        const base = !kotlin && t === "class" ? extendsClause(tokens, i) : null;
        if (base && (classes.length === 0 || hasModifier(tokens, i, "static")))
          pendingClass.inheritsFrom = { col: tokens[i + 1]!.col, base };
        annotations = [];
      }
      continue;
    }

    if (t === "{") {
      if (pendingClass) {
        const frame = { ...pendingClass, depth: depth + 1 };
        if (frame.inheritsFrom)
          candidates.push({
            line: frame.line,
            col: frame.inheritsFrom.col,
            className: qualify(binaryName([...classes, frame])),
            base: frame.inheritsFrom.base,
            spring: frame.annotations.includes("SpringBootApplication") || undefined,
          });
        classes.push(frame);
        pendingClass = null;
      }
      depth++;
      annotations = [];
      continue;
    }
    if (t === "}") {
      depth = Math.max(0, depth - 1);
      while (classes.length && top()!.depth > depth) classes.pop();
      annotations = [];
      pendingClass = null;
      continue;
    }
    if (t === ";") {
      annotations = [];
      if (pendingClass && !kotlin) pendingClass = null;
      continue;
    }

    // Method declarations: `<type> name(` (Java) or `fun [<T>] [Receiver.]name(` (Kotlin).
    if (tokens[i + 1]?.text !== "(" || !isIdent(t) || !atMemberLevel() || pendingClass) continue;
    let isMethod = false;
    if (kotlin) {
      for (let k = i - 1; k >= 0 && k >= i - 8; k--) {
        const pt = tokens[k]!.text;
        if (pt === "fun") {
          isMethod = true;
          break;
        }
        if (pt !== "." && pt !== ">" && pt !== "<" && pt !== "," && !isIdent(pt)) break;
      }
    } else {
      isMethod = !!prev && (prev === ">" || prev === "]" || (isIdent(prev) && !NOT_TYPES.has(prev)));
    }
    if (!isMethod) continue;
    const name = unquote(t);
    const frames = [...classes];
    // Parameters (until the matching `)`).
    const params: string[] = [];
    let d = 0;
    for (let k = i + 1; k < tokens.length; k++) {
      const pt = tokens[k]!.text;
      if (pt === "(") d++;
      else if (pt === ")" && --d === 0) break;
      else params.push(pt);
    }
    const modifiers: string[] = [];
    for (let k = i - 1; k >= 0 && !MEMBER_END.has(tokens[k]!.text); k--) modifiers.push(tokens[k]!.text);
    const owner = top();
    if (annotations.some((a) => TEST_ANNOTATIONS.has(a)) && owner) {
      const className = qualify(binaryName(frames));
      out.push({ line: tokens[i]!.line, kind: "test", className, method: name });
      for (let f = frames.length; f > 0; f--) {
        const cls = qualify(binaryName(frames.slice(0, f)));
        if (!testClasses.has(cls))
          testClasses.set(cls, {
            line: frames[f - 1]!.line,
            parent: f > 1 ? qualify(binaryName(frames.slice(0, f - 1))) : null,
          });
        // Outer classes only run nested ones when those are `@Nested`.
        if (!frames[f - 1]!.annotations.includes("Nested")) break;
      }
    } else if (name === "main") {
      const paramText = params.filter((p) => p !== "final").join(" ");
      const stringArgs =
        /^(java\s*\.\s*lang\s*\.\s*)?String\s*(\[\s*]|\.\s*\.\s*\.)/.test(paramText) || paramText === "";
      const kotlinArgs = /^\w+\s*:\s*Array\s*<\s*(out\s+)?String\s*>$/.test(paramText) || paramText === "";
      if (kotlin && kotlinArgs) {
        if (!owner) {
          const jvmName = /@file:JvmName\(\s*"([^"]+)"\s*\)/.exec(src)?.[1];
          const stem = (relPath.split("/").pop() ?? relPath).replace(/\.kts?$/, "");
          const facade = jvmName ?? `${stem.charAt(0).toUpperCase()}${stem.slice(1)}Kt`;
          out.push({ line: tokens[i]!.line, kind: "main", className: qualify(facade) });
        } else if ((owner.kind === "object" || owner.companion) && annotations.includes("JvmStatic")) {
          // Companion members become statics of the enclosing class.
          const launch = owner.companion ? frames.slice(0, -1) : frames;
          if (launch.length) {
            const cls = launch[launch.length - 1]!;
            out.push({
              line: tokens[i]!.line,
              kind: "main",
              className: qualify(binaryName(launch)),
              spring: cls.annotations.includes("SpringBootApplication") || undefined,
            });
          }
        }
      } else if (!kotlin && owner && prev === "void" && stringArgs) {
        const isStatic = modifiers.includes("static");
        // Java 25 instance main methods (JEP 512) need no `static` / arguments.
        if (isStatic || owner.kind === "class" || owner.kind === "record") {
          const spring = classes.some((c) => c.annotations.includes("SpringBootApplication"));
          out.push({
            line: tokens[i]!.line,
            kind: "main",
            className: qualify(binaryName(frames)),
            spring: spring || undefined,
            instance: !isStatic || undefined,
          });
        }
      }
    }
    annotations = [];
  }

  const suites: JvmTarget[] = [...testClasses].map(([className, c]) => ({
    line: c.line,
    kind: "suite",
    className,
  }));
  // One main per class is enough (overloads).
  const seen = new Set<string>();
  const unique = out.filter((t) => t.kind !== "main" || (!seen.has(t.className) && !!seen.add(t.className)));
  const own = new Set(unique.filter((t) => t.kind === "main").map((t) => t.className));
  return {
    targets: [...suites, ...unique].sort((a, b) => a.line - b.line),
    candidates: candidates.filter((c) => !own.has(c.className)),
  };
}

function hasModifier(tokens: Token[], at: number, modifier: string): boolean {
  for (let k = at - 1; k >= 0 && !MEMBER_END.has(tokens[k]!.text); k--) if (tokens[k]!.text === modifier) return true;
  return false;
}

/** The superclass named by the `extends` clause of the `class` at `at` (not a type-parameter bound), if any. */
function extendsClause(tokens: Token[], at: number): string | null {
  let angle = 0;
  for (let k = at + 2; k < tokens.length && tokens[k]!.text !== "{" && tokens[k]!.text !== ";"; k++) {
    const t = tokens[k]!.text;
    if (t === "<") angle++;
    else if (t === ">") angle--;
    else if (angle === 0 && t === "extends") {
      let base = "";
      for (let j = k + 1; j < tokens.length && !["<", "{", "implements", "permits"].includes(tokens[j]!.text); j++)
        base += tokens[j]!.text;
      return base || null;
    }
  }
  return null;
}

/** Simple name of a binary class name (`a.b.Outer$Inner` → `Inner`). */
export function simpleClassName(className: string): string {
  return className.split(/[.$]/).pop() ?? className;
}
