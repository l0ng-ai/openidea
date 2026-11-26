/**
 * Name suggestions for Introduce Variable / Constant without a language
 * server, after IDEA: from the callee (`getUser()` → `user`), the constructed
 * type (`new StringBuilder()` → `stringBuilder`, `builder`), the accessed
 * property, the literal kind (`s`, `i`, `b`…). Purely textual; callers drop
 * names already used in the file.
 */

export type NameStyle = "camel" | "snake";

const SNAKE = new Set(["python", "ruby", "rust", "elixir", "c", "zig", "lua"]);

export function nameStyle(language: string): NameStyle {
  return SNAKE.has(language) ? "snake" : "camel";
}

const KEYWORDS = new Set(
  (
    "abstract and as assert async await begin bool boolean break byte case catch char class const continue def default " +
    "defer del delete do double elif else elsif end ensure enum except export extends extern false final finally float fn " +
    "for from func function global go goto if impl import in instanceof int interface is lambda let local long loop match " +
    "mod module mut native new nil none not null of or package pass private protected public raise rescue return " +
    "self short static struct super switch synchronized then this throw throws trait true try typeof undefined " +
    "unless until use val var void volatile when where while with yield"
  ).split(" "),
);

const STRIP_PREFIXES = [
  "get",
  "to",
  "as",
  "create",
  "new",
  "make",
  "build",
  "find",
  "fetch",
  "load",
  "read",
  "compute",
  "calculate",
];
const BOOL_PREFIXES = ["is", "has", "can", "should"];

