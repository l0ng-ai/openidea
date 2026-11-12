/**
 * Postfix completion (`expr.if`, `.not`, `.var` …): expression detection
 * before the dot and the per-language template set. Template bodies use the
 * live-template syntax with `$EXPR$` bound to the expression text.
 */
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { TS_LANGS } from "../live/builtins";
import type { TemplateVariable } from "../live/model";

export interface PostfixTemplate {
  /** Stable id: `<lang group>.<key>`. */
  id: string;
  key: string;
  description: string;
  langs: string[];
  body: string;
  variables?: TemplateVariable[];
  /** Only offered when the expression starts its line (statement position). */
  statement?: boolean;
  /** Wrap compound expressions (`a + b`) in parentheses for `$EXPR$`. */
  wrapCompound?: boolean;
  /**
   * An editor action run on the selected expression instead of inserting `body`
   * (IDEA's `.var` is Introduce Variable); `body` remains for when it isn't available.
   */
  action?: string;
}

const NAME: TemplateVariable = { name: "NAME", expression: "suggestVariableName()", defaultValue: '"value"' };
const ITEM: TemplateVariable = { name: "ITEM", defaultValue: '"item"' };
const I: TemplateVariable = { name: "I", defaultValue: '"i"' };

type Def = Omit<PostfixTemplate, "id" | "langs">;

function set(key: string, langs: string[], defs: Def[]): PostfixTemplate[] {
  return defs.map((d) => ({ ...d, id: `${key}.${d.key}`, langs }));
}

const tsLike = set("ts", TS_LANGS, [
  { key: "if", description: "if (expr)", body: "if ($EXPR$) {\n\t$END$\n}", statement: true },
  { key: "else", description: "if (!expr)", body: "if (!$EXPR$) {\n\t$END$\n}", statement: true, wrapCompound: true },
  { key: "not", description: "!expr", body: "!$EXPR$$END$", wrapCompound: true },
  {
    key: "const",
    description: "const name = expr",
    body: "const $NAME$ = $EXPR$;$END$",
    statement: true,
    variables: [NAME],
  },
  {
    key: "var",
    description: "const name = expr",
    body: "const $NAME$ = $EXPR$;$END$",
    statement: true,
    variables: [NAME],
  },
  { key: "let", description: "let name = expr", body: "let $NAME$ = $EXPR$;$END$", statement: true, variables: [NAME] },
  { key: "return", description: "return expr", body: "return $EXPR$;$END$", statement: true },
  { key: "log", description: "console.log(expr)", body: "console.log($EXPR$);$END$", statement: true },
  { key: "await", description: "await expr", body: "await $EXPR$$END$", wrapCompound: true },
  { key: "par", description: "(expr)", body: "($EXPR$)$END$" },
  {
    key: "for",
    description: "for (const item of expr)",
    body: "for (const $ITEM$ of $EXPR$) {\n\t$END$\n}",
    statement: true,
    variables: [ITEM],
  },
  {
    key: "forin",
    description: "for (const key in expr)",
    body: "for (const $KEY$ in $EXPR$) {\n\t$END$\n}",
    statement: true,
    variables: [{ name: "KEY", defaultValue: '"key"' }],
  },
  {
    key: "fori",
    description: "for (let i = 0; i < expr; i++)",
    body: "for (let $I$ = 0; $I$ < $EXPR$; $I$++) {\n\t$END$\n}",
    statement: true,
    variables: [I],
  },
  { key: "nn", description: "if (expr != null)", body: "if ($EXPR$ != null) {\n\t$END$\n}", statement: true },
  { key: "notnull", description: "if (expr != null)", body: "if ($EXPR$ != null) {\n\t$END$\n}", statement: true },
  { key: "null", description: "if (expr == null)", body: "if ($EXPR$ == null) {\n\t$END$\n}", statement: true },
  {
    key: "try",
    description: "try { expr } catch",
    body: "try {\n\t$EXPR$;$END$\n} catch (e) {\n\t\n}",
    statement: true,
  },
  { key: "cast", description: "(expr as Type)", body: "($EXPR$ as $TYPE$)$END$" },
  { key: "typeof", description: "typeof expr", body: "typeof $EXPR$$END$", wrapCompound: true },
  { key: "throw", description: "throw expr", body: "throw $EXPR$;$END$", statement: true },
]);

