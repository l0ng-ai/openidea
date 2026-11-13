/** IntelliJ editor schemes. Unsupported keys are counted, never copied into CSS. */
import {
  ATTRIBUTES,
  CLEAR_COLOR,
  customSchemes,
  isHexColor,
  listSchemes,
  resolvedAttribute,
  resolvedSchemeTokens,
} from "./colorScheme";
import { isBuiltinTheme, themeKind } from "./themes";
import type { CustomColorScheme, CustomColorSchemes, TextAttributesOverride } from "./editorSettings";

// Many language keys share the editor's language-default tokens.
const ATTRIBUTE_NAMES: Record<string, string> = {
  TEXT: "text",
  DEFAULT_TEXT: "text",
  DEFAULT_KEYWORD: "keyword",
  DEFAULT_IDENTIFIER: "identifier",
  DEFAULT_LOCAL_VARIABLE: "identifier",
  DEFAULT_PARAMETER: "parameter",
  DEFAULT_GLOBAL_VARIABLE: "globalVariable",
  DEFAULT_CONSTANT: "constant",
  DEFAULT_INSTANCE_FIELD: "field",
  DEFAULT_STATIC_FIELD: "constant",
  DEFAULT_FUNCTION_DECLARATION: "functionDeclaration",
  DEFAULT_FUNCTION_CALL: "functionCall",
  DEFAULT_PREDEFINED_SYMBOL: "predefined",
  DEFAULT_CLASS_NAME: "className",
  DEFAULT_INTERFACE_NAME: "className",
  DEFAULT_NUMBER: "number",
  DEFAULT_STRING: "string",
  DEFAULT_VALID_STRING_ESCAPE: "escape",
  DEFAULT_INVALID_STRING_ESCAPE: "invalid",
  DEFAULT_LINE_COMMENT: "lineComment",
  DEFAULT_BLOCK_COMMENT: "lineComment",
  DEFAULT_DOC_COMMENT: "docComment",
  DEFAULT_DOC_COMMENT_TAG: "docCommentTag",
  DEFAULT_DOC_COMMENT_TAG_VALUE: "docCommentTagValue",
  DEFAULT_DOC_MARKUP: "docCommentMarkup",
  DEFAULT_METADATA: "metadata",
  DEFAULT_OPERATION_SIGN: "operator",
  DEFAULT_PARENTHS: "operator",
  DEFAULT_BRACES: "operator",
  DEFAULT_BRACKETS: "operator",
  DEFAULT_MARKUP_TAG: "markupTag",
  DEFAULT_MARKUP_ATTRIBUTE: "markupAttribute",
  BAD_CHARACTER: "invalid",
  TODO_DEFAULT_ATTRIBUTES: "todo",
  SEARCH_RESULT_ATTRIBUTES: "searchResult",
  TEXT_SEARCH_RESULT_ATTRIBUTES: "searchResultCurrent",
  WRITE_SEARCH_RESULT_ATTRIBUTES: "identifierUnderCaretWrite",
  IDENTIFIER_UNDER_CARET_ATTRIBUTES: "identifierUnderCaret",
  MATCHED_BRACE_ATTRIBUTES: "matchedBrace",
  ERRORS_ATTRIBUTES: "error",
  WARNING_ATTRIBUTES: "warning",
  WEAK_WARNING_ATTRIBUTES: "weakWarning",
  NOT_USED_ELEMENT_ATTRIBUTES: "unused",
  FOLDED_TEXT_ATTRIBUTES: "folded",
  INLAY_DEFAULT: "inlay",
  PY_SELF_PARAMETER: "pySelf",
  PY_KEYWORD_ARGUMENT: "pyKeywordArg",
  PY_DOC_STRING: "pyDocstring",
  "PY.DOC_COMMENT_TAG": "pyDocstringTag",
  OPENIDEA_pyDocstringKeyword: "pyDocstringKeyword",
  PY_BUILTIN_NAME: "pyBuiltin",
  PY_DECORATOR: "pyDecorator",
  MARKDOWN_HEADER_LEVEL_1: "mdHeading",
  MARKDOWN_CODE_SPAN: "mdCode",
  MARKDOWN_LINK_TEXT: "mdLink",
  REGEXP: "regexp",
};
const LANGUAGE_KEYS: Record<string, string> = {
  KEYWORD: "keyword",
  NUMBER: "number",
  STRING: "string",
  STRING_TEXT: "string",
  VALID_STRING_ESCAPE: "escape",
  LINE_COMMENT: "lineComment",
  BLOCK_COMMENT: "lineComment",
  DOC_COMMENT: "docComment",
  CLASS: "className",
  CLASS_NAME: "className",
  INTERFACE: "className",
  ENUM: "className",
  TYPE_PARAMETER: "className",
  ANNOTATION_NAME: "metadata",
  ANNOTATION: "metadata",
  LOCAL_VARIABLE: "identifier",
  PARAMETER: "parameter",
  INSTANCE_FIELD: "field",
  STATIC_FIELD: "constant",
  STATIC_FINAL_FIELD: "constant",
  PROPERTY: "field",
  BACKING_FIELD_VARIABLE: "field",
  FUNCTION_DECLARATION: "functionDeclaration",
  METHOD_DECLARATION: "functionDeclaration",
  FUNCTION_CALL: "functionCall",
  METHOD_CALL: "functionCall",
  STATIC_METHOD: "functionCall",
  CONSTRUCTOR_CALL: "className",
  OPERATION_SIGN: "operator",
  BRACES: "operator",
  BRACKETS: "operator",
  PARENTH: "operator",
  PARENTHS: "operator",
};
for (const [name, id] of Object.entries(LANGUAGE_KEYS)) {
  ATTRIBUTE_NAMES[`JAVA_${name}`] = `java.${id}`;
  ATTRIBUTE_NAMES[`KOTLIN_${name}`] = `kotlin.${id}`;
  ATTRIBUTE_NAMES[name] = id;
}
Object.assign(ATTRIBUTE_NAMES, {
  KOTLIN_MUTABLE_VARIABLE: "kotlin.identifier",
  KOTLIN_PACKAGE_PROPERTY: "kotlin.field",
  KOTLIN_SYNTHETIC_EXTENSION_PROPERTY: "kotlin.field",
  KOTLIN_EXTENSION_FUNCTION_CALL: "kotlin.functionCall",
  KOTLIN_NAMED_ARGUMENT: "kotlin.parameter",
  KOTLIN_OBJECT: "kotlin.className",
  JAVA_DOC_TAG: "java.docCommentTag",
  DOC_COMMENT_TAG_VALUE: "java.docCommentTagValue",
  JAVA_DOC_MARKUP: "java.docCommentMarkup",
  KDOC_TAG_NAME: "kotlin.docCommentTag",
  KDOC_LINK: "kotlin.docCommentTagValue",
  CLASS_NAME_ATTRIBUTES: "className",
  PHP_KEYWORD: "php.keyword",
  PHP_VAR: "php.identifier",
  PHP_PARAMETER: "php.parameter",
  PHP_CLASS: "php.className",
  PHP_CONSTANT: "php.constant",
  PHP_INSTANCE_FIELD: "php.field",
  PHP_STATIC_FIELD: "php.staticField",
  PHP_FUNCTION: "php.functionDeclaration",
  PHP_FUNCTION_CALL: "php.functionCall",
  PHP_INSTANCE_METHOD: "php.functionCall",
  "PHP_PREDEFINED SYMBOL": "php.predefined",
  PHP_NUMBER: "php.number",
  PHP_STRING: "php.string",
  PHP_ESCAPE_SEQUENCE: "php.escape",
  PHP_COMMENT: "php.lineComment",
  PHP_DOC_COMMENT_ID: "php.docComment",
  PHP_DOC_TAG: "php.docCommentTag",
  PHP_DOC_VAR: "php.docCommentTagValue",
  PHP_MARKUP_ID: "php.docCommentMarkup",
  PHP_ATTRIBUTE: "php.metadata",
  PHP_OPERATION_SIGN: "php.operator",
  PHP_BRACKETS: "php.brackets",
  PHP_COMMA: "php.separator",
  PHP_SEMICOLON: "php.separator",
  PHP_TAG: "php.scriptTag",
});

