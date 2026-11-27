/**
 * Cucumber steps, both sides: the step definitions of JavaScript / TypeScript files
 * (`Given('a {int} item cart', …)` of `@cucumber/cucumber`, `playwright-bdd`'s `createBdd()`
 * functions) and the steps of Gherkin `.feature` files, with Cucumber expression and regular
 * expression matching between them. Python files are read by `pythonSteps`.
 */
import {
  pythonFramework,
  pythonImportInsertion,
  pythonStepDefinitions,
  pythonStepSnippet,
  type PythonFramework,
} from "./pythonSteps";

/**
 * A step definition: the pattern literal of a `Given` / `When` / `Then` / `Step` call, or of a
 * cucumber-jvm `@Given("…")` annotation.
 */
export interface StepDefinition {
  /** Offsets of the literal (quotes or slashes included) in its file. */
  from: number;
  to: number;
  /** The pattern as written, without quotes. */
  source: string;
  regexp: RegExp;
}

/** A step of a feature file, with the text it is matched by. */
export interface FeatureStep {
  /** Offsets of the step text (after the keyword) in its file. */
  from: number;
  to: number;
  /** The keyword as written, in the file's language. */
  keyword: string;
  /** What the keyword is, in English (`*` for the bullet). */
  type: "Given" | "When" | "Then" | "And" | "But" | "*";
  /** The text as written. */
  text: string;
  /** The text matched against definitions: Scenario Outline placeholders take the first example's values. */
  matchText: string;
}

