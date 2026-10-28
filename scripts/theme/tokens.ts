/**
 * The themeable design tokens, read from `src/styles/tokens.css`: every
 * variable of the `:root[data-theme="light"]` block (it redefines each colour
 * token of the dark `:root`), grouped by the block's section comments.
 * Sections named in `SCHEME_GROUPS` belong in a theme's editor colour scheme
 * file, the rest in its UI theme file. Pure functions: no Node APIs.
 */

export interface ThemeToken {
  name: string;
  /** Islands Dark value (`:root`). */
  dark: string;
  /** Islands Light value. */
  light: string;
}

export interface TokenGroup {
  /** Section comment of tokens.css, without its parenthetical. */
  title: string;
  /** True when the group belongs in the editor colour scheme file. */
  scheme: boolean;
  tokens: ThemeToken[];
}

/** tokens.css sections that IntelliJ keeps in an editor scheme (`.icls`). */
export const SCHEME_GROUPS = ["syntax", "editor", "ANSI palette", "terminal ANSI palette"];

const LIGHT_SELECTOR = ':root[data-theme="light"]';

/** Raw bodies (comments kept) of top-level rules whose selector list is exactly `selector`. */
function ruleBodies(css: string, selector: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let head = "";
  for (let i = 0; i < css.length; i++) {
    if (css.startsWith("/*", i)) {
      const end = css.indexOf("*/", i + 2);
      i = end < 0 ? css.length : end + 1;
      continue;
    }
    const ch = css[i];
    if (ch === "{") {
      if (depth === 0) {
        head = css
          .slice(start, i)
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .trim();
        start = i + 1;
      }
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        if (head === selector) out.push(css.slice(start, i));
        start = i + 1;
      }
    }
  }
  return out;
}

const DECL = /^\s*(--[a-z0-9-]+)\s*:\s*(.+?);\s*$/;

function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of body.replace(/\/\*[\s\S]*?\*\//g, "").split("\n")) {
    const m = DECL.exec(line);
    if (m) out.set(m[1]!, m[2]!);
  }
  return out;
}

/**
 * Themeable tokens in tokens.css order. Throws when a blank-line separated
 * chunk of the light block has no section comment, so new tokens always land
 * in a named group.
 */
export function themeTokenGroups(css: string): TokenGroup[] {
  const [lightBody] = ruleBodies(css, LIGHT_SELECTOR);
  if (lightBody === undefined) throw new Error(`tokens.css has no ${LIGHT_SELECTOR} block`);
  const dark = new Map<string, string>();
  for (const body of ruleBodies(css, ":root")) for (const [k, v] of declarations(body)) dark.set(k, v);

  const groups: TokenGroup[] = [];
  const placed = new Map<string, TokenGroup>();
  let current: TokenGroup | null = null;
  let chunkHasComment = false;
  const lines = lightBody.replace(/\/\*\s*\n[\s\S]*?\*\//g, "").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      chunkHasComment = false;
      current = null;
      continue;
    }
    const comment = /^\/\*\s*(.*?)\s*\*\/$/.exec(trimmed);
    if (comment) {
      const title = comment[1]!
        .replace(/\s*\(.*$/, "")
        .replace(/\s+as\s.*$/, "")
        .trim();
      current = { title, scheme: SCHEME_GROUPS.some((g) => title.startsWith(g)), tokens: [] };
      groups.push(current);
      chunkHasComment = true;
      continue;
    }
    const m = DECL.exec(line);
    if (!m) continue;
    if (!current || !chunkHasComment) {
      throw new Error(`tokens.css: ${m[1]} in ${LIGHT_SELECTOR} needs a section comment (/* group */) above its chunk`);
    }
    const name = m[1]!;
    // A token listed twice stays in the later group (the redefinition wins in CSS too).
    const prev = placed.get(name);
    if (prev) prev.tokens = prev.tokens.filter((t) => t.name !== name);
    current.tokens.push({ name, light: m[2]!, dark: dark.get(name) ?? m[2]! });
    placed.set(name, current);
  }
  return groups.filter((g) => g.tokens.length > 0);
}

/** Every themeable token name, split into UI theme and editor scheme sets. */
export function tokenSets(groups: readonly TokenGroup[]): { ui: string[]; scheme: string[] } {
  const ui: string[] = [];
  const scheme: string[] = [];
  for (const g of groups) (g.scheme ? scheme : ui).push(...g.tokens.map((t) => t.name));
  return { ui, scheme };
}

const cell = (v: string) => "`" + v.replace(/\|/g, "\\|") + "`";
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Markdown token reference (one table per group) for docs/plugins/themes.md. */
export function referenceMarkdown(groups: readonly TokenGroup[]): string {
  const { ui, scheme } = tokenSets(groups);
  const parts = [
    `${ui.length + scheme.length} themeable tokens: ${ui.length} in the UI theme file, ${scheme.length} in the editor colour scheme file.`,
  ];
  for (const g of groups) {
    parts.push(
      `### ${capitalize(g.title)} (${g.scheme ? "editor scheme" : "UI theme"})`,
      [
        "| Token | Islands Dark | Islands Light |",
        "|---|---|---|",
        ...g.tokens.map((t) => `| ${cell(t.name)} | ${cell(t.dark)} | ${cell(t.light)} |`),
      ].join("\n"),
    );
  }
  return parts.join("\n\n");
}

export const REFERENCE_BEGIN = "<!-- BEGIN GENERATED TOKEN REFERENCE: pnpm gen:theme-docs -->";
export const REFERENCE_END = "<!-- END GENERATED TOKEN REFERENCE -->";

/** `doc` with the generated reference section replaced. */
export function withReference(doc: string, reference: string): string {
  const begin = doc.indexOf(REFERENCE_BEGIN);
  const end = doc.indexOf(REFERENCE_END);
  if (begin < 0 || end < begin) throw new Error("token reference markers not found");
  return `${doc.slice(0, begin + REFERENCE_BEGIN.length)}\n\n${reference}\n\n${doc.slice(end)}`;
}

/** JSON with `//` and `/* *\/` comments removed outside strings (as the plugin host accepts). */
export function stripJsonComments(src: string): string {
  let out = "";
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inStr) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      if (nl < 0) break;
      i = nl - 1;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      out += src.slice(i, end < 0 ? src.length : end).replace(/[^\n]/g, "") + " ";
      i = end < 0 ? src.length : end + 1;
    } else {
      inStr = c === '"';
      out += c;
    }
  }
  return out;
}