Object.assign(ATTRIBUTE_NAMES, {
  "PY.ANNOTATION": "pyAnnotation",
  "PY.PARENTHS": "pyParentheses",
  "PY.BRACKETS": "pyBrackets",
  "PY.BRACES": "pyBraces",
  // PyCharm keys restyle Python only; DEFAULT_* keys carry the shared colour.
  "PY.KEYWORD": "pyKeyword",
  "PY.NUMBER": "pyNumber",
  "PY.LINE_COMMENT": "pyLineComment",
  "PY.STRING": "pyString",
  "PY.STRING.U": "pyString",
  "PY.FUNC_DEFINITION": "pyFunctionDeclaration",
  "PY.NESTED_FUNC_DEFINITION": "pyNestedFunction",
  "PY.METHOD_CALL": "pyMethodCall",
  "PY.DOC_COMMENT": "pyDocstring",
  "PY.BUILTIN_NAME": "pyBuiltin",
  "PY.DECORATOR": "pyDecorator",
  "PY.SELF_PARAMETER": "pySelf",
  "PY.KEYWORD_ARGUMENT": "pyKeywordArg",
  "PY.PREDEFINED_DEFINITION": "pyPredefinedDefinition",
  "PY.PREDEFINED_USAGE": "pyPredefinedUsage",
  "PY.STRING.B": "pyBytes",
  "PY.STRING.F": "pyFString",
  "PY.VALID_STRING_ESCAPE": "pyValidEscape",
  "PY.OPERATION_SIGN": "pyOperationSign",
});

