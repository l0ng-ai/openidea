/** IntelliJ editor schemes. Unsupported keys are counted, never copied into CSS. */
import { ATTRIBUTES, customSchemes, isHexColor, listSchemes, resolvedSchemeTokens } from "./colorScheme";
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
  DEFAULT_METADATA: "metadata",
  DEFAULT_OPERATION_SIGN: "operator",
  DEFAULT_BRACES: "operator",
  DEFAULT_BRACKETS: "operator",
  DEFAULT_PARENTHS: "operator",
  DEFAULT_DOT: "operator",
  DEFAULT_COMMA: "operator",
  DEFAULT_SEMICOLON: "operator",
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
  ATTRIBUTE_NAMES[`JAVA_${name}`] = id;
  ATTRIBUTE_NAMES[`KOTLIN_${name}`] = id;
  ATTRIBUTE_NAMES[name] = id;
}
Object.assign(ATTRIBUTE_NAMES, {
  KOTLIN_MUTABLE_VARIABLE: "identifier",
  KOTLIN_PACKAGE_PROPERTY: "field",
  KOTLIN_SYNTHETIC_EXTENSION_PROPERTY: "field",
  KOTLIN_EXTENSION_FUNCTION_CALL: "functionCall",
  KOTLIN_NAMED_ARGUMENT: "parameter",
  KOTLIN_OBJECT: "className",
});

const COLOR_NAMES: Record<string, [string, "foreground" | "background"]> = {
  CARET_COLOR: ["caret", "foreground"],
  CARET_ROW_COLOR: ["caretRow", "background"],
  SELECTION_BACKGROUND: ["selection", "background"],
  INACTIVE_SELECTION_BACKGROUND: ["selectionInactive", "background"],
  GUTTER_BACKGROUND: ["gutter", "background"],
  LINE_NUMBERS_COLOR: ["lineNumber", "foreground"],
  LINE_NUMBER_ON_CARET_ROW_COLOR: ["lineNumberCaret", "foreground"],
  WHITESPACES: ["whitespaces", "foreground"],
  INDENT_GUIDE: ["indentGuide", "foreground"],
  RIGHT_MARGIN_COLOR: ["rightMargin", "foreground"],
  METHOD_SEPARATORS_COLOR: ["methodSeparator", "foreground"],
};
// Preserve editor attributes without a standard exchange name on our own round trip.
for (const attr of ATTRIBUTES)
  if (!Object.values(ATTRIBUTE_NAMES).includes(attr.id)) ATTRIBUTE_NAMES[`OPENIDEA_${attr.id}`] = attr.id;

const EFFECTS: Record<string, TextAttributesOverride["effect"]> = {
  "0": "underline",
  "1": "wave",
  "3": "strikeout",
  "4": "underline",
};
const children = (el: Element, tag: string) => Array.from(el.children).filter((e) => e.tagName === tag);
const color = (v: string | null): string | undefined =>
  v && /^[0-9a-f]{1,6}$/i.test(v) ? `#${v.padStart(6, "0").toLowerCase()}` : undefined;

export function parseIcls(xml: string): { scheme: CustomColorScheme; applied: number; skipped: number } {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const root = doc.documentElement;
  if (
    doc.querySelector("parsererror") ||
    doc.doctype ||
    root.tagName !== "scheme" ||
    !root.getAttribute("name")?.trim()
  )
    throw new Error("Invalid .icls color scheme");
  const attributes: Record<string, TextAttributesOverride> = {};
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
      for (const entry of children(section, "option")) {
        const name = entry.getAttribute("name") ?? "";
        const id = Object.hasOwn(ATTRIBUTE_NAMES, name) ? ATTRIBUTE_NAMES[name] : undefined;
        if (!id) {
          skipped++;
          continue;
        }
        const value = children(entry, "value")[0];
        if (!value) {
          skipped++;
          continue;
        }
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
          const attr = ATTRIBUTES.find((a) => a.id === id)!;
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
          } else if (name === "EFFECT_TYPE" && (attr.token || attr.effect) && raw && Object.hasOwn(EFFECTS, raw)) {
            merge(id, { effect: EFFECTS[raw] });
            applied++;
          } else skipped++;
        }
      }
  }
  const parentName = root.getAttribute("parent_scheme") ?? "";
  const bg = attributes.text?.background;
  const rgb = bg ? [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16)) : [255, 255, 255];
  const dark = rgb[0]! * 0.299 + rgb[1]! * 0.587 + rgb[2]! * 0.114 < 128;
  const parent = /darcula|dark/i.test(parentName)
    ? "dark"
    : /default|light/i.test(parentName)
      ? "light"
      : dark
        ? "dark"
        : "light";
  return { scheme: { name: root.getAttribute("name")!.trim(), parent, attributes }, applied, skipped };
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
  for (const attr of ATTRIBUTES) {
    const key = Object.keys(ATTRIBUTE_NAMES).find((key) => ATTRIBUTE_NAMES[key] === attr.id);
    if (!key) continue;
    const v = values(attr);
    const opts: string[] = [];
    for (const [key, field] of [
      ["FOREGROUND", "foreground"],
      ["BACKGROUND", "background"],
      ["EFFECT_COLOR", "effectColor"],
    ] as const)
      if (isHexColor(v[field])) opts.push(`<option name="${key}" value="${exportColor(v[field]!)}" />`);
    if (attr.token) opts.push(`<option name="FONT_TYPE" value="${(v.bold ? 1 : 0) + (v.italic ? 2 : 0)}" />`);
    const effect = Object.entries(EFFECTS).find(([, value]) => value === v.effect)?.[0];
    if (effect) opts.push(`<option name="EFFECT_TYPE" value="${effect}" />`);
    if (opts.length) attributes.push(`    <option name="${key}"><value>${opts.join("")}</value></option>`);
  }
  const parent = custom?.parent ?? (isBuiltinTheme(id) ? themeKind(id) : "dark");
  return `<scheme name="${escapeXml(name)}" version="142" parent_scheme="${parent === "dark" ? "Darcula" : "Default"}">\n  <colors>\n${colors.join("\n")}\n  </colors>\n  <attributes>\n${attributes.join("\n")}\n  </attributes>\n</scheme>\n`;
}