const rust = set(
  "rust",
  ["rust"],
  [
    { key: "if", description: "if expr", body: "if $EXPR$ {\n\t$END$\n}", statement: true },
    { key: "else", description: "if !expr", body: "if !$EXPR$ {\n\t$END$\n}", statement: true, wrapCompound: true },
    { key: "not", description: "!expr", body: "!$EXPR$$END$", wrapCompound: true },
    {
      key: "let",
      description: "let name = expr;",
      body: "let $NAME$ = $EXPR$;$END$",
      statement: true,
      variables: [NAME],
    },
    {
      key: "letm",
      description: "let mut name = expr;",
      body: "let mut $NAME$ = $EXPR$;$END$",
      statement: true,
      variables: [NAME],
    },
    { key: "match", description: "match expr", body: "match $EXPR$ {\n\t$PAT$ => $END$,\n}", statement: true },
    { key: "while", description: "while expr", body: "while $EXPR$ {\n\t$END$\n}", statement: true },
    {
      key: "for",
      description: "for item in expr",
      body: "for $ITEM$ in $EXPR$ {\n\t$END$\n}",
      statement: true,
      variables: [ITEM],
    },
    { key: "return", description: "return expr;", body: "return $EXPR$;$END$", statement: true },
    { key: "println", description: 'println!("{:?}", expr)', body: 'println!("{:?}", $EXPR$);$END$', statement: true },
    { key: "dbg", description: "dbg!(expr)", body: "dbg!($EXPR$)$END$" },
    { key: "ok", description: "Ok(expr)", body: "Ok($EXPR$)$END$" },
    { key: "err", description: "Err(expr)", body: "Err($EXPR$)$END$" },
    { key: "some", description: "Some(expr)", body: "Some($EXPR$)$END$" },
    { key: "box", description: "Box::new(expr)", body: "Box::new($EXPR$)$END$" },
    { key: "ref", description: "&expr", body: "&$EXPR$$END$", wrapCompound: true },
    { key: "refm", description: "&mut expr", body: "&mut $EXPR$$END$", wrapCompound: true },
    { key: "par", description: "(expr)", body: "($EXPR$)$END$" },
    {
      key: "iflet",
      description: "if let Some(x) = expr",
      body: "if let Some($ITEM$) = $EXPR$ {\n\t$END$\n}",
      statement: true,
      variables: [ITEM],
    },
  ],
);

const python = set(
  "py",
  ["python"],
  [
    { key: "if", description: "if expr:", body: "if $EXPR$:\n\t$END$", statement: true },
    { key: "ifn", description: "if expr is None:", body: "if $EXPR$ is None:\n\t$END$", statement: true },
    { key: "ifnn", description: "if expr is not None:", body: "if $EXPR$ is not None:\n\t$END$", statement: true },
    { key: "nn", description: "if expr is not None:", body: "if $EXPR$ is not None:\n\t$END$", statement: true },
    { key: "null", description: "if expr is None:", body: "if $EXPR$ is None:\n\t$END$", statement: true },
    { key: "not", description: "not expr", body: "not $EXPR$$END$", wrapCompound: true },
    { key: "var", description: "name = expr", body: "$NAME$ = $EXPR$$END$", statement: true, variables: [NAME] },
    { key: "return", description: "return expr", body: "return $EXPR$$END$", statement: true },
    { key: "print", description: "print(expr)", body: "print($EXPR$)$END$", statement: true },
    {
      key: "for",
      description: "for item in expr:",
      body: "for $ITEM$ in $EXPR$:\n\t$END$",
      statement: true,
      variables: [ITEM],
    },
    {
      key: "fori",
      description: "for i in range(expr):",
      body: "for $I$ in range($EXPR$):\n\t$END$",
      statement: true,
      variables: [I],
    },
    { key: "while", description: "while expr:", body: "while $EXPR$:\n\t$END$", statement: true },
    { key: "len", description: "len(expr)", body: "len($EXPR$)$END$" },
    { key: "par", description: "(expr)", body: "($EXPR$)$END$" },
    { key: "await", description: "await expr", body: "await $EXPR$$END$", wrapCompound: true },
    {
      key: "try",
      description: "try: expr except",
      body: "try:\n\t$EXPR$$END$\nexcept Exception as e:\n\traise",
      statement: true,
    },
  ],
);

