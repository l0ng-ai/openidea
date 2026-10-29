// @vitest-environment node
/**
 * Keeps the source-text catalogs (`locales/text/<locale>.json`) in step with the
 * English text written at call sites. Their keys are the English text itself, so
 * rewording a string at its call site silently drops its translation; these tests
 * fail instead, and also on catalog entries whose text no longer exists.
 *
 * Text counts as translatable when it is a literal (or a branch of `?:` / `??` /
 * `||` around one) that reaches the translation layer directly:
 *   - the first argument of `tx` / `txTemplate`, or of a function bound from
 *     `useTx()` / `useTxTemplate()` in the same file;
 *   - the plain-text children of `<T>` and the other `TEXT_CHILDREN` primitives;
 *   - a `TEXT_PROPS` attribute of a component (`<Row hint="…">`), and `data-tooltip`;
 *   - a `TEXT_PROPS` property of an object literal (`{ label: "…" }`): actions, menu
 *     items, select options, dialogs, notifications, settings pages, tool windows;
 *   - the text arguments of `showHint` and `showError`.
 * Text built at runtime is written with the `tx` tag (`` tx`Cannot open ${path}` ``),
 * which looks up `"Cannot open {path}"`; untagged template literals are checked
 * where the text is matched against `{name}` templates (`txTemplate`, hints,
 * notification titles). Elsewhere the lookup is exact, so an untagged template
 * literal can never be translated: it fails here unless `TEMPLATES_AS_WRITTEN` lists
 * it. Tagged or matched text must not splice in English words to be read as part of
 * the sentence (`${kind.toLowerCase()}`, `${n === 1 ? "" : "s"}`): those need one
 * text per variant.
 *
 * Not seen: text kept in a variable or built by a helper before it reaches `tx`,
 * and text sent by the backend. Their entries count as used (not stale) as long as
 * the text appears as a literal anywhere in `src/`, the Rust crates or `languages/`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TEXT_DIR = new URL("./text/", import.meta.url);

/** Props / object keys whose string value the UI passes through `tx`. */
const TEXT_PROPS = new Set([
  "aria-label",
  "body",
  "cancelLabel",
  "category",
  "checkbox",
  "description",
  "detail",
  "emptyLabel",
  "hint",
  "label",
  "message",
  "ok",
  "okLabel",
  "placeholder",
  "text",
  "title",
  "tooltip",
]);

/** Components whose plain-text children are translated. */
const TEXT_CHILDREN = new Set(["T", "Button", "Dialog"]);

const HINTS = new Set(["showHint"]);
const ERRORS = new Set(["showError"]);
const NOTIFY = new Set(["notify"]);

/** Code templates shown as written, and the in-memory backends of plain-browser development. */
const UNCHECKED_FILES = new Set([
  "src/editor/core/backend.ts",
  "src/features/plugins/backend.ts",
  "src/features/tools/backend.ts",
  "src/features/templates/files/builtins.ts",
  "src/features/templates/live/builtins.ts",
  "src/features/templates/live/surrounders.ts",
  "src/features/templates/postfix/model.ts",
]);

/** Entries for text the code assembles from parts, which no literal spells out. */
const BUILT_AT_RUNTIME = new Set<string>([]);