// WebStorm's JavaScript keys; TypeScript repeats them with a TS. prefix. Language Defaults serve both.
const SCRIPT_KEYS: Record<string, string> = {
  KEYWORD: "keyword",
  NUMBER: "number",
  STRING: "string",
  VALID_STRING_ESCAPE: "escape",
  INVALID_STRING_ESCAPE: "invalid",
  BADCHARACTER: "invalid",
  REGEXP: "regexp",
  LINE_COMMENT: "lineComment",
  BLOCK_COMMENT: "lineComment",
  DOC_COMMENT: "docComment",
  DOC_TAG: "docCommentTag",
  DOC_TAG_VALUE: "docCommentTagValue",
  DOC_MARKUP: "docCommentMarkup",
  LOCAL_VARIABLE: "identifier",
  PARAMETER: "parameter",
  GLOBAL_VARIABLE: "globalVariable",
  EXPORTED_VARIABLE: "globalVariable",
  "EXPORTED.VARIABLE": "globalVariable",
  INSTANCE_MEMBER_VARIABLE: "field",
  STATIC_MEMBER_VARIABLE: "constant",
  GLOBAL_FUNCTION: "functionDeclaration",
  LOCAL_FUNCTION: "functionDeclaration",
  EXPORTED_FUNCTION: "functionDeclaration",
  INSTANCE_MEMBER_FUNCTION: "functionDeclaration",
  STATIC_MEMBER_FUNCTION: "functionDeclaration",
  CLASS: "className",
  EXPORTED_CLASS: "className",
  INTERFACE: "className",
  "TYPE.ALIAS": "className",
  TYPE_PARAMETER: "className",
  DECORATOR: "metadata",
  OPERATION_SIGN: "operator",
};
// WebStorm colours a function's calls with its declaration's key.
const ALSO_CALLS = new Set<string>();
for (const prefix of ["JS.", "TS."])
  for (const [name, id] of Object.entries(SCRIPT_KEYS)) {
    ATTRIBUTE_NAMES[prefix + name] = id;
    if (id === "functionDeclaration") ALSO_CALLS.add(prefix + name);
  }

