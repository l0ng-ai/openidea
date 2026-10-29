/**
 * Editor colour schemes (Settings › Editor › Color Scheme). A scheme is the
 * editor part of a theme's tokens (`--syn-*`, editor surfaces, gutter,
 * search, diagnostics), read from `styles/tokens.css` so the scheme list never
 * drifts from the themes. Choosing a scheme other than the theme's own, or
 * editing an attribute, injects those variables into one stylesheet.
 *
 * Attribute ids are stable (they key `editor.colorOverrides[scheme][id]`).
 */
import tokensCss from "@/styles/tokens.css?raw";
import type { TextAttributesOverride } from "./editorSettings";
import { BUILTIN_THEMES, isBuiltinTheme, themeKind, type BuiltinThemeId } from "./themes";

export type SchemeId = BuiltinThemeId;

export const SCHEMES: ReadonlyArray<{ id: SchemeId; name: string }> = BUILTIN_THEMES.map((t) => ({
  id: t.id,
  name: t.label,
}));

export interface AttributeDef {
  id: string;
  name: string;
  /** Tree path below the root, e.g. ["Language Defaults", "Comments"]. */
  path: string[];
  /** CSS variable of the foreground / background / effect colour, if editable. */
  fg?: string;
  bg?: string;
  effect?: string;
  /** Syntax token: bold / italic / background / effect come from `--syn-<token>-*`. */
  token?: string;
  /** A semantic modifier whose only configurable attribute is italic. */
  italicOnly?: boolean;
  defaultItalic?: boolean;
}

const syn = (id: string, name: string, path: string[], token: string): AttributeDef => ({
  id,
  name,
  path,
  token,
  fg: `--syn-${token}`,
});

const LD = "Language Defaults";