/** Text that stays as written in every locale: names, code, formats, shortcuts. */
const UNTRANSLATED = new Set<string>([
  // SSH and run-target placeholders
  "SSH",
  "example.com",
  "java",
  "node",
  "python3",
  // Products, tools and formats
  "Amazon Aurora MySQL",
  "Amazon Redshift",
  "basedpyright",
  "Cargo Check",
  "Clippy",
  "CockroachDB",
  "CodeLLDB",
  "CodeLLDB (Rust, C, C++)",
  "CSV",
  "debugpy",
  "debugpy (Python)",
  "Delve",
  "Delve (Go)",
  "Docker",
  "Docker Compose",
  "Dockerfile",
  "Eclipse",
  "Eclipse (macOS)",
  "Eclipse Temurin",
  "EditorConfig",
  "Git",
  "GitHub",
  "Go",
  "Godot",
  "Gradle",
  "Greenplum",
  "Java",
  "java-debug (Java)",
  "js-debug (Node.js / TypeScript)",
  "JSON",
  "lldb-dap (C, C++, Swift)",
  "MariaDB",
  "Markdown",
  "Maven",
  "MySQL",
  "Neon",
  "Node.js",
  "npm",
  "OpenIDEA",
  "Spring Boot",
  "PostgreSQL",
  "Pyright",
  "pytest",
  "Rust",
  "Rustfmt",
  "SingleStore",
  "SQLite",
  "Supabase",
  "TiDB",
  "TimescaleDB",
  "TSV",
  "ty",
  "TypeScript",
  "Vim",
  "YugabyteDB",
  // Key names, shortcuts and terms that read the same in Chinese UIs
  "<null>",
  "Backspace",
  "Code Vision",
  "Enter",
  "Fixup",
  "Fixup…",
  "IDE",
  "mod tests",
  "Windows (\\r\\n)",
  // Language names, written in their own language
  "English",
  "简体中文 (Chinese, Simplified)",
  // Terms, keywords and acronyms kept in English
  "DDL",
  "GOPATH",
  "GOROOT",
  "HEAD",
  "HTTP",
  "JDK",
  "JDK 1.4.x",
  "JDK 5 - 8",
  "LTS",
  "NULL",
  "ORDER BY",
  "SDK",
  "SOCKS",
  "SSH/SSL",
  "SSL",
  "TODO",
  "URL",
  "VCS",
  "WHERE",
  "WIP",
  // Code, commands and example values
  '"value"',
  "at org.example.",
  "bastion.example.com",
  "build --info",
  "className()",
  "clean install -DskipTests",
  "com.example.Service#process, main.run, parse",
  "docker-compose.yml; docker-compose.override.yml",
  "file:src//*&&!file:*test*",
  "git pull --no-rebase --ff",
  "git pull --rebase",
  "go env GOPATH",
  "kebab-case",
  "KEY=value; OTHER=value",
  "NAME",
  "NAME=value; OTHER=value",
  "node_modules/typescript",
  "PascalCase",
  "pyproject.toml, .git",
  "ruff server",
  "run pytest",
  "snake_case",
  "tests",
  '{ "section": { "key": "value" } }',
  // Identifiers that only look like text: icon names, error codes, categories, console output
  "app",
  "cancelled",
  "fileTypes/text",
  "info",
  "languageServer",
  "process",
  "Running processes requires the desktop app.\n",
  "text",
]);

/**
 * Template literals that reach an exact lookup on purpose: the text around the
 * values is code or a format that reads the same in every locale.
 */
const TEMPLATES_AS_WRITTEN = new Set<string>([
  "{name} (#[cfg(test)])", // Rust attribute after a module name
  "HEAD ({renamedFrom})", // Git revision and a path
]);

/**
 * How a text is found in a catalog: as written (`exact`), by matching `{name}`
 * templates (`pattern`, see `txTemplate`), or by its literal parts (`shape`, the `tx` tag).
 */
type Match = "exact" | "pattern" | "shape";

interface Use {
  text: string;
  at: string;
  match: Match;
}

function walk(dir: string, accept: (path: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "target") walk(path, accept, out);
    } else if (accept(path)) out.push(path);
  }
  return out;
}

const isTest = (path: string) => /\.test\.tsx?$|\/__tests__\/|\/src\/test\//.test(path);

const ENTITIES: Record<string, string> = { amp: "&", apos: "'", quot: '"', lt: "<", gt: ">", nbsp: "\u00a0" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#")
      return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e] ?? m;
  });
}