/** `getUserName` / `get_user_name` / `UserName` → `["get", "user", "name"]`. */
export function splitWords(identifier: string): string[] {
  return identifier
    .replace(/^[$@]+/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

function join(words: string[], style: NameStyle | "constant"): string {
  if (style === "constant") return words.map((w) => w.toUpperCase()).join("_");
  if (style === "snake") return words.join("_");
  return words.map((w, i) => (i === 0 ? w : w[0]!.toUpperCase() + w.slice(1))).join("");
}

/** Every suffix of the word list, longest first: `[string, builder]` → `stringBuilder`, `builder`. */
function suffixes(words: string[]): string[][] {
  return words.map((_, i) => words.slice(i));
}

/** Strips one balanced bracket group ending at `end` (exclusive); returns its start or -1. */
function openingBracket(text: string, end: number, open: string, close: string): number {
  let depth = 0;
  for (let i = end - 1; i >= 0; i--) {
    const c = text[i];
    if (c === close) depth++;
    else if (c === open && --depth === 0) return i;
  }
  return -1;
}

/** Last identifier segment of a callee / member chain (`a.b::c->d` → `d`). */
function lastSegment(path: string): string | null {
  const m = /([A-Za-z_$][\w$]*)\s*$/.exec(path.replace(/::<[^>]*>\s*$/, "").replace(/<[^<>()]*>\s*$/, ""));
  return m ? m[1]! : null;
}

function singular(word: string): string | null {
  if (/ies$/.test(word)) return word.slice(0, -3) + "y";
  if (/(ss|us)$/.test(word)) return null;
  if (/(sh|ch|x)es$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word) && word.length > 2) return word.slice(0, -1);
  return null;
}

export interface SuggestInput {
  /** Syntax node kind of the expression. */
  kind: string;
  text: string;
  language: string;
  constant?: boolean;
}

/** Word lists, best first. */
function wordCandidates(kind: string, raw: string, language: string): string[][] {
  let text = raw.trim();
  // Unwrap what does not change the value's nature.
  for (;;) {
    const before = text;
    text = text
      .replace(/^(await|try[!?]?)\s+/, "")
      .replace(/(\?|!!|!)$/, "")
      .replace(/\.(unwrap|expect|unwrap_or_default|clone|to_owned)\([^()]*\)$/, "")
      .trim();
    if (text.startsWith("(") && openingBracket(text, text.length, "(", ")") === 0) text = text.slice(1, -1).trim();
    if (text === before) break;
  }

  // Literals.
  const str = /^(?:[rbuRBUfF]{0,2})(["'`])([\s\S]*)\1$/.exec(text) ?? /^@?"([\s\S]*)"$/.exec(text);
  if (
    /char/.test(kind) ||
    (/^'.'$|^'\\.'$/.test(text) &&
      ![
        "python",
        "javascript",
        "typescript",
        "javascriptreact",
        "typescriptreact",
        "ruby",
        "php",
        "lua",
        "elixir",
        "dart",
      ].includes(language))
  ) {
    return [["c"], ["ch"]];
  }
  if (/string|encapsed|template|heredoc/.test(kind) || (str && /literal|string/.test(kind))) {
    const content = str ? str[str.length - 1]! : "";
    const words = /^[A-Za-z][A-Za-z0-9 _-]{0,40}$/.test(content.trim()) ? splitWords(content.trim()) : [];
    return [...(words.length && words.length <= 3 ? [words] : []), ["s"], ["text"]];
  }
  if (/^-?\s*(\d[\d_]*|0[xXbBoO][\da-fA-F_]+)[lLuU]*$/.test(text)) return [["i"], ["value"]];
  if (/^-?\s*(\d[\d_]*)?\.?\d[\d_]*([eE][+-]?\d+)?[fFdDmM]?$/.test(text)) return [["value"], ["v"]];
  if (/^(true|false|True|False|YES|NO)$/.test(text)) return [["b"], ["flag"]];
  if (/^(null|nil|None|undefined|nullptr)$/.test(text)) return [["value"]];
  if (/^\[[\s\S]*\]$/.test(text) || /^(vec!|listOf|arrayOf|mutableListOf|List\.of|Arrays\.asList)/.test(text))
    return [["list"], ["items"]];
  if (/^\{[\s\S]*\}$/.test(text) && /object|dictionary|hash|map/.test(kind)) {
    return language === "python" ? [["data"], ["mapping"]] : [["obj"], ["data"]];
  }
  if (/lambda|arrow|closure|function|anonymous/.test(kind)) return [["fn"], ["callback"]];

  // Construction: `new Foo<T>(…)`, `Foo(…)`, `Foo::new(…)`, `&Foo { … }`.
  const ctor =
    /^new\s+([\w$.]+)/.exec(text) ??
    /^&?(?:mut\s+)?([A-Z][\w$]*)(?:::(?:new|default|from|with_\w+|create|of))?\s*(?:::<[^>]*>)?\s*[({]/.exec(text) ??
    /^([\w$.]*\.)?([A-Z][\w$]*)\.(?:of|from|valueOf|newInstance|create|getInstance)\s*\(/.exec(text);
  if (ctor) {
    const type = lastSegment(ctor[ctor.length - 1]!) ?? "";
    const words = splitWords(type).filter((w) => w !== "new");
    if (words.length) return suffixes(words);
  }

  // Calls: the last top-level argument list.
  if (text.endsWith(")")) {
    const open = openingBracket(text, text.length, "(", ")");
    if (open > 0) {
      const callee = text.slice(0, open).trim();
      const name = lastSegment(callee);
      if (name) {
        const words = splitWords(name);
        const out: string[][] = [];
        if (words.length > 1 && BOOL_PREFIXES.includes(words[0]!)) out.push(...suffixes(words.slice(1)), words);
        else if (words.length > 1 && STRIP_PREFIXES.includes(words[0]!)) out.push(...suffixes(words.slice(1)));
        else if (words.length === 1 && (STRIP_PREFIXES.includes(words[0]!) || words[0] === "new")) {
          // `map.get(k)`, `Foo.create()`: name after the receiver.
          const receiver = lastSegment(callee.slice(0, callee.length - name.length).replace(/(\.|::|->|\?\.)\s*$/, ""));
          const sing = receiver ? singular(splitWords(receiver).pop() ?? "") : null;
          if (sing) out.push([sing]);
          else if (receiver && /^[A-Z]/.test(receiver)) out.push(...suffixes(splitWords(receiver)));
          else if (!["get", "new", "to", "as"].includes(words[0]!)) out.push(words);
        } else out.push(...suffixes(words));
        out.push(["value"]);
        return out;
      }
    }
  }

  // Index access: `items[i]` → `item`.
  if (text.endsWith("]")) {
    const open = openingBracket(text, text.length, "[", "]");
    if (open > 0) {
      const base = lastSegment(text.slice(0, open));
      const last = base ? splitWords(base).pop() : undefined;
      const sing = last ? singular(last) : null;
      return [...(sing ? [[sing]] : []), ["item"], ["element"]];
    }
  }

  // Comparisons / boolean operators.
  if (
    /comparison|boolean_operator|not_operator|logical/.test(kind) ||
    /(==|!=|<=|>=|&&|\|\||\s<\s|\s>\s|\bnot\b|\band\b|\bor\b|^!)/.test(text)
  ) {
    if (!/[=!]~|=>/.test(text)) return [["b"], ["flag"]];
  }

  // Member access / plain identifiers: `a.b.userName` → `userName`, `name`.
  const member = /(?:^|\.|::|->|\?\.)\s*\$?([A-Za-z_][\w]*)$/.exec(text);
  if (member && !/[\s+\-*/%^|&(),]/.test(text.replace(/\s*(\.|::|->|\?\.)\s*/g, "."))) {
    const words = splitWords(member[1]!);
    if (words.length > 1 && STRIP_PREFIXES.includes(words[0]!)) return [...suffixes(words.slice(1)), ["value"]];
    return [...suffixes(words), ["value"]];
  }
  if (/^["'`]/.test(text) || /\+\s*["'`]|["'`]\s*\+/.test(text)) return [["s"], ["text"]];
  return [["value"]];
}

/**
 * Suggested names, best first and distinct; at least one. Keywords and
 * non-identifiers are dropped. `constant` gives UPPER_SNAKE_CASE.
 */
export function suggestNames(input: SuggestInput): string[] {
  const style = input.constant ? "constant" : nameStyle(input.language);
  const out: string[] = [];
  for (const words of wordCandidates(input.kind, input.text, input.language)) {
    if (!words.length) continue;
    const name = join(words, style);
    if (!isIdentifier(name) || KEYWORDS.has(name.toLowerCase()) || out.includes(name)) continue;
    out.push(name);
  }
  if (!out.length) out.push(input.constant ? "VALUE" : "value");
  return out;
}

export function isIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

export function isKeyword(name: string): boolean {
  return KEYWORDS.has(name.toLowerCase());
}

/**
 * Drops names `taken` reports as used; when every suggestion is taken, numbers
 * the first one (`user1`, `user2`…).
 */
export async function uniqueNames(names: string[], taken: (name: string) => Promise<boolean>): Promise<string[]> {
  const used = await Promise.all(names.map((n) => taken(n).catch(() => true)));
  const free = names.filter((_, i) => !used[i]);
  if (free.length) return free;
  const base = names[0]!;
  for (let i = 1; i < 100; i++) {
    const n = `${base}${i}`;
    // oxlint-disable-next-line no-await-in-loop -- numbered names are tried in order; stop at the first free one
    if (!(await taken(n).catch(() => true))) return [n];
  }
  return [base];
}