const COLOR_NAMES: Record<string, [string, "foreground" | "background"]> = {
  CARET_COLOR: ["caret", "foreground"],
  CARET_ROW_COLOR: ["caretRow", "background"],
  SELECTION_BACKGROUND: ["selection", "background"],
  SELECTION_FOREGROUND: ["selectionForeground", "foreground"],
  INACTIVE_SELECTION_BACKGROUND: ["selectionInactive", "background"],
  GUTTER_BACKGROUND: ["gutter", "background"],
  LINE_NUMBERS_COLOR: ["lineNumber", "foreground"],
  LINE_NUMBER_ON_CARET_ROW_COLOR: ["lineNumberCaret", "foreground"],
  WHITESPACES: ["whitespaces", "foreground"],
  INDENT_GUIDE: ["indentGuide", "foreground"],
  RIGHT_MARGIN_COLOR: ["rightMargin", "foreground"],
  METHOD_SEPARATORS_COLOR: ["methodSeparator", "foreground"],
  CONSOLE_BACKGROUND_KEY: ["consoleBackground", "background"],
};

Object.assign(ATTRIBUTE_NAMES, {
  CONSOLE_BLACK_OUTPUT: "ansiBlack",
  CONSOLE_RED_OUTPUT: "ansiRed",
  CONSOLE_GREEN_OUTPUT: "ansiGreen",
  CONSOLE_YELLOW_OUTPUT: "ansiYellow",
  CONSOLE_BLUE_OUTPUT: "ansiBlue",
  CONSOLE_MAGENTA_OUTPUT: "ansiMagenta",
  CONSOLE_CYAN_OUTPUT: "ansiCyan",
  CONSOLE_GRAY_OUTPUT: "ansiWhite",
  CONSOLE_DARKGRAY_OUTPUT: "ansiBrightBlack",
  CONSOLE_RED_BRIGHT_OUTPUT: "ansiBrightRed",
  CONSOLE_GREEN_BRIGHT_OUTPUT: "ansiBrightGreen",
  CONSOLE_YELLOW_BRIGHT_OUTPUT: "ansiBrightYellow",
  CONSOLE_BLUE_BRIGHT_OUTPUT: "ansiBrightBlue",
  CONSOLE_MAGENTA_BRIGHT_OUTPUT: "ansiBrightMagenta",
  CONSOLE_CYAN_BRIGHT_OUTPUT: "ansiBrightCyan",
  CONSOLE_WHITE_OUTPUT: "ansiBrightWhite",
});

// Preserve editor attributes without a standard exchange name on our own round trip.
for (const attr of ATTRIBUTES)
  if (!Object.values(ATTRIBUTE_NAMES).includes(attr.id)) ATTRIBUTE_NAMES[`OPENIDEA_${attr.id}`] = attr.id;

// One key colours an attribute, as IntelliJ shows it in the file the user sees: an explicit value replaces
// its fallback's. TypeScript keys win over JavaScript (TS.* falls back to JS.*), then Python, then the
// shared defaults; within a language, the key listed first above. DEFAULT_DOT, _COMMA and _SEMICOLON are
// not mapped: the one punctuation colour here would spread them to every brace and operator.
const KEY_ORDER = new Map(Object.keys(ATTRIBUTE_NAMES).map((name, i) => [name, i]));
const LANGUAGE_PRECEDENCE = ["TS.", "JS.", "PY."];
const precedence = (name: string) => {
  const language = LANGUAGE_PRECEDENCE.findIndex((prefix) => name.startsWith(prefix));
  return (language < 0 ? LANGUAGE_PRECEDENCE.length : language) * KEY_ORDER.size + KEY_ORDER.get(name)!;
};
const targets = (name: string): string[] =>
  Object.hasOwn(ATTRIBUTE_NAMES, name)
    ? ALSO_CALLS.has(name)
      ? [ATTRIBUTE_NAMES[name]!, "functionCall"]
      : [ATTRIBUTE_NAMES[name]!]
    : [];