/** JSX text as React renders it: lines trimmed, blank ones dropped, the rest joined with a space. */
function jsxText(raw: string): string {
  const lines = raw.split(/\r?\n/);
  if (lines.length === 1) return decodeEntities(raw).trim();
  return decodeEntities(
    lines
      .map((l) => l.trim())
      .filter(Boolean)
      .join(" "),
  );
}

const unwrap = (e: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(e) ? unwrap(e.expression) : e);

/**
 * Template literal text with each `${expr}` as `{name}`; a `${c ? "a" : "b"}` part
 * yields one text per branch (`Formatted {n} line` / `Formatted {n} lines`).
 */
function templateTexts(node: ts.TemplateExpression): string[] {
  let out = [node.head.text];
  for (const span of node.templateSpans) {
    const branches = stringBranches(span.expression);
    const parts = branches ?? [placeholder(span.expression)];
    out = out.flatMap((head) => parts.map((part) => head + part + span.literal.text));
  }
  return out;
}

/** Text of a `tx` tag as it looks it up: every `${expr}` is a placeholder. */
function tagText(node: ts.TemplateLiteral): string {
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return node.head.text + node.templateSpans.map((s) => placeholder(s.expression) + s.literal.text).join("");
}

function placeholder(e: ts.Expression): string {
  const words = e.getText().match(/[A-Za-z_]\w*/g) ?? ["value"];
  return `{${words[words.length - 1]}}`;
}

/** The branches of `c ? "a" : "b"`. */
function stringBranches(expr: ts.Expression): string[] | undefined {
  const e = unwrap(expr);
  if (!ts.isConditionalExpression(e)) return undefined;
  const [a, b] = [unwrap(e.whenTrue), unwrap(e.whenFalse)];
  return ts.isStringLiteralLike(a) && ts.isStringLiteralLike(b) ? [a.text, b.text] : undefined;
}

/** A value that changes the case of English text, to splice it into a sentence. */
function changesCase(expr: ts.Expression): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAccessExpression(n) && /^to(Lower|Upper)Case$/.test(n.name.text)) found = true;
    ts.forEachChild(n, visit);
  };
  visit(expr);
  return found;
}

/** `{anything}` → `{}`, so templates compare regardless of placeholder names. */
const shape = (text: string) => text.replace(/\{[^{}]*\}/g, "{}");

const tagName = (node: ts.JsxOpeningLikeElement) => node.tagName.getText();

const isComponent = (tag: string) => /^[A-Z]/.test(tag) || tag.includes(".");

/** Climbs through expressions that pass a string operand through unchanged. */
function passThrough(node: ts.Node): ts.Node {
  let n = node;
  for (;;) {
    const p = n.parent;
    if (
      p &&
      (ts.isParenthesizedExpression(p) ||
        ts.isAsExpression(p) ||
        ts.isSatisfiesExpression(p) ||
        (ts.isConditionalExpression(p) && p.condition !== n) ||
        (ts.isBinaryExpression(p) &&
          (p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
            p.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
            (p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && p.right === n))))
    ) {
      n = p;
      continue;
    }
    return n;
  }
}