const DEFINE = /\b(?:Given|When|Then|And|But|Step|defineStep)\s*(?:<[^<>()]*>\s*)?\(\s*/g;

/** The step definitions of a script; `path` tells a Python file from the others. */
export function stepDefinitions(text: string, path = ""): StepDefinition[] {
  if (/\.py$/i.test(path)) return pythonStepDefinitions(text);
  const out: StepDefinition[] = [];
  for (const m of text.matchAll(DEFINE)) {
    const at = m.index + m[0].length;
    const literal = readLiteral(text, at);
    if (!literal) continue;
    const regexp = literal.regexp ?? stringPattern(literal.value);
    if (regexp) out.push({ from: at, to: literal.end, source: literal.value, regexp });
  }
  return out;
}

/**
 * The pattern of a string: a regular expression when it is anchored with `^` or `$` (how
 * Cucumber's expression factory tells them apart, and how cucumber-jvm annotations write them),
 * else a Cucumber expression.
 */
function stringPattern(value: string): RegExp | null {
  if (!value.startsWith("^") && !value.endsWith("$")) return expressionRegExp(value);
  try {
    return new RegExp(value);
  } catch {
    return null;
  }
}

/** A string, template (without substitutions) or regular expression literal at `at`. */
function readLiteral(text: string, at: number): { value: string; end: number; regexp?: RegExp } | null {
  const quote = text[at];
  if (quote === "'" || quote === '"' || quote === "`") {
    let value = "";
    for (let i = at + 1; i < text.length; i++) {
      const c = text[i]!;
      if (c === "\\") {
        const next = text[i + 1] ?? "";
        // An escaped quote or backslash is itself (`'\\('` is the expression `\(`); other
        // escapes stay as written.
        value += next === quote || next === "\\" ? next : c + next;
        i++;
      } else if (c === quote) return { value, end: i + 1 };
      else if ((c === "\n" && quote !== "`") || (quote === "`" && c === "$" && text[i + 1] === "{")) return null;
      else value += c;
    }
    return null;
  }
  if (quote === "/") {
    let inClass = false;
    for (let i = at + 1; i < text.length; i++) {
      const c = text[i]!;
      if (c === "\\") i++;
      else if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "\n") return null;
      else if (c === "/" && !inClass) {
        const flags = /^[a-z]*/.exec(text.slice(i + 1))![0];
        const value = text.slice(at + 1, i);
        try {
          return { value, end: i + 1 + flags.length, regexp: new RegExp(value, flags.replace(/[gy]/g, "")) };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Built-in parameter types; a custom one (`defineParameterType`) matches anything. */
const PARAMETERS: Record<string, string> = {
  int: "-?\\d+",
  byte: "-?\\d+",
  short: "-?\\d+",
  long: "-?\\d+",
  biginteger: "-?\\d+",
  float: "-?(?:\\d+(?:[.,]\\d*)?|[.,]\\d+)(?:[eE][-+]?\\d+)?",
  double: "-?(?:\\d+(?:[.,]\\d*)?|[.,]\\d+)(?:[eE][-+]?\\d+)?",
  bigdecimal: "-?(?:\\d+(?:[.,]\\d*)?|[.,]\\d+)(?:[eE][-+]?\\d+)?",
  word: "[^\\s]+",
  string: "\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^'\\\\]|\\\\.)*'",
  "": ".*",
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * A Cucumber expression as an anchored regular expression: `{type}` parameters, `(optional)`
 * text, `a/b` alternatives within a word, `\` escapes. Null when it is malformed.
 */
export function expressionRegExp(expression: string): RegExp | null {
  let out = "";
  // Alternatives apply within a run of text without whitespace, parameters or optionals.
  let word: string[] = [""];
  const flush = () => {
    out += word.length > 1 ? `(?:${word.join("|")})` : word[0]!;
    word = [""];
  };
  const add = (re: string) => (word[word.length - 1] += re);
  for (let i = 0; i < expression.length; i++) {
    const c = expression[i]!;
    if (c === "\\" && i + 1 < expression.length) {
      add(escapeRe(expression[++i]!));
    } else if (c === "{") {
      const end = expression.indexOf("}", i);
      if (end < 0) return null;
      const name = expression.slice(i + 1, end).trim();
      flush();
      out += `(${PARAMETERS[name] ?? ".*?"})`;
      i = end;
    } else if (c === "(") {
      const end = expression.indexOf(")", i);
      if (end < 0) return null;
      add(`(?:${escapeRe(expression.slice(i + 1, end))})?`);
      i = end;
    } else if (c === "/") {
      word.push("");
    } else if (/\s/.test(c)) {
      flush();
      out += escapeRe(c);
    } else {
      add(escapeRe(c));
    }
  }
  flush();
  try {
    return new RegExp(`^${out}$`);
  } catch {
    return null;
  }
}

/** A spoken language's Gherkin keywords; step keywords keep their trailing space (`Given `, but `假如`). */
export interface GherkinDialect {
  given: string[];
  when: string[];
  then: string[];
  and: string[];
  but: string[];
  /** Feature, Rule, Background, Scenario and Scenario Outline keywords (before their `:`). */
  blocks: string[];
  examples: string[];
}

export const ENGLISH: GherkinDialect = {
  given: ["Given "],
  when: ["When "],
  then: ["Then "],
  and: ["And "],
  but: ["But "],
  blocks: [
    "Scenario Outline",
    "Scenario Template",
    "Background",
    "Business Need",
    "Feature",
    "Ability",
    "Scenario",
    "Example",
    "Rule",
  ],
  examples: ["Examples", "Scenarios"],
};

/** The `# language: <code>` of a feature file's header comments, if any. */
export function gherkinLanguage(text: string): string | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith("#")) return null;
    const m = /^#\s*language\s*:\s*(\S+)/.exec(trimmed);
    if (m) return m[1]!;
  }
  return null;
}

const TYPES = [
  ["given", "Given"],
  ["when", "When"],
  ["then", "Then"],
  ["and", "And"],
  ["but", "But"],
] as const;

/** Step keywords of a dialect, longest first, with what they are. */
function stepKeywords(dialect: GherkinDialect): Array<{ keyword: string; type: FeatureStep["type"] }> {
  const out: Array<{ keyword: string; type: FeatureStep["type"] }> = [{ keyword: "* ", type: "*" }];
  for (const [key, type] of TYPES) for (const keyword of dialect[key]) out.push({ keyword, type });
  return out.sort((a, b) => b.keyword.length - a.keyword.length);
}

const keywordCache = new WeakMap<GherkinDialect, ReturnType<typeof stepKeywords>>();

/** The steps of a feature file in `dialect`, placeholders filled from each outline's first example. */
export function featureSteps(text: string, dialect: GherkinDialect = ENGLISH): FeatureStep[] {
  let keywords = keywordCache.get(dialect);
  if (!keywords) keywordCache.set(dialect, (keywords = stepKeywords(dialect)));
  const out: FeatureStep[] = [];
  let outline: FeatureStep[] = [];
  let header: string[] | null = null;
  let examples = false;
  let docString: string | null = null;
  let offset = 0;
  for (const line of text.split("\n")) {
    const start = offset;
    offset += line.length + 1;
    const trimmed = line.trim();
    if (docString) {
      if (trimmed.startsWith(docString)) docString = null;
      continue;
    }
    if (trimmed.startsWith('"""') || trimmed.startsWith("```")) {
      docString = trimmed.slice(0, 3);
      continue;
    }
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("@")) continue;
    const block = [...dialect.examples, ...dialect.blocks].find((k) => trimmed.startsWith(`${k}:`));
    if (block !== undefined) {
      examples = dialect.examples.includes(block);
      if (!examples) outline = [];
      header = null;
      continue;
    }
    if (trimmed.startsWith("|")) {
      if (!examples) continue;
      const cells = trimmed
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim());
      if (!header) header = cells;
      else if (header.length) {
        const values = new Map(header.map((h, i) => [h, cells[i] ?? ""]));
        for (const step of outline)
          step.matchText = step.text.replace(/<([^<>]+)>/g, (all, name: string) => values.get(name) ?? all);
        // Later examples rows give the same steps: the first one stands for them.
        header = [];
      }
      continue;
    }
    const found = keywords.find((k) => trimmed.startsWith(k.keyword));
    if (!found) continue;
    const rest = trimmed.slice(found.keyword.length);
    const stepText = rest.trim();
    if (!stepText) continue;
    const from =
      start + (line.length - line.trimStart().length) + found.keyword.length + (rest.length - rest.trimStart().length);
    const keyword = found.keyword.trimEnd();
    const step = { from, to: from + stepText.length, keyword, type: found.type, text: stepText, matchText: stepText };
    out.push(step);
    if (step.text.includes("<")) outline.push(step);
  }
  return out;
}

export const matchesStep = (definition: StepDefinition, step: FeatureStep) => definition.regexp.test(step.matchText);

/** The keyword a step's definition is written with: `And`, `But` and `*` continue the previous step's. */
export function definingKeyword(steps: readonly FeatureStep[], step: FeatureStep): "Given" | "When" | "Then" {
  let keyword: "Given" | "When" | "Then" = "Given";
  for (const s of steps) {
    if (s.type === "Given" || s.type === "When" || s.type === "Then") keyword = s.type;
    if (s === step) break;
  }
  return keyword;
}

/** Strings and numbers of a step's text, as Cucumber's snippets turn them into parameters. */
const SNIPPET_PARAMETER = /(^|[^\w.-])("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?\d+\.\d+|-?\d+)(?![\w.])/g;

export type SnippetStyle = "cucumber" | "playwright-bdd" | "java" | "kotlin" | PythonFramework;

const isPython = (style: SnippetStyle): style is PythonFramework => style === "behave" || style === "pytest-bdd";

/** The snippet style of a step definition file. */
export function snippetStyle(path: string, text: string): SnippetStyle {
  if (/\.java$/i.test(path)) return "java";
  if (/\.kts?$/i.test(path)) return "kotlin";
  if (/\.py$/i.test(path)) return pythonFramework(text);
  return /\bcreateBdd\s*\(/.test(text) ? "playwright-bdd" : "cucumber";
}

/** `text` as a Cucumber expression inside a string literal of the snippet's language. */
function expressionText(text: string, style: SnippetStyle): string {
  const escaped = text.replace(/[\\(){}/]/g, "\\\\$&");
  if (style === "java") return escaped.replace(/"/g, '\\"');
  if (style === "kotlin") return escaped.replace(/"/g, '\\"').replace(/\$/g, "\\$");
  return escaped.replace(/'/g, "\\'");
}

/** cucumber-jvm's method name for a step: its words without the parameters, in snake case (camel case in Kotlin). */
function methodName(words: string, style: "java" | "kotlin"): string {
  const parts = words
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (!parts.length) return "step";
  const name =
    style === "java"
      ? parts.join("_")
      : parts[0]! +
        parts
          .slice(1)
          .map((p) => p[0]!.toUpperCase() + p.slice(1))
          .join("");
  return /^\d/.test(name) ? `_${name}` : name;
}

const COMMENT = "// Write code here that turns the phrase above into concrete actions";

/**
 * The step definition Cucumber suggests for an undefined step: its strings and numbers become
 * `{string}`, `{float}` (`{double}` on the JVM) and `{int}` parameters of a pending step.
 * `playwright-bdd` steps take the fixtures first; Java and Kotlin ones are annotated methods,
 * indented for a class body. `body` is the line (0-based) of the snippet the caret goes to.
 */
export function stepSnippet(
  keyword: string,
  text: string,
  style: SnippetStyle = "cucumber",
): { text: string; body: number } {
  if (isPython(style)) return pythonStepSnippet(keyword, text, style);
  const jvm = style === "java" || style === "kotlin";
  const types: string[] = [];
  let expression = "";
  let words = "";
  let last = 0;
  for (const m of text.matchAll(SNIPPET_PARAMETER)) {
    const start = m.index + m[1]!.length;
    const value = m[2]!;
    const type = /^["']/.test(value) ? "string" : value.includes(".") ? (jvm ? "double" : "float") : "int";
    expression += `${expressionText(text.slice(last, start), style)}{${type}}`;
    words += ` ${text.slice(last, start)}`;
    types.push(type);
    last = start + value.length;
  }
  expression += expressionText(text.slice(last), style);
  words += ` ${text.slice(last)}`;
  const seen = new Map<string, number>();
  const names = types.map((type) => {
    const n = (seen.get(type) ?? 0) + 1;
    seen.set(type, n);
    // cucumber-jvm numbers its int and double parameters from 1.
    return type === "string" ? (n === 1 ? type : `${type}${n}`) : jvm ? `${type}${n}` : n === 1 ? type : `${type}${n}`;
  });
  if (style === "java") {
    const javaType: Record<string, string> = { int: "Integer", double: "Double", string: "String" };
    const params = types.map((t, i) => `${javaType[t]} ${names[i]}`).join(", ");
    return {
      text: [
        `    @${keyword}("${expression}")`,
        `    public void ${methodName(words, "java")}(${params}) {`,
        `        ${COMMENT}`,
        "        throw new io.cucumber.java.PendingException();",
        "    }",
        "",
      ].join("\n"),
      body: 3,
    };
  }
  if (style === "kotlin") {
    const kotlinType: Record<string, string> = { int: "Int", double: "Double", string: "String" };
    const params = types.map((t, i) => `${names[i]}: ${kotlinType[t]}`).join(", ");
    return {
      text: [
        `    @${keyword}("${expression}")`,
        `    fun ${methodName(words, "kotlin")}(${params}) {`,
        `        ${COMMENT}`,
        "        throw io.cucumber.java.PendingException()",
        "    }",
        "",
      ].join("\n"),
      body: 3,
    };
  }
  if (style === "playwright-bdd")
    return {
      text: [`${keyword}('${expression}', async (${["{}", ...names].join(", ")}) => {`, `  ${COMMENT}`, "});", ""].join(
        "\n",
      ),
      body: 1,
    };
  return {
    text: [
      `${keyword}('${expression}', async function (${names.join(", ")}) {`,
      `  ${COMMENT}`,
      "  return 'pending';",
      "});",
      "",
    ].join("\n"),
    body: 2,
  };
}

/** A text insertion at an offset of the file. */
export interface Insertion {
  at: number;
  text: string;
}

/**
 * Where a definition goes in a step file: at its end, or before the closing brace of its class
 * for Java and Kotlin, which also get the keyword's `io.cucumber.java.en` import when the file
 * imports others from there. `select` is the body line's range in the file after the insertions.
 */
export function definitionInsertions(
  fileText: string,
  keyword: string,
  snippet: { text: string; body: number },
  style: SnippetStyle,
): { insertions: Insertion[]; select: { line: number; from: number; to: number } } {
  const insertions: Insertion[] = [];
  let at: number;
  let insert: string;
  if (style === "java" || style === "kotlin") {
    const close = fileText.lastIndexOf("}");
    at = close < 0 ? fileText.length : fileText.slice(0, close).trimEnd().length;
    insert = `\n\n${snippet.text.replace(/\n$/, "")}`;
    if (close >= 0 && !fileText.slice(at, close).includes("\n")) insert += "\n";
    const imports = [...fileText.matchAll(/^import\s+io\.cucumber\.java\.en\.(\w+);?[ \t]*$/gm)];
    if (imports.length && !imports.some((m) => m[1] === keyword || m[1] === "*")) {
      const lastImport = imports[imports.length - 1]!;
      const end = lastImport.index + lastImport[0].length;
      const statement = ["import io.cucumber.java.en.", keyword, style === "java" ? ";" : ""].join("");
      insertions.push({ at: end, text: `\n${statement}` });
    }
  } else {
    at = fileText.length;
    const imported = isPython(style) ? pythonImportInsertion(fileText, keyword, style) : null;
    if (imported) insertions.push(imported);
    // Python separates top-level functions with two blank lines.
    const gap = isPython(style) ? "\n\n\n" : "\n\n";
    const ending = /\n*$/.exec(fileText)![0].length;
    const lead = !fileText ? "" : gap.slice(Math.min(ending, gap.length));
    insert = lead + snippet.text;
  }
  insertions.push({ at, text: insert });
  // The snippet's first line, counted in the file after every insertion before it.
  const before = insertions.filter((i) => i.at < at).reduce((n, i) => n + (i.text.split("\n").length - 1), 0);
  const snippetStart = insert.length - insert.trimStart().length;
  const firstLine =
    fileText.slice(0, at).split("\n").length - 1 + before + (insert.slice(0, snippetStart).split("\n").length - 1);
  const bodyText = snippet.text.split("\n")[snippet.body]!;
  const indent = bodyText.length - bodyText.trimStart().length;
  return {
    insertions,
    select: { line: firstLine + snippet.body, from: indent, to: bodyText.length },
  };
}