const go = set(
  "go",
  ["go"],
  [
    { key: "if", description: "if expr {}", body: "if $EXPR$ {\n\t$END$\n}", statement: true },
    { key: "else", description: "if !expr {}", body: "if !$EXPR$ {\n\t$END$\n}", statement: true, wrapCompound: true },
    { key: "not", description: "!expr", body: "!$EXPR$$END$", wrapCompound: true },
    { key: "var", description: "name := expr", body: "$NAME$ := $EXPR$$END$", statement: true, variables: [NAME] },
    { key: "return", description: "return expr", body: "return $EXPR$$END$", statement: true },
    { key: "print", description: "fmt.Println(expr)", body: "fmt.Println($EXPR$)$END$", statement: true },
    {
      key: "for",
      description: "for _, v := range expr",
      body: "for _, $ITEM$ := range $EXPR$ {\n\t$END$\n}",
      statement: true,
      variables: [{ name: "ITEM", defaultValue: '"v"' }],
    },
    {
      key: "fori",
      description: "for i := 0; i < expr; i++",
      body: "for $I$ := 0; $I$ < $EXPR$; $I$++ {\n\t$END$\n}",
      statement: true,
      variables: [I],
    },
    { key: "nn", description: "if expr != nil", body: "if $EXPR$ != nil {\n\t$END$\n}", statement: true },
    { key: "null", description: "if expr == nil", body: "if $EXPR$ == nil {\n\t$END$\n}", statement: true },
    { key: "par", description: "(expr)", body: "($EXPR$)$END$" },
    { key: "len", description: "len(expr)", body: "len($EXPR$)$END$" },
  ],
);

const java = set(
  "java",
  ["java"],
  [
    { key: "if", description: "if (expr)", body: "if ($EXPR$) {\n\t$END$\n}", statement: true },
    { key: "else", description: "if (!expr)", body: "if (!$EXPR$) {\n\t$END$\n}", statement: true, wrapCompound: true },
    { key: "not", description: "!expr", body: "!$EXPR$$END$", wrapCompound: true },
    {
      key: "var",
      description: "T name = expr;",
      body: "var $NAME$ = $EXPR$;$END$",
      statement: true,
      variables: [NAME],
      // The server declares the expression's type, as IDEA does by default.
      action: "refactor.extractVariable",
    },
    { key: "return", description: "return expr;", body: "return $EXPR$;$END$", statement: true },
    { key: "sout", description: "System.out.println(expr)", body: "System.out.println($EXPR$);$END$", statement: true },
    {
      key: "for",
      description: "for (var item : expr)",
      body: "for (var $ITEM$ : $EXPR$) {\n\t$END$\n}",
      statement: true,
      variables: [ITEM],
    },
    {
      key: "fori",
      description: "for (int i = 0; i < expr; i++)",
      body: "for (int $I$ = 0; $I$ < $EXPR$; $I$++) {\n\t$END$\n}",
      statement: true,
      variables: [I],
    },
    { key: "nn", description: "if (expr != null)", body: "if ($EXPR$ != null) {\n\t$END$\n}", statement: true },
    { key: "null", description: "if (expr == null)", body: "if ($EXPR$ == null) {\n\t$END$\n}", statement: true },
    { key: "while", description: "while (expr)", body: "while ($EXPR$) {\n\t$END$\n}", statement: true },
    { key: "par", description: "(expr)", body: "($EXPR$)$END$" },
    { key: "cast", description: "((Type) expr)", body: "(($TYPE$) $EXPR$)$END$", wrapCompound: true },
    {
      key: "try",
      description: "try { expr } catch",
      body: "try {\n\t$EXPR$;$END$\n} catch (Exception e) {\n\tthrow new RuntimeException(e);\n}",
      statement: true,
    },
    { key: "throw", description: "throw expr;", body: "throw $EXPR$;$END$", statement: true },
  ],
);