// IntelliJ's EFFECT_TYPE codes. The box (0) and faded text (6) have no counterpart here; the bold and the
// bold dotted line (4, 5) become an underline.
const EFFECTS: Record<string, TextAttributesOverride["effect"]> = {
  "1": "underline",
  "2": "wave",
  "3": "strikeout",
  "4": "underline",
  "5": "underline",
};
const EFFECT_CODES: Partial<Record<NonNullable<TextAttributesOverride["effect"]>, string>> = {
  underline: "1",
  wave: "2",
  strikeout: "3",
};
const children = (el: Element, tag: string) => Array.from(el.children).filter((e) => e.tagName === tag);
const color = (v: string | null): string | undefined =>
  v && /^[0-9a-f]{1,6}$/i.test(v) ? `#${v.padStart(6, "0").toLowerCase()}` : undefined;

function attributeEntries(section: Element): Element[] {
  const entries = children(section, "option");
  if (!entries.some((e) => e.getAttribute("name")?.startsWith("PY."))) return entries;
  return entries.filter((e) => e.getAttribute("name") !== "DEFAULT_BLOCK_COMMENT");
}

/** A scheme file that is not an IntelliJ color scheme; `message` says what is wrong with it. */
export class SchemeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemeParseError";
  }
}

/**
 * The variants real IDEA scheme files come in: a BOM, an `encoding=` declaration
 * (both describe the file's bytes, while this text has already been decoded), and
 * a DOCTYPE prolog. None of them change the scheme, so drop the first two.
 */
const prepareIclsXml = (xml: string) =>
  xml
    .replace(/^\uFEFF+/, "")
    .replace(/^\s*<\?xml\s[^>]*\?>(\r\n|\r|\n)?/i, "")
    .replace(/^\s*(\r\n|\r|\n)?/, "");

const parserDetail = (doc: Document): string => {
  const detail = (doc.querySelector("parsererror")?.textContent ?? "").replace(/\s+/g, " ").trim();
  return detail.length ? detail.slice(0, 200) : "no scheme element found";
};