/** IDEA-style attribute tree: General, Language Defaults, then languages. */
export const ATTRIBUTES: readonly AttributeDef[] = [
  { id: "text", name: "Default text", path: ["General", "Text"], fg: "--fg-editor", bg: "--bg-editor" },
  { id: "caret", name: "Caret", path: ["General", "Editor"], fg: "--caret" },
  { id: "caretRow", name: "Caret row", path: ["General", "Editor"], bg: "--bg-current-line" },
  { id: "selection", name: "Selection background", path: ["General", "Editor"], bg: "--bg-editor-selection" },
  {
    id: "selectionInactive",
    name: "Selection background (inactive)",
    path: ["General", "Editor"],
    bg: "--bg-editor-selection-inactive",
  },
  { id: "whitespaces", name: "Whitespaces", path: ["General", "Editor"], fg: "--fg-whitespace" },
  { id: "indentGuide", name: "Indent guide", path: ["General", "Editor"], fg: "--border-indent-guide" },
  { id: "rightMargin", name: "Hard wrap guide", path: ["General", "Editor"], fg: "--border-right-margin" },
  {
    id: "methodSeparator",
    name: "Method separator color",
    path: ["General", "Editor"],
    fg: "--border-method-separator",
  },
  { id: "lineNumber", name: "Line number", path: ["General", "Code"], fg: "--fg-line-number" },
  {
    id: "lineNumberCaret",
    name: "Line number on caret row",
    path: ["General", "Code"],
    fg: "--fg-line-number-current",
  },
  { id: "gutter", name: "Gutter background", path: ["General", "Code"], bg: "--bg-editor-gutter" },
  { id: "matchedBrace", name: "Matched brace", path: ["General", "Code"], bg: "--bg-matched-brace" },
  {
    id: "identifierUnderCaret",
    name: "Identifier under caret",
    path: ["General", "Code"],
    bg: "--bg-identifier-under-caret",
  },
  {
    id: "identifierUnderCaretWrite",
    name: "Identifier under caret (write)",
    path: ["General", "Code"],
    bg: "--bg-identifier-under-caret-write",
  },
  { id: "inlay", name: "Inlay hints", path: ["General", "Code"], fg: "--fg-inlay", bg: "--bg-inlay" },
  {
    id: "folded",
    name: "Folded text",
    path: ["General", "Code"],
    fg: "--fg-fold-placeholder",
    bg: "--bg-fold-placeholder",
  },
  { id: "searchResult", name: "Search result", path: ["General", "Search Results"], bg: "--bg-search-match" },
  {
    id: "searchResultCurrent",
    name: "Current search result",
    path: ["General", "Search Results"],
    bg: "--bg-search-match-current",
  },
  { id: "error", name: "Error", path: ["General", "Errors and Warnings"], effect: "--wave-error" },
  { id: "warning", name: "Warning", path: ["General", "Errors and Warnings"], effect: "--wave-warning" },
  { id: "weakWarning", name: "Weak warning", path: ["General", "Errors and Warnings"], fg: "--fg-weak-warning" },
  { id: "unused", name: "Unused symbol", path: ["General", "Errors and Warnings"], fg: "--fg-unused" },
  syn("invalid", "Bad character", ["General", "Errors and Warnings"], "invalid"),
  syn("todo", "TODO defaults", ["General", "Code"], "todo"),
  { id: "inlineValue", name: "Inline debugger values", path: ["Debugger"], fg: "--syn-inline-value" },
  { id: "breakpointLine", name: "Breakpoint line", path: ["Debugger"], bg: "--bg-breakpoint-line" },

  syn("keyword", "Keyword", [LD], "keyword"),
  syn("identifier", "Identifiers › Local variable", [LD], "variable"),
  syn("parameter", "Identifiers › Parameter", [LD], "param"),
  syn("constant", "Identifiers › Constant", [LD], "constant"),
  syn("field", "Identifiers › Instance field", [LD], "property"),
  { id: "staticSymbol", name: "Identifiers › Static symbol", path: [LD], token: "static", italicOnly: true },
  syn("functionDeclaration", "Identifiers › Function declaration", [LD], "function"),
  syn("functionCall", "Identifiers › Function call", [LD], "function-call"),
  syn("predefined", "Identifiers › Predefined symbol", [LD], "builtin"),
  syn("className", "Classes › Class name", [LD], "type"),
  syn("number", "Number", [LD], "number"),
  syn("string", "String › String text", [LD], "string"),
  syn("escape", "String › Valid escape sequence", [LD], "escape"),
  syn("lineComment", "Comments › Line comment", [LD], "comment"),
  syn("docComment", "Comments › Doc comment", [LD], "doc-comment"),
  syn("metadata", "Metadata", [LD], "decorator"),
  syn("operator", "Braces and Operators", [LD], "punct"),
  syn("markupTag", "Markup › Tag", [LD], "tag"),
  syn("markupAttribute", "Markup › Attribute", [LD], "attribute"),
  ...[1, 2, 3, 4, 5].map((n) => syn(`semantic${n}`, `Semantic highlighting › Color ${n}`, [LD], `rainbow-${n}`)),
  ...[1, 2, 3].map((n) => syn(`bracket${n}`, `Rainbow brackets › Level ${n}`, [LD], `bracket-${n}`)),

  syn("pySelf", "Self parameter", ["Python"], "self"),
  {
    id: "pyStaticSymbol",
    name: "Static symbol",
    path: ["Python"],
    token: "python-static",
    italicOnly: true,
    defaultItalic: false,
  },
  syn("pyKeywordArg", "Keyword argument", ["Python"], "keyword-arg"),
  syn("pyDocstring", "Docstring", ["Python"], "docstring"),
  syn("pyBuiltin", "Built-in name", ["Python"], "predefined"),
  syn("pyDecorator", "Decorator", ["Python"], "annotation"),
  syn("mdHeading", "Heading", ["Markdown"], "markup-heading"),
  syn("mdCode", "Code span", ["Markdown"], "markup-code"),
  syn("mdLink", "Link", ["Markdown"], "link"),
  syn("regexp", "Regular expression", ["RegExp"], "regexp"),
];