const kotlin = set(
  "kt",
  ["kotlin"],
  [
    { key: "if", description: "if (expr)", body: "if ($EXPR$) {\n\t$END$\n}", statement: true },
    { key: "else", description: "if (!expr)", body: "if (!$EXPR$) {\n\t$END$\n}", statement: true, wrapCompound: true },
    { key: "not", description: "!expr", body: "!$EXPR$$END$", wrapCompound: true },
    {
      key: "val",
      description: "val name = expr",
      body: "val $NAME$ = $EXPR$$END$",
      statement: true,
      variables: [NAME],
    },
    {
      key: "var",
      description: "var name = expr",
      body: "var $NAME$ = $EXPR$$END$",
      statement: true,
      variables: [NAME],
    },
    { key: "return", description: "return expr", body: "return $EXPR$$END$", statement: true },
    { key: "sout", description: "println(expr)", body: "println($EXPR$)$END$", statement: true },
    {
      key: "for",
      description: "for (item in expr)",
      body: "for ($ITEM$ in $EXPR$) {\n\t$END$\n}",
      statement: true,
      variables: [ITEM],
    },
    {
      key: "fori",
      description: "for (i in 0 until expr)",
      body: "for ($I$ in 0 until $EXPR$) {\n\t$END$\n}",
      statement: true,
      variables: [I],
    },
    { key: "nn", description: "if (expr != null)", body: "if ($EXPR$ != null) {\n\t$END$\n}", statement: true },
    { key: "null", description: "if (expr == null)", body: "if ($EXPR$ == null) {\n\t$END$\n}", statement: true },
    { key: "let", description: "expr?.let { }", body: "$EXPR$?.let {\n\t$END$\n}", wrapCompound: true },
    { key: "while", description: "while (expr)", body: "while ($EXPR$) {\n\t$END$\n}", statement: true },
    { key: "par", description: "(expr)", body: "($EXPR$)$END$" },
    { key: "cast", description: "(expr as Type)", body: "($EXPR$ as $TYPE$)$END$" },
    {
      key: "try",
      description: "try { expr } catch",
      body: "try {\n\t$EXPR$$END$\n} catch (e: Exception) {\n\tthrow e\n}",
      statement: true,
    },
    { key: "when", description: "when (expr)", body: "when ($EXPR$) {\n\t$END$\n}", statement: true },
  ],
);

export const POSTFIX_TEMPLATES: readonly PostfixTemplate[] = [...tsLike, ...rust, ...python, ...go, ...java, ...kotlin];

export const POSTFIX_GROUPS: Array<{ id: string; title: string }> = [
  { id: "ts", title: "JavaScript / TypeScript" },
  { id: "rust", title: "Rust" },
  { id: "py", title: "Python" },
  { id: "go", title: "Go" },
  { id: "java", title: "Java" },
  { id: "kt", title: "Kotlin" },
];

export function postfixTemplatesFor(language: string, disabled: ReadonlySet<string> = new Set()): PostfixTemplate[] {
  return POSTFIX_TEMPLATES.filter((t) => t.langs.includes(language) && !disabled.has(t.id));
}

// ---------------------------------------------------------------------------
// Expression detection

export interface PostfixTarget {
  /** Offset of the `.` before the key. */
  dot: number;
  /** End of the typed key (the caret). */
  end: number;
  key: string;
  /** Candidate expressions, innermost first; each ends at `dot`. */
  candidates: Array<{ from: number; text: string; statement: boolean }>;
}