function propName(name: ts.PropertyName | ts.JsxAttributeName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

type Sink = "exact" | "template";

const isCallTo = (call: ts.CallExpression, names: Set<string>) => {
  const callee = call.expression;
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
  return names.has(name);
};

/**
 * How the text at `node` is translated: `exact` (catalog lookup of the whole
 * text), `template` (also matches `{name}` templates, see `txTemplate`), or not at all.
 */
function sinkOf(node: ts.Node, exact: Set<string>, template: Set<string>): Sink | undefined {
  const top = passThrough(node);
  const p = top.parent;
  if (!p) return undefined;
  if (ts.isCallExpression(p)) {
    const i = p.arguments.indexOf(top as ts.Expression);
    if (i === 0 && isCallTo(p, template)) return "template";
    if (i === 0 && isCallTo(p, exact)) return "exact";
    if (i === 1 && isCallTo(p, HINTS)) return "template";
    if (i >= 0 && i <= 1 && isCallTo(p, ERRORS)) return "exact";
    return undefined;
  }
  if (ts.isPropertyAssignment(p)) {
    const name = propName(p.name) ?? "";
    if (p.initializer !== top || !TEXT_PROPS.has(name)) return undefined;
    const call = p.parent.parent;
    // Notification titles go through `txTemplate`.
    if (name === "title" && ts.isCallExpression(call) && isCallTo(call, NOTIFY)) return "template";
    return "exact";
  }
  let attr: ts.Node = p;
  if (ts.isJsxExpression(p)) {
    if (ts.isJsxElement(p.parent)) return TEXT_CHILDREN.has(tagName(p.parent.openingElement)) ? "exact" : undefined;
    attr = p.parent;
  }
  if (ts.isJsxAttribute(attr)) {
    const name = propName(attr.name) ?? "";
    if (name === "data-tooltip") return "exact";
    return TEXT_PROPS.has(name) && isComponent(tagName(attr.parent.parent)) ? "exact" : undefined;
  }
  if (ts.isJsxElement(p)) return TEXT_CHILDREN.has(tagName(p.openingElement)) ? "exact" : undefined;
  return undefined;
}

interface Scan {
  /** Literals that reach the translation layer. */
  translated: Use[];
  /** Every string literal and JSX text, in shape form. */
  literals: Set<string>;
  /** Template literals that reach an exact lookup, which can never match them. */
  untranslatable: Use[];
  /** Translated templates that splice English words into the sentence. */
  spliced: Use[];
}

function scanTypeScript(): Scan {
  const translated: Use[] = [];
  const untranslatable: Use[] = [];
  const spliced: Use[] = [];
  const literals = new Set<string>();
  const files = walk(`${ROOT}src`, (p) => /\.tsx?$/.test(p) && !isTest(p) && !p.endsWith("/bindings.ts"));
  for (const file of files) {
    const path = file.slice(ROOT.length);
    const source = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const exact = new Set(["tx"]);
    const template = new Set(["txTemplate"]);
    for (const m of source.matchAll(/(?:const|let)\s+(\w+)\s*=\s*useTx(Template)?\(\)/g))
      (m[2] ? template : exact).add(m[1]!);
    const checked = !UNCHECKED_FILES.has(path);
    const where = (node: ts.Node) => `${path}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
    const visit = (node: ts.Node) => {
      if (checked && ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && exact.has(node.tag.text)) {
        // Without `${}` the tag looks its text up as written.
        const match = ts.isNoSubstitutionTemplateLiteral(node.template) ? "exact" : "shape";
        const use: Use = { text: tagText(node.template), at: where(node), match };
        translated.push(use);
        if (
          ts.isTemplateExpression(node.template) &&
          node.template.templateSpans.some((s) => stringBranches(s.expression) || changesCase(s.expression))
        )
          spliced.push(use);
      }
      let texts: string[] | undefined;
      if (ts.isStringLiteral(node) && ts.isJsxAttribute(node.parent)) texts = [decodeEntities(node.text)];
      else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) texts = [node.text];
      else if (ts.isTemplateExpression(node)) texts = templateTexts(node);
      else if (ts.isJsxText(node)) texts = [jsxText(node.text)].filter(Boolean);
      if (texts) {
        for (const text of texts) {
          literals.add(shape(text));
          literals.add(shape(text.trim()));
        }
        const sink = checked ? sinkOf(node, exact, template) : undefined;
        if (sink) {
          const at = where(node);
          if (!ts.isTemplateExpression(node)) for (const text of texts) translated.push({ text, at, match: "exact" });
          else if (sink === "exact") for (const text of texts) untranslatable.push({ text, at, match: "exact" });
          else {
            for (const text of texts) translated.push({ text, at, match: "pattern" });
            if (node.templateSpans.some((s) => changesCase(s.expression)))
              spliced.push({ text: texts[0]!, at, match: "pattern" });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { translated, literals, untranslatable, spliced };
}

/** String literals of the Rust crates and language definitions (backend messages). */
function scanBackend(literals: Set<string>) {
  const files = [
    ...walk(`${ROOT}crates`, (p) => p.endsWith(".rs")),
    ...walk(`${ROOT}src-tauri/src`, (p) => p.endsWith(".rs")),
    ...walk(`${ROOT}languages`, (p) => p.endsWith(".toml")),
  ];
  for (const file of files)
    for (const m of readFileSync(file, "utf8").matchAll(/"((?:[^"\\]|\\.)*)"/g)) literals.add(shape(m[1]!));
}

/** Text that needs no translation: no words, a path / glob / option, or listed in `UNTRANSLATED`. */
function needsTranslation(text: string): boolean {
  if (UNTRANSLATED.has(text)) return false;
  const words = text.replace(/\{[^{}]*\}/g, "");
  if (!/[A-Za-z]{2}/.test(words)) return false;
  return !/^[-.*~/$#@]|:\/\//.test(words);
}

const scan = scanTypeScript();
scanBackend(scan.literals);

const catalogs = Object.fromEntries(
  readdirSync(TEXT_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => [f.slice(0, -5), JSON.parse(readFileSync(new URL(f, TEXT_DIR), "utf8")) as Record<string, string>]),
);

/** `{name}` templates of a catalog, as `txTemplate` matches them. */
function templatePatterns(catalog: Record<string, string>): RegExp[] {
  return Object.keys(catalog)
    .filter((key) => /\{\w+\}/.test(key))
    .map((key) => {
      const parts = key.split(/\{\w+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      return new RegExp(`^${parts.join("(.+?)")}$`, "s");
    });
}

const report = (uses: Use[]) =>
  [...new Map(uses.map((u) => [u.at, u.text]))].map(([at, text]) => `${at}  ${JSON.stringify(text)}`);

it("passes no template literal UI text to an exact lookup; tag it as tx`…`", () => {
  expect(
    report(scan.untranslatable.filter(({ text }) => needsTranslation(text) && !TEMPLATES_AS_WRITTEN.has(text))),
  ).toEqual([]);
});

it("translates built text as whole sentences, one per variant", () => {
  expect(report(scan.spliced)).toEqual([]);
});

describe.each(Object.keys(catalogs))("source-text catalog %s", (locale) => {
  const catalog = catalogs[locale]!;
  const patterns = templatePatterns(catalog);
  const shapes = new Set(Object.keys(catalog).map(shape));
  const has = (text: string) => Object.hasOwn(catalog, text);
  // Placeholders of the source stand for any text, as the runtime values would.
  const matchesTemplate = (text: string) => patterns.some((p) => p.test(text.replace(/\{[^{}]*\}/g, "\u0001")));
  const found = ({ text, match }: Use) =>
    has(text) || (match === "pattern" && matchesTemplate(text)) || (match === "shape" && shapes.has(shape(text)));

  it("translates every literal UI text", () => {
    const missing = new Map<string, string>();
    for (const use of scan.translated)
      if (!found(use) && needsTranslation(use.text) && !missing.has(use.text)) missing.set(use.text, use.at);
    expect([...missing].map(([text, at]) => `${at}  ${JSON.stringify(text)}`)).toEqual([]);
  });

  it("has one entry per template, whatever its placeholder names", () => {
    const byShape = new Map<string, string[]>();
    for (const key of Object.keys(catalog))
      if (/\{\w+\}/.test(key)) byShape.set(shape(key), [...(byShape.get(shape(key)) ?? []), key]);
    expect([...byShape.values()].filter((keys) => keys.length > 1)).toEqual([]);
  });

  it("has no entries whose text no longer appears in the source", () => {
    const stale = Object.keys(catalog).filter((key) => !scan.literals.has(shape(key)) && !BUILT_AT_RUNTIME.has(key));
    expect(stale).toEqual([]);
  });
});