// --- scheme base values ------------------------------------------------------

/** Variables a scheme sets: every attribute variable plus the editor tokens derived from them. */
const SCHEME_VARS = new Set<string>([
  ...ATTRIBUTES.flatMap((a) => [a.fg, a.bg, a.effect].filter((v): v is string => !!v)),
  "--syn-comment-style",
  "--editor-error-decoration",
  "--editor-warning-decoration",
  "--editor-warning-background",
  "--border-gutter",
  "--border-indent-guide-active",
  "--fg-fold-marker",
  "--bg-editor-inline",
  "--fg-completion-match",
  "--fg-search-match",
  "--matched-brace-weight",
  "--bg-matched-tag",
]);

type Vars = Map<string, string>;

/** Top-level `selector { decls }` blocks of a stylesheet (nested at-rules skipped). */
function blocks(css: string): Array<{ selectors: string[]; decls: Vars }> {
  const out: Array<{ selectors: string[]; decls: Vars }> = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let depth = 0;
  let start = 0;
  let selector = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      if (depth === 0) {
        selector = text.slice(start, i).trim();
        start = i + 1;
      }
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        if (!selector.startsWith("@")) {
          const decls: Vars = new Map();
          for (const m of text.slice(start, i).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) decls.set(m[1]!, m[2]!.trim());
          out.push({ selectors: selector.split(",").map((s) => s.trim()), decls });
        }
        start = i + 1;
      }
    }
  }
  return out;
}

function themeSelectors(id: SchemeId): string[] {
  if (id === "light") return [':root[data-theme="light"]'];
  if (id === "dark-hc") return [':root[data-theme="dark-hc"]', ':root[data-theme="dark"][data-contrast="high"]'];
  if (id === "dark") return [':root[data-theme="dark"]'];
  return [`:root[data-theme="${themeKind(id)}"]`, ":root[data-color-theme]", `:root[data-color-theme="${id}"]`];
}

let source: string = tokensCss;
let parsed: ReturnType<typeof blocks> | null = null;
const resolvedCache = new Map<SchemeId, Vars>();

/** Replaces the token source (tests: CSS `?raw` imports are empty under vitest). */
export function _setSchemeSource(css: string) {
  source = css;
  parsed = null;
  resolvedCache.clear();
}

