/**
 * Python step definitions: behave's `@given('…')` decorators (with its `parse`, `cfparse` and
 * `re` step matchers, switched by `use_step_matcher`) and pytest-bdd's (plain strings matched
 * exactly, `parsers.parse` / `cfparse` / `re`).
 */
import type { StepDefinition } from "./steps";

export type PythonFramework = "behave" | "pytest-bdd";

type Matcher = "parse" | "re" | "string";

/** pytest-bdd when the file imports it; behave otherwise. */
export function pythonFramework(text: string): PythonFramework {
  return /^[ \t]*(?:from|import)[ \t]+pytest_bdd\b/m.test(text) ? "pytest-bdd" : "behave";
}

const DECORATOR = /@(?:given|when|then|step|Given|When|Then|Step)\s*\(\s*/g;
const STEP_MATCHER = /\b(?:use_step_matcher|step_matcher)\s*\(\s*["'](\w+)["']\s*\)/g;
const PARSER = /^(?:parsers\.)?(parse|cfparse|re|string)\s*\(\s*/;

/** The step definitions of a Python file. */
export function pythonStepDefinitions(text: string): StepDefinition[] {
  const framework = pythonFramework(text);
  // behave's matcher in effect from each `use_step_matcher(…)` call on.
  const switches = [...text.matchAll(STEP_MATCHER)].map((m) => ({
    at: m.index,
    matcher: (m[1] === "re" ? "re" : "parse") as Matcher,
  }));
  const out: StepDefinition[] = [];
  for (const m of text.matchAll(DECORATOR)) {
    let at = m.index + m[0].length;
    let matcher: Matcher =
      framework === "pytest-bdd" ? "string" : (switches.filter((s) => s.at < m.index).pop()?.matcher ?? "parse");
    const parser = PARSER.exec(text.slice(at, at + 32));
    if (parser) {
      matcher = parser[1] === "re" ? "re" : parser[1] === "string" ? "string" : "parse";
      at += parser[0].length;
    }
    const literal = readPythonString(text, at);
    if (!literal) continue;
    const regexp = matcherRegExp(literal.value, matcher);
    if (regexp) out.push({ from: at, to: literal.end, source: literal.value, regexp });
  }
  return out;
}

/** A string literal at `at` (an `r`/`u`/`b` prefix and triple quotes included), without f-strings. */
export function readPythonString(text: string, at: number): { value: string; end: number } | null {
  const prefix = /^[rRuUbB]{0,2}/.exec(text.slice(at, at + 2))![0];
  const raw = /r/i.test(prefix);
  let i = at + prefix.length;
  const quote = text[i];
  if (quote !== "'" && quote !== '"') return null;
  const triple = text.startsWith(quote.repeat(3), i);
  const close = triple ? quote.repeat(3) : quote;
  i += close.length;
  let value = "";
  for (; i < text.length; i++) {
    if (text.startsWith(close, i)) return { value, end: i + close.length };
    const c = text[i]!;
    if (c === "\\" && i + 1 < text.length) {
      const next = text[i + 1]!;
      // Raw strings keep the backslash; others resolve the escapes a pattern can contain.
      value += raw ? c + next : next === "\\" || next === "'" || next === '"' ? next : next === "n" ? "\n" : c + next;
      i++;
    } else if (c === "\n" && !triple) return null;
    else value += c;
  }
  return null;
}

function matcherRegExp(value: string, matcher: Matcher): RegExp | null {
  if (matcher === "string") return new RegExp(`^${escapeRe(value)}$`);
  if (matcher === "parse") return parseFormatRegExp(value);
  try {
    // Python's named groups and back-references; steps match the whole text.
    const source = value.replace(/\(\?P<(\w+)>/g, "(?<$1>").replace(/\(\?P=(\w+)\)/g, "\\k<$1>");
    return new RegExp(`^(?:${source})$`);
  } catch {
    return null;
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

const NUMBER = "[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?";

/** The `parse` library's field types (`{count:d}`); others, and untyped fields, match any text. */
const PARSE_TYPES: Record<string, string> = {
  d: "[-+]?\\d+",
  n: "[-+]?\\d[\\d,]*",
  f: NUMBER,
  F: NUMBER,
  e: NUMBER,
  g: NUMBER,
  w: "\\w+",
  W: "\\W+",
  s: "\\s+",
  S: "\\S+",
  D: "\\D+",
  l: "[A-Za-z]+",
};

/**
 * A `parse` format (`there are {count:d} cucumbers`) as an anchored, case-insensitive regular
 * expression, as `parse` matches. `{{` and `}}` are literal braces; cfparse's cardinality
 * (`{names:w+}`) matches any text. Null when a field is not closed.
 */
export function parseFormatRegExp(format: string): RegExp | null {
  let out = "";
  for (let i = 0; i < format.length; i++) {
    const c = format[i]!;
    if ((c === "{" || c === "}") && format[i + 1] === c) {
      out += `\\${c}`;
      i++;
    } else if (c === "{") {
      const end = format.indexOf("}", i);
      if (end < 0) return null;
      const field = format.slice(i + 1, end);
      const spec = field.includes(":") ? field.slice(field.indexOf(":") + 1) : "";
      out += `(${PARSE_TYPES[spec.slice(-1)] && !/[?*+]$/.test(spec) ? PARSE_TYPES[spec.slice(-1)] : ".+?"})`;
      i = end;
    } else out += escapeRe(c);
  }
  try {
    return new RegExp(`^${out}$`, "i");
  } catch {
    return null;
  }
}

/**
 * The pending definition behave or pytest-bdd suggests for an undefined step, at the top level
 * of the module. `body` is the line (0-based) the caret goes to.
 */
export function pythonStepSnippet(
  keyword: string,
  text: string,
  framework: PythonFramework,
): { text: string; body: number } {
  const decorator = keyword.toLowerCase();
  const quoted = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  if (framework === "pytest-bdd")
    return {
      text: [`@${decorator}(${quoted(text)})`, "def _():", "    raise NotImplementedError", ""].join("\n"),
      body: 2,
    };
  // behave reads the pattern as a `parse` format: braces in the step are literal.
  const format = text.replace(/[{}]/g, "$&$&");
  return {
    text: [
      `@${decorator}(${quoted(format)})`,
      "def step_impl(context):",
      `    raise NotImplementedError(${quoted(`STEP: ${keyword} ${text}`)})`,
      "",
    ].join("\n"),
    body: 2,
  };
}

/** The `from behave import …` (or `pytest_bdd`) line's insertion that adds `keyword`, if one is missing. */
export function pythonImportInsertion(
  fileText: string,
  keyword: string,
  framework: PythonFramework,
): { at: number; text: string } | null {
  const module = framework === "pytest-bdd" ? "pytest_bdd" : "behave";
  const line = new RegExp(`^from[ \\t]+${module}[ \\t]+import[ \\t]+([\\w ,\\t]+?)[ \\t]*$`, "m").exec(fileText);
  if (!line) return null;
  const names = line[1]!.split(",").map((n) => n.trim());
  const name = keyword.toLowerCase();
  if (names.includes(name) || names.includes("*")) return null;
  return { at: line.index + line[0].length, text: `, ${name}` };
}
