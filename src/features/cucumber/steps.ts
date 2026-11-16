/**
 * Cucumber steps, both sides: the step definitions of JavaScript / TypeScript files
 * (`Given('a {int} item cart', …)` of `@cucumber/cucumber`, `playwright-bdd`'s `createBdd()`
 * functions) and the steps of Gherkin `.feature` files, with Cucumber expression and regular
 * expression matching between them.
 */

/** A step definition: the pattern literal of a `Given` / `When` / `Then` / `Step` call. */
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
  keyword: string;
  /** The text as written. */
  text: string;
  /** The text matched against definitions: Scenario Outline placeholders take the first example's values. */
  matchText: string;
}

const DEFINE = /\b(?:Given|When|Then|And|But|Step|defineStep)\s*(?:<[^<>()]*>\s*)?\(\s*/g;

/** The step definitions of a script. */
export function stepDefinitions(text: string): StepDefinition[] {
  const out: StepDefinition[] = [];
  for (const m of text.matchAll(DEFINE)) {
    const at = m.index + m[0].length;
    const literal = readLiteral(text, at);
    if (!literal) continue;
    const regexp = literal.regexp ?? expressionRegExp(literal.value);
    if (regexp) out.push({ from: at, to: literal.end, source: literal.value, regexp });
  }
  return out;
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

const STEP = /^(\s*)(Given|When|Then|And|But|\*)(\s+)(\S.*?)\s*$/;
const BLOCK = /^\s*(Feature|Rule|Background|Scenario|Scenario Outline|Scenario Template|Example|Examples|Scenarios):/;

/** The steps of a feature file (English keywords), placeholders filled from each outline's first example. */
export function featureSteps(text: string): FeatureStep[] {
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
    const block = BLOCK.exec(line);
    if (block) {
      examples = block[1] === "Examples" || block[1] === "Scenarios";
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
    const m = STEP.exec(line);
    if (!m) continue;
    const from = start + m[1]!.length + m[2]!.length + m[3]!.length;
    const step = { from, to: from + m[4]!.length, keyword: m[2]!, text: m[4]!, matchText: m[4]! };
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
    if (s.keyword === "Given" || s.keyword === "When" || s.keyword === "Then") keyword = s.keyword;
    if (s === step) break;
  }
  return keyword;
}

/** Strings and numbers of a step's text, as Cucumber's snippets turn them into parameters. */
const SNIPPET_PARAMETER = /(^|[^\w.-])("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?\d+\.\d+|-?\d+)(?![\w.])/g;

/** `text` as a Cucumber expression inside a single-quoted JavaScript string. */
const expressionText = (text: string) => text.replace(/[\\(){}/]/g, "\\\\$&").replace(/'/g, "\\'");

/**
 * The step definition Cucumber suggests for an undefined step: its strings and numbers become
 * `{string}`, `{float}` and `{int}` parameters of a pending step. `playwright-bdd` steps take
 * the fixtures first. `body` is the line (0-based) of the snippet the caret goes to.
 */
export function stepSnippet(
  keyword: string,
  text: string,
  style: "cucumber" | "playwright-bdd" = "cucumber",
): { text: string; body: number } {
  const types: string[] = [];
  let expression = "";
  let last = 0;
  for (const m of text.matchAll(SNIPPET_PARAMETER)) {
    const start = m.index + m[1]!.length;
    const value = m[2]!;
    const type = /^["']/.test(value) ? "string" : value.includes(".") ? "float" : "int";
    expression += `${expressionText(text.slice(last, start))}{${type}}`;
    types.push(type);
    last = start + value.length;
  }
  expression += expressionText(text.slice(last));
  const seen = new Map<string, number>();
  const names = types.map((type) => {
    const n = (seen.get(type) ?? 0) + 1;
    seen.set(type, n);
    return n === 1 ? type : `${type}${n}`;
  });
  const comment = "  // Write code here that turns the phrase above into concrete actions";
  if (style === "playwright-bdd")
    return {
      text: [`${keyword}('${expression}', async (${["{}", ...names].join(", ")}) => {`, comment, "});", ""].join("\n"),
      body: 1,
    };
  return {
    text: [
      `${keyword}('${expression}', async function (${names.join(", ")}) {`,
      comment,
      "  return 'pending';",
      "});",
      "",
    ].join("\n"),
    body: 2,
  };
}