export function parseIcls(
  xml: string,
  fallbackName = "Imported scheme",
): { scheme: CustomColorScheme; applied: number; skipped: number } {
  const doc = new DOMParser().parseFromString(prepareIclsXml(xml), "application/xml");
  // Some distributors wrap the scheme element (an <application>/<component> export), or leave the name out.
  const root =
    doc.documentElement?.tagName === "scheme"
      ? doc.documentElement
      : (doc.getElementsByTagName("scheme")[0] ?? undefined);
  if (doc.querySelector("parsererror") || !root)
    throw new SchemeParseError(
      doc.querySelector("parsererror") ? `not valid XML (${parserDetail(doc)})` : "no IntelliJ <scheme> element found",
    );
  const name = root.getAttribute("name")?.trim() || fallbackName;
  const attributes: Record<string, TextAttributesOverride> = {};
  const entries = new Map(
    children(root, "attributes").flatMap((section) =>
      children(section, "option").map((entry) => [entry.getAttribute("name"), entry] as const),
    ),
  );
  const inheritedValue = (entry: Element): Element | undefined => {
    const seen = new Set<Element>();
    let current: Element | undefined = entry;
    while (current && !seen.has(current)) {
      seen.add(current);
      const value = children(current, "value")[0];
      if (value) return value;
      current = entries.get(current.getAttribute("baseAttributes"));
    }
    return undefined;
  };
  const winners = new Map<string, Element>();
  for (const entry of children(root, "attributes").flatMap(attributeEntries)) {
    const name = entry.getAttribute("name") ?? "";
    if (!inheritedValue(entry)) continue;
    for (const id of targets(name)) {
      const current = winners.get(id);
      if (!current || precedence(name) < precedence(current.getAttribute("name")!)) winners.set(id, entry);
    }
  }
  let applied = 0;
  let skipped = 0;
  const merge = (id: string, value: TextAttributesOverride) => {
    attributes[id] = { ...attributes[id], ...value };
  };
  for (const section of Array.from(root.children)) {
    if (section.tagName === "colors")
      for (const entry of children(section, "option")) {
        const name = entry.getAttribute("name") ?? "";
        const target = Object.hasOwn(COLOR_NAMES, name) ? COLOR_NAMES[name] : undefined;
        const c = color(entry.getAttribute("value"));
        if (target && c) {
          merge(target[0], { [target[1]]: c });
          applied++;
        } else skipped++;
      }
    if (section.tagName === "attributes")
      for (const entry of attributeEntries(section)) {
        const name = entry.getAttribute("name") ?? "";
        const value = inheritedValue(entry);
        const ids = targets(name).filter((id) => winners.get(id) === entry);
        if (!value || !ids.length) {
          skipped++;
          continue;
        }
        for (const id of ids) {
          const attr = ATTRIBUTES.find((a) => a.id === id)!;
          // An explicit TextAttributes value defaults to Font.PLAIN, not the last alias's style.
          if (attr.token) merge(id, { bold: false, italic: false });
          if (name.startsWith("PY.")) merge(id, { effect: "none" });
          // IntelliJ draws no effect without an effect colour.
          const drawn = children(value, "option").some(
            (o) => o.getAttribute("name") === "EFFECT_COLOR" && color(o.getAttribute("value")),
          );
          for (const option of children(value, "option")) {
            const name = option.getAttribute("name");
            const raw = option.getAttribute("value");
            const c = color(raw);
            const field =
              name === "FOREGROUND"
                ? "foreground"
                : name === "BACKGROUND"
                  ? "background"
                  : name === "EFFECT_COLOR"
                    ? "effectColor"
                    : undefined;
            const supported =
              field === "foreground"
                ? !!attr.fg
                : field === "background"
                  ? !!attr.bg || !!attr.token
                  : !!attr.effect || !!attr.token;
            if (field && c && supported) {
              merge(id, { [field]: c });
              applied++;
            } else if (name === "FONT_TYPE" && attr.token && raw && /^[0-3]$/.test(raw)) {
              merge(id, { bold: !!(Number(raw) & 1), italic: !!(Number(raw) & 2) });
              applied++;
            } else if (
              name === "EFFECT_TYPE" &&
              drawn &&
              (attr.token || attr.effect) &&
              raw &&
              Object.hasOwn(EFFECTS, raw)
            ) {
              merge(id, { effect: EFFECTS[raw] });
              applied++;
            } else skipped++;
          }
        }
      }
  }
  const parentName = root.getAttribute("parent_scheme") ?? "";
  const bg = attributes.text?.background;
  const rgb = bg ? [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16)) : [255, 255, 255];
  const dark = rgb[0]! * 0.299 + rgb[1]! * 0.587 + rgb[2]! * 0.114 < 128;
  const parent = bg
    ? dark
      ? "dark"
      : "light"
    : /darcula|dark/i.test(parentName)
      ? "dark"
      : /default|light/i.test(parentName)
        ? "light"
        : dark
          ? "dark"
          : "light";
  return { scheme: { name, parent, attributes }, applied, skipped };
}

/** Name collisions include built-ins; imports never replace a built-in. */
export function importScheme(customs: CustomColorSchemes, scheme: CustomColorScheme, overwrite = false) {
  const existing = Object.entries(customs).find(([, s]) => s.name === scheme.name);
  const names = new Set(listSchemes(customs).map((s) => s.name));
  let name = scheme.name;
  if (!(overwrite && existing)) for (let i = 2; names.has(name); i++) name = `${scheme.name} (${i})`;
  const id = overwrite && existing ? existing[0] : `custom-${crypto.randomUUID()}`;
  return { id, customs: { ...customs, [id]: { ...scheme, name } } };
}

export function deleteScheme(
  customs: CustomColorSchemes,
  overrides: Record<string, Record<string, TextAttributesOverride>>,
  selected: string,
  id: string,
) {
  return {
    customs: Object.fromEntries(Object.entries(customs).filter(([key]) => key !== id)),
    overrides: Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== id)),
    selected: selected === id ? "theme-default" : selected,
  };
}

const exportColor = (c: string) =>
  c.length === 4
    ? c
        .slice(1)
        .split("")
        .map((ch) => ch + ch)
        .join("")
    : c.slice(1);