/** All tokens of a theme with `var()` references resolved (so they survive under another theme). */
export function schemeTokens(id: SchemeId, css: string = source): Vars {
  const cached = css === source ? resolvedCache.get(id) : undefined;
  if (cached) return cached;
  const all = css === source ? (parsed ??= blocks(css)) : blocks(css);
  const own = themeSelectors(id);
  const merged: Vars = new Map();
  for (const b of all) if (b.selectors.includes(":root")) for (const [k, v] of b.decls) merged.set(k, v);
  for (const b of all) if (b.selectors.some((s) => own.includes(s))) for (const [k, v] of b.decls) merged.set(k, v);
  const resolve = (value: string, depth = 0): string =>
    depth > 8
      ? value
      : value.replace(
          /var\((--[\w-]+)(?:\s*,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g,
          (_m, name: string, fallback?: string) => {
            const v = merged.get(name);
            return v !== undefined
              ? resolve(v, depth + 1)
              : fallback !== undefined
                ? resolve(fallback.trim(), depth + 1)
                : `var(${name})`;
          },
        );
  const out: Vars = new Map();
  for (const [k, v] of merged) out.set(k, resolve(v));
  if (css === source) resolvedCache.set(id, out);
  return out;
}

/** The scheme the editor shows for `setting` under the current theme. */
export function effectiveScheme(
  setting: string | undefined,
  root: HTMLElement | null = typeof document !== "undefined" ? document.documentElement : null,
): SchemeId {
  if (isBuiltinTheme(setting)) return setting;
  return themeScheme(root);
}

/** Scheme belonging to the active IDE theme (`data-theme` / `data-contrast`). */
export function themeScheme(
  root: HTMLElement | null = typeof document !== "undefined" ? document.documentElement : null,
): SchemeId {
  if (!root) return "light";
  if (isBuiltinTheme(root.dataset.colorTheme)) return root.dataset.colorTheme;
  if (root.dataset.theme === "light") return "light";
  return root.dataset.contrast === "high" || root.dataset.theme === "dark-hc" ? "dark-hc" : "dark";
}

/** An explicit Bold / regular attribute: the editor's configured bold or main weight. */
export function boldWeight(bold: boolean): string {
  return bold ? "var(--fw-code-bold, 700)" : "var(--fw-code, 400)";
}

const EFFECT_CSS: Record<string, (c: string) => string> = {
  underline: (c) => `underline ${c}`,
  wave: (c) => `underline wavy ${c}`,
  strikeout: (c) => `line-through ${c}`,
  none: () => "none",
};

/** Declarations for the overrides of one scheme. */
export function overrideDeclarations(
  overrides: Record<string, TextAttributesOverride> | undefined,
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (!overrides) return out;
  for (const attr of ATTRIBUTES) {
    const o = overrides[attr.id];
    if (!o) continue;
    if (o.foreground && attr.fg) out.push([attr.fg, o.foreground]);
    if (o.background && attr.bg) out.push([attr.bg, o.background]);
    if (o.effectColor && attr.effect) out.push([attr.effect, o.effectColor]);
    if (attr.effect && o.effectColor) {
      if (attr.id === "error") out.push(["--editor-error-decoration", `underline wavy ${o.effectColor}`]);
      if (attr.id === "warning") out.push(["--editor-warning-decoration", `underline wavy ${o.effectColor}`]);
    }
    if (attr.token) {
      const t = attr.token;
      if (o.bold !== undefined) out.push([`--syn-${t}-bold`, boldWeight(o.bold)]);
      if (o.italic !== undefined) {
        out.push([`--syn-${t}-italic`, o.italic ? "italic" : "normal"]);
        if (t === "comment") out.push(["--syn-comment-style", o.italic ? "italic" : "normal"]);
      }
      if (o.background) out.push([`--syn-${t}-bg`, o.background]);
      if (o.effect) out.push([`--syn-${t}-effect`, EFFECT_CSS[o.effect]?.(o.effectColor ?? "currentColor") ?? "none"]);
    }
  }
  return out;
}

const SAFE = /^[^;{}<>]*$/;

/** Stylesheet text for the chosen scheme and its overrides ("" when the theme's own is used unchanged). */
export function schemeCss(
  setting: string | undefined,
  overrides: Record<string, Record<string, TextAttributesOverride>> | undefined,
  root?: HTMLElement | null,
): string {
  const id = effectiveScheme(setting, root);
  const decls: Array<[string, string]> = [];
  // A plugin theme brings its own editor colours: an explicit scheme replaces them even on the same base.
  const el = root === undefined ? (typeof document !== "undefined" ? document.documentElement : null) : root;
  const pluginTheme = !!el?.dataset.pluginTheme && id === setting;
  if (id !== themeScheme(root) || pluginTheme) {
    const tokens = schemeTokens(id);
    for (const [k, v] of tokens) if (SCHEME_VARS.has(k) || k.startsWith("--syn-")) decls.push([k, v]);
    // The editor surface follows the scheme, not the island colour of the UI theme.
    const bg = tokens.get("--bg-editor") ?? tokens.get("--bg-island");
    if (bg) decls.push(["--bg-editor", bg], ["--bg-editor-gutter", tokens.get("--bg-editor-gutter") ?? bg]);
  }
  decls.push(...overrideDeclarations(overrides?.[id]));
  const body = decls
    .filter(([k, v]) => /^--[\w-]+$/.test(k) && SAFE.test(v))
    .map(([k, v]) => `  ${k}: ${v} !important;`);
  return body.length ? `:root {\n${body.join("\n")}\n}\n` : "";
}