const OPEN: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
const IDENT = /[\p{L}\p{N}_$]/u;
const GENERIC_LANGS = new Set(["java", "kotlin", "rust", "csharp", "scala", "swift", ...TS_LANGS]);
const POSTFIX_OPS: Record<string, string> = {
  rust: "?",
  kotlin: "!",
  typescript: "!",
  typescriptreact: "!",
  swift: "!?",
};

/** Index of the bracket opening the one that closes at `close - 1`, or -1. */
function matchOpen(text: string, close: number): number {
  const stack: string[] = [];
  for (let i = close - 1; i >= 0; i--) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === "`") {
      const q = skipStringBack(text, i + 1);
      if (q < 0) return -1;
      i = q;
      continue;
    }
    if (c in OPEN) stack.push(OPEN[c]!);
    else if (c === "(" || c === "[" || c === "{") {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

/** Start of the string literal ending (with its quote) at `end`, or -1. */
function skipStringBack(text: string, end: number): number {
  const q = text[end - 1]!;
  for (let i = end - 2; i >= 0; i--) {
    if (text[i] === "\n" && q !== "`") return -1;
    if (text[i] !== q) continue;
    let bs = 0;
    for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) bs++;
    if (bs % 2 === 0) {
      // Rust raw/byte strings, Python prefixes (r"", f"", b"").
      let k = i;
      while (
        k > 0 &&
        /[rbfuRBFU#]/.test(text[k - 1]!) &&
        !(k > 1 && IDENT.test(text[k - 2]!) && !/[rbfuRBFU]/.test(text[k - 2]!))
      )
        k--;
      return k;
    }
  }
  return -1;
}

/** Start of a `<...>` generic argument list closing at `close - 1`, or -1. */
function matchGeneric(text: string, close: number): number {
  let depth = 0;
  for (let i = close - 1; i >= 0 && close - i < 200; i--) {
    const c = text[i]!;
    if (c === ">") depth++;
    else if (c === "<") {
      depth--;
      if (depth === 0) return i;
    } else if (!/[\w\s,.?:&[\]$]/.test(c)) return -1;
  }
  return -1;
}

/**
 * Start of the call/member chain ending at `end` (exclusive): identifiers,
 * calls, indexing, literals and `.`/`::`/`?.`/`->` links, plus a leading
 * `new` for constructor calls.
 */
export function scanExpressionStart(text: string, end: number, language: string): number {
  let i = end;
  const ops = POSTFIX_OPS[language] ?? "";
  for (;;) {
    const start = i;
    // One primary (with trailing calls / indexing / postfix operators).
    for (;;) {
      const c = text[i - 1];
      if (c === undefined) break;
      if (c in OPEN) {
        const o = matchOpen(text, i);
        if (o < 0) return start === end ? end : start;
        i = o;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        const s = skipStringBack(text, i);
        if (s < 0) break;
        i = s;
        break;
      }
      // `foo?` / `foo!!` / `foo!` and Rust macro calls `vec![…]`.
      if (ops.includes(c) || (c === "!" && language === "rust" && IDENT.test(text[i - 2] ?? ""))) {
        i--;
        continue;
      }
      if (c === ">" && GENERIC_LANGS.has(language) && i !== end) {
        const g = matchGeneric(text, i);
        if (g > 0 && (IDENT.test(text[g - 1] ?? "") || text.slice(g - 2, g) === "::")) {
          i = g;
          continue;
        }
        break;
      }
      if (IDENT.test(c)) {
        while (i > 0 && IDENT.test(text[i - 1]!)) i--;
        // Lifetimes / labels are not expressions; numbers are fine.
        break;
      }
      break;
    }
    if (i === start) break;
    // A link to the previous part of the chain.
    const before = text.slice(Math.max(0, i - 2), i);
    if (before.endsWith("?.")) i -= 2;
    else if (before === "::" || before === "->") i -= 2;
    else if (before.endsWith(".") && !before.endsWith("..")) i -= 1;
    else break;
    if (i <= 0) break;
  }
  if (i === end) return end;
  // Skip a leading link that has nothing before it.
  while (text[i] === "." || text[i] === ":") i++;
  // `new Foo()` (Java, Kotlin has no `new`, TS/JS, C#).
  const m = /\bnew\s+$/.exec(text.slice(Math.max(0, i - 12), i));
  if (m && language !== "kotlin" && language !== "rust" && language !== "go" && language !== "python") i -= m[0].length;
  return i;
}

const STOP_NODE =
  /Statement|Block|Body|Program|Script|SourceFile|Module|Declaration|Definition|Item|Clause|List|Arg|Param|Template|Element|Document|Lambda|Arrow|Closure|Function|Macro|Attribute|Decorator|Annotation|Import|Export|Pattern|Spec|Case|Arm|Decl|⚠/;
const KEYWORD_START = /^(return|let|const|var|val|throw|yield|else|case|await|async|if|for|while|in|of|new\s*$)\b/;

function lineIsBlankBefore(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  return state.sliceDoc(line.from, pos).trim() === "";
}

/**
 * Finds the postfix key and candidate expressions before the caret: `foo.bar().if|`
 * → key `if`, expressions [`foo.bar()`]. Wider expressions (`a + b`) are
 * found through the syntax tree. Returns null when there is no `.key`.
 */
export function findPostfixTarget(state: EditorState, pos: number, language: string): PostfixTarget | null {
  const line = state.doc.lineAt(pos);
  const keyMatch = /[A-Za-z_]\w*$/.exec(state.sliceDoc(line.from, pos));
  const key = keyMatch?.[0] ?? "";
  const dot = pos - key.length - 1;
  if (dot <= line.from - 1 || state.sliceDoc(dot, dot + 1) !== ".") return null;
  if (state.sliceDoc(dot - 1, dot) === ".") return null;

  const windowFrom = Math.max(0, dot - 4000);
  const text = state.sliceDoc(windowFrom, dot);
  const start = windowFrom + scanExpressionStart(text, text.length, language);
  if (start >= dot) return null;
  const inner = state.sliceDoc(start, dot);
  if (/^\d+$/.test(inner)) return null; // `1.` is a number literal being typed
  const candidates: PostfixTarget["candidates"] = [
    { from: start, text: inner, statement: lineIsBlankBefore(state, start) },
  ];

  // Widen through the syntax tree: ancestors ending at the key (or the dot).
  let n: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(dot, -1);
  while (n.parent && (n.from > start || n.to < dot)) n = n.parent;
  for (; n; n = n.parent) {
    if (STOP_NODE.test(n.name) || n.type.isError) break;
    if (n.to < dot || n.to > pos) break;
    if (n.from >= start) continue;
    const textN = state.sliceDoc(n.from, dot).trim();
    if (!textN || KEYWORD_START.test(textN) || textN.endsWith(".")) break;
    if (/[;{}]/.test(textN.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, ""))) break;
    if (candidates.some((c) => c.text === textN)) continue;
    candidates.push({ from: n.from, text: textN, statement: lineIsBlankBefore(state, n.from) });
  }
  return { dot, end: pos, key, candidates };
}

/** `a + b` → needs parentheses for prefix templates. */
export function isCompound(expr: string): boolean {
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i]!;
    if (c === '"' || c === "'" || c === "`") {
      const close = expr.indexOf(c, i + 1);
      if (close < 0) return true;
      i = close;
    } else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (
      depth === 0 &&
      /[\s+\-*/%<>=&|^?:,]/.test(c) &&
      !(c === ":" && expr[i + 1] === ":") &&
      !(c === ":" && expr[i - 1] === ":") &&
      !(c === "?" && expr[i + 1] === ".")
    )
      return true;
  }
  return false;
}

/** Candidates a template may use (statement templates need a statement position). */
export function candidatesFor(t: PostfixTemplate, target: PostfixTarget): PostfixTarget["candidates"] {
  return t.statement ? target.candidates.filter((c) => c.statement) : target.candidates;
}