const escapeXml = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;").replace(/>/g, "&gt;");
export function exportIcls(
  id: string,
  customs: CustomColorSchemes,
  overrides: Record<string, TextAttributesOverride> = {},
): string {
  const custom = customSchemes(customs)[id];
  const name = listSchemes(customs).find((s) => s.id === id)?.name ?? id;
  const tokens = resolvedSchemeTokens(id, customs);
  const tokenEffect = (attr: (typeof ATTRIBUTES)[number]): TextAttributesOverride => {
    if (!attr.token) return {};
    const { effect, effectColor } = resolvedAttribute(id, attr.id, customs);
    return { effect, effectColor };
  };
  const values = (attr: (typeof ATTRIBUTES)[number]): TextAttributesOverride => ({
    ...(attr.token
      ? {
          bold: /bold|[6-9]00/.test(tokens.get(`--syn-${attr.token}-bold`) ?? ""),
          italic:
            (tokens.get(`--syn-${attr.token}-italic`) ??
              (attr.token === "comment"
                ? tokens.get("--syn-comment-style")
                : (attr.italicOnly && attr.defaultItalic !== false) || ["doc-comment", "docstring"].includes(attr.token)
                  ? "italic"
                  : "normal")) === "italic",
        }
      : {}),
    ...(attr.fg && isHexColor(tokens.get(attr.fg)) ? { foreground: tokens.get(attr.fg) } : {}),
    ...(attr.bg && isHexColor(tokens.get(attr.bg)) ? { background: tokens.get(attr.bg) } : {}),
    ...(attr.effect && isHexColor(tokens.get(attr.effect)) ? { effectColor: tokens.get(attr.effect) } : {}),
    ...tokenEffect(attr),
    ...custom?.attributes[attr.id],
    ...overrides[attr.id],
  });
  const colors: string[] = [];
  const attributes: string[] = [];
  for (const [key, [id, field]] of Object.entries(COLOR_NAMES)) {
    const attr = ATTRIBUTES.find((a) => a.id === id);
    const c = attr && values(attr)[field];
    if (isHexColor(c)) colors.push(`    <option name="${key}" value="${exportColor(c)}" />`);
  }
  const text = values(ATTRIBUTES.find((a) => a.id === "text")!);
  for (const attr of ATTRIBUTES) {
    if (attr.language && !custom?.attributes[attr.id] && !overrides[attr.id]) continue;
    const key = Object.keys(ATTRIBUTE_NAMES).find((key) => ATTRIBUTE_NAMES[key] === attr.id);
    if (!key) continue;
    const v = values(attr);
    // A cleared effect colour hides the effect. One left unset takes the text's here, and IntelliJ would draw none.
    const effect = v.effect && v.effectColor !== CLEAR_COLOR ? EFFECT_CODES[v.effect] : undefined;
    if (effect && !isHexColor(v.effectColor)) v.effectColor = v.foreground ?? text.foreground;
    const opts: string[] = [];
    for (const [key, field] of [
      ["FOREGROUND", "foreground"],
      ["BACKGROUND", "background"],
      ["EFFECT_COLOR", "effectColor"],
    ] as const)
      if (isHexColor(v[field])) opts.push(`<option name="${key}" value="${exportColor(v[field]!)}" />`);
    if (attr.token) opts.push(`<option name="FONT_TYPE" value="${(v.bold ? 1 : 0) + (v.italic ? 2 : 0)}" />`);
    if (effect) opts.push(`<option name="EFFECT_TYPE" value="${effect}" />`);
    if (opts.length) attributes.push(`    <option name="${key}"><value>${opts.join("")}</value></option>`);
  }
  const parent = custom?.parent ?? (isBuiltinTheme(id) ? themeKind(id) : "dark");
  return `<scheme name="${escapeXml(name)}" version="142" parent_scheme="${parent === "dark" ? "Darcula" : "Default"}">\n  <colors>\n${colors.join("\n")}\n  </colors>\n  <attributes>\n${attributes.join("\n")}\n  </attributes>\n</scheme>\n`;
}
