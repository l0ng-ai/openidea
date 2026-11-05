/**
 * Converts an IntelliJ theme (`.theme.json`, optionally with its editor scheme
 * `.icls`) into an OpenIDEA theme + editor scheme, and an IntelliJ theme
 * plugin into an OpenIDEA theme plugin package. The mapping covers the main
 * keys only; anything unmapped keeps the built-in value of the base (`kind`).
 *
 * Pure functions without imports: Settings › Plugins › Import IntelliJ Theme
 * uses them on what the host read from the plugin (`plugin_read_intellij_theme`),
 * and so does the command line (`scripts/theme/import-intellij-theme.ts`).
 */

/** OpenIDEA token ← IntelliJ `ui` keys, first present wins. `*.prop` wildcards apply too. */
export const UI_KEYS: Record<string, string[]> = {
  "--bg-app": ["Panel.background"],
  "--bg-frame": ["MainWindow.background", "MainToolbar.background", "Panel.background"],
  "--bg-island": ["ToolWindow.background", "Panel.background"],
  "--bg-elev": ["ToolWindow.background", "SidePanel.background"],
  "--bg-popup": ["Popup.background", "PopupMenu.background"],
  "--bg-floating-toolbar": ["Toolbar.Floating.background"],
  "--bg-backdrop": ["Popup.background"],
  "--bg-hover": ["List.hoverBackground", "Tree.hoverBackground"],
  "--bg-selected": ["List.selectionBackground", "Tree.selectionBackground"],
  "--bg-selected-strong": ["List.selectionBackground"],
  "--bg-tree-selected": ["Tree.selectionBackground", "List.selectionBackground"],
  "--bg-tree-selected-inactive": ["Tree.selectionInactiveBackground", "List.selectionInactiveBackground"],
  "--bg-input": ["TextField.background"],
  "--bg-field": ["TextField.background"],
  "--bg-dialog": ["Dialog.background", "Panel.background"],
  "--border": ["Borders.color"],
  "--border-popup": ["Popup.borderColor", "Popup.Border.color"],
  "--border-strong": ["Component.borderColor", "Borders.ContrastBorderColor"],
  "--border-window": ["Borders.ContrastBorderColor", "Component.borderColor"],
  "--fg": ["Label.foreground"],
  "--fg-emphasis": ["Label.foreground"],
  "--fg-strong": ["Label.selectedForeground", "Label.foreground"],
  "--fg-secondary": ["Label.infoForeground", "Component.infoForeground"],
  "--fg-muted": ["Label.infoForeground", "Component.infoForeground"],
  "--fg-subtle": ["Label.disabledForeground"],
  "--fg-faint": ["Label.disabledForeground"],
  "--accent": ["Button.default.startBackground", "Button.default.background", "Component.focusColor"],
  "--fg-on-accent": ["Button.default.foreground"],
  "--fg-button-primary": ["Button.default.foreground"],
  "--focus-ring-soft": ["Component.focusColor"],
  "--link": ["Link.activeForeground", "Hyperlink.linkColor"],
  "--link-hover": ["Link.hoverForeground", "Link.activeForeground"],
  "--danger": ["Component.errorFocusColor"],
  "--warning": ["Component.warningFocusColor"],
  "--bg-tooltip": ["ToolTip.background"],
  "--fg-tooltip": ["ToolTip.foreground"],
  "--border-tooltip": ["ToolTip.borderColor"],
  "--bg-button": ["Button.startBackground", "Button.background"],
  "--border-button": ["Button.startBorderColor", "Button.borderColor"],
  "--bg-checkbox": ["Checkbox.Background.Default"],
  "--border-checkbox": ["Checkbox.Border.Default"],
  "--bg-tab-selected": ["EditorTabs.underlinedTabBackground", "EditorTabs.selectedBackground"],
  // Islands paints the selected tab's border with `underlinedBorderColor`; the classic tabs underline with `underlineColor`.
  "--border-tab-selected": ["EditorTabs.underlinedBorderColor", "EditorTabs.underlineColor"],
  "--bg-tab-hover": ["EditorTabs.hoverBackground"],
  "--border-editor-tabs": ["EditorTabs.borderColor"],
  "--bg-toolbar-hover": ["ActionButton.hoverBackground"],
  "--bg-toolbar-pressed": ["ActionButton.pressedBackground"],
  "--bg-stripe-hover": ["ToolWindow.Button.hoverBackground"],
  "--bg-stripe-selected": ["ToolWindow.Button.selectedBackground"],
  "--scrollbar-thumb": ["ScrollBar.Mac.thumbColor", "ScrollBar.thumbColor"],
  "--scrollbar-thumb-hover": ["ScrollBar.Mac.hoverThumbColor", "ScrollBar.hoverThumbColor"],
  "--bg-progress-track": ["ProgressBar.trackColor"],
  "--bg-counter": ["Counter.background"],
  "--fg-counter": ["Counter.foreground"],
  "--bg-search-match": ["SearchMatch.startBackground", "SearchMatch.endBackground"],
  "--fg-completion-match": ["CompletionPopup.matchForeground"],
  "--bg-toggle-on": ["ToggleButton.onBackground"],
  "--fg-toggle-on": ["ToggleButton.onForeground"],
  "--bg-toggle-off": ["ToggleButton.offBackground"],
  "--fg-toggle-off": ["ToggleButton.offForeground"],
  "--border-toggle": ["ToggleButton.borderColor"],
  "--bg-toggle-knob": ["ToggleButton.buttonColor"],
  "--bg-feedback-info": ["Banner.infoBackground"],
  "--border-feedback-info": ["Banner.infoBorderColor"],
  "--bg-feedback-error": ["Banner.errorBackground"],
  "--border-feedback-error": ["Banner.errorBorderColor"],
  "--bg-feedback-warning": ["Banner.warningBackground"],
  "--border-feedback-warning": ["Banner.warningBorderColor"],
  "--bg-feedback-success": ["Banner.successBackground"],
  "--border-feedback-success": ["Banner.successBorderColor"],
};

/** `.icls` `<colors>` options → tokens. */
export const ICLS_COLORS: Record<string, string[]> = {
  CARET_COLOR: ["--caret"],
  CARET_ROW_COLOR: ["--bg-current-line"],
  SELECTION_BACKGROUND: ["--bg-editor-selection"],
  LINE_NUMBERS_COLOR: ["--fg-line-number"],
  LINE_NUMBER_ON_CARET_ROW_COLOR: ["--fg-line-number-current"],
  // The new UI paints the gutter with this, else with the editor's background; `GUTTER_BACKGROUND` is the classic UI's.
  EDITOR_GUTTER_BACKGROUND: ["--bg-editor-gutter"],
  INDENT_GUIDE: ["--border-indent-guide"],
  SELECTED_INDENT_GUIDE: ["--border-indent-guide-active"],
  RIGHT_MARGIN_COLOR: ["--border-right-margin"],
  WHITESPACES: ["--fg-whitespace"],
  METHOD_SEPARATORS_COLOR: ["--border-method-separator"],
  FILESTATUS_MODIFIED: ["--vcs-modified"],
  FILESTATUS_ADDED: ["--vcs-added"],
  FILESTATUS_DELETED: ["--vcs-deleted"],
  FILESTATUS_UNKNOWN: ["--vcs-untracked"],
  FILESTATUS_IDEA_FILESTATUS_IGNORED: ["--vcs-ignored"],
  FILESTATUS_IDEA_FILESTATUS_MERGED_WITH_CONFLICTS: ["--vcs-conflict"],
  MODIFIED_LINES_COLOR: ["--gutter-modified"],
  ADDED_LINES_COLOR: ["--gutter-added"],
  DELETED_LINES_COLOR: ["--gutter-deleted"],
};

type Part = "FOREGROUND" | "BACKGROUND" | "EFFECT_COLOR";

/** `.icls` `<attributes>` options → [part, token] pairs. */
export const ICLS_ATTRIBUTES: Record<string, Array<[Part, string]>> = {
  TEXT: [
    ["FOREGROUND", "--fg-editor"],
    ["BACKGROUND", "--bg-editor"],
  ],
  DIFF_MODIFIED: [["BACKGROUND", "--diff-modified"]],
  DIFF_INSERTED: [["BACKGROUND", "--diff-inserted"]],
  DIFF_DELETED: [["BACKGROUND", "--diff-deleted"]],
  DEFAULT_KEYWORD: [["FOREGROUND", "--syn-keyword"]],
  DEFAULT_STRING: [["FOREGROUND", "--syn-string"]],
  DEFAULT_NUMBER: [["FOREGROUND", "--syn-number"]],
  DEFAULT_LINE_COMMENT: [["FOREGROUND", "--syn-comment"]],
  DEFAULT_DOC_COMMENT: [["FOREGROUND", "--syn-doc-comment"]],
  DEFAULT_FUNCTION_DECLARATION: [["FOREGROUND", "--syn-function"]],
  DEFAULT_FUNCTION_CALL: [["FOREGROUND", "--syn-function-call"]],
  DEFAULT_CLASS_NAME: [["FOREGROUND", "--syn-type"]],
  DEFAULT_CONSTANT: [["FOREGROUND", "--syn-constant"]],
  DEFAULT_INSTANCE_FIELD: [["FOREGROUND", "--syn-property"]],
  DEFAULT_IDENTIFIER: [["FOREGROUND", "--syn-variable"]],
  DEFAULT_LOCAL_VARIABLE: [["FOREGROUND", "--syn-variable"]],
  DEFAULT_PARAMETER: [["FOREGROUND", "--syn-param"]],
  DEFAULT_GLOBAL_VARIABLE: [["FOREGROUND", "--syn-global"]],
  DEFAULT_PREDEFINED_SYMBOL: [["FOREGROUND", "--syn-builtin"]],
  DEFAULT_METADATA: [
    ["FOREGROUND", "--syn-annotation"],
    ["FOREGROUND", "--syn-decorator"],
  ],
  DEFAULT_OPERATION_SIGN: [["FOREGROUND", "--syn-punct"]],
  DEFAULT_VALID_STRING_ESCAPE: [["FOREGROUND", "--syn-escape"]],
  DEFAULT_TAG: [["FOREGROUND", "--syn-tag"]],
  DEFAULT_ATTRIBUTE: [["FOREGROUND", "--syn-attribute"]],
  TODO_DEFAULT_ATTRIBUTES: [["FOREGROUND", "--syn-todo"]],
  BAD_CHARACTER: [["FOREGROUND", "--syn-invalid"]],
  RAINBOW_COLOR1: [["FOREGROUND", "--syn-rainbow-1"]],
  RAINBOW_COLOR2: [["FOREGROUND", "--syn-rainbow-2"]],
  RAINBOW_COLOR3: [["FOREGROUND", "--syn-rainbow-3"]],
  RAINBOW_COLOR4: [["FOREGROUND", "--syn-rainbow-4"]],
  RAINBOW_COLOR5: [["FOREGROUND", "--syn-rainbow-5"]],
  ERRORS_ATTRIBUTES: [["EFFECT_COLOR", "--wave-error"]],
  WARNING_ATTRIBUTES: [["EFFECT_COLOR", "--wave-warning"]],
  NOT_USED_ELEMENT_ATTRIBUTES: [["FOREGROUND", "--fg-unused"]],
  MATCHED_BRACE_ATTRIBUTES: [["BACKGROUND", "--bg-matched-brace"]],
  SEARCH_RESULT_ATTRIBUTES: [["BACKGROUND", "--bg-search-match"]],
  TEXT_SEARCH_RESULT_ATTRIBUTES: [["BACKGROUND", "--bg-text-search-result"]],
  IDENTIFIER_UNDER_CARET_ATTRIBUTES: [["BACKGROUND", "--bg-identifier-under-caret"]],
  WRITE_IDENTIFIER_UNDER_CARET_ATTRIBUTES: [["BACKGROUND", "--bg-identifier-under-caret-write"]],
  FOLDED_TEXT_ATTRIBUTES: [
    ["FOREGROUND", "--fg-fold-placeholder"],
    ["BACKGROUND", "--bg-fold-placeholder"],
  ],
  INLINE_PARAMETER_HINT: [
    ["FOREGROUND", "--fg-inlay"],
    ["BACKGROUND", "--bg-inlay"],
  ],
  BREAKPOINT_ATTRIBUTES: [["BACKGROUND", "--bg-breakpoint-line"]],
  DEBUGGER_INLINED_VALUES: [["FOREGROUND", "--syn-inline-value"]],
  "PY.SELF_PARAMETER": [["FOREGROUND", "--syn-self"]],
  "PY.KEYWORD_ARGUMENT": [["FOREGROUND", "--syn-keyword-arg"]],
  "PY.DOC_COMMENT": [["FOREGROUND", "--syn-docstring"]],
  "PY.BUILTIN_NAME": [["FOREGROUND", "--syn-predefined"]],
  MARKDOWN_HEADER_LEVEL_1: [["FOREGROUND", "--syn-markup-heading"]],
  MARKDOWN_CODE_SPAN: [["FOREGROUND", "--syn-markup-code"]],
  MARKDOWN_LINK_TEXT: [["FOREGROUND", "--syn-link"]],
  CONSOLE_BLACK_OUTPUT: [["FOREGROUND", "--ansi-black"]],
  CONSOLE_RED_OUTPUT: [["FOREGROUND", "--ansi-red"]],
  CONSOLE_GREEN_OUTPUT: [["FOREGROUND", "--ansi-green"]],
  CONSOLE_YELLOW_OUTPUT: [["FOREGROUND", "--ansi-yellow"]],
  CONSOLE_BLUE_OUTPUT: [["FOREGROUND", "--ansi-blue"]],
  CONSOLE_MAGENTA_OUTPUT: [["FOREGROUND", "--ansi-magenta"]],
  CONSOLE_CYAN_OUTPUT: [["FOREGROUND", "--ansi-cyan"]],
  CONSOLE_GRAY_OUTPUT: [["FOREGROUND", "--ansi-white"]],
  CONSOLE_DARKGRAY_OUTPUT: [["FOREGROUND", "--ansi-bright-black"]],
  CONSOLE_RED_BRIGHT_OUTPUT: [["FOREGROUND", "--ansi-bright-red"]],
  CONSOLE_GREEN_BRIGHT_OUTPUT: [["FOREGROUND", "--ansi-bright-green"]],
  CONSOLE_YELLOW_BRIGHT_OUTPUT: [["FOREGROUND", "--ansi-bright-yellow"]],
  CONSOLE_BLUE_BRIGHT_OUTPUT: [["FOREGROUND", "--ansi-bright-blue"]],
  CONSOLE_MAGENTA_BRIGHT_OUTPUT: [["FOREGROUND", "--ansi-bright-magenta"]],
  CONSOLE_CYAN_BRIGHT_OUTPUT: [["FOREGROUND", "--ansi-bright-cyan"]],
  CONSOLE_WHITE_OUTPUT: [["FOREGROUND", "--ansi-bright-white"]],
};

export interface ConvertedTheme {
  theme: { id: string; name: string; kind: "dark" | "light"; tokens: Record<string, string> };
  scheme: { name: string; tokens: Record<string, string> } | null;
}

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** `"Button": {"default": {"startBackground": x}}` → `Button.default.startBackground`; `"*": {...}` → `*.prop`. */
function flatten(obj: { [k: string]: Json }, prefix = "", out = new Map<string, string>()): Map<string, string> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.set(key, v);
    else if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
  }
  return out;
}

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** IntelliJ colour (`#rrggbb`, `#rrggbbaa`, or a named colour from `colors`) → CSS hex. */
function resolveColor(value: string, named: Map<string, string>, depth = 0): string | null {
  const m = HEX.exec(value.trim());
  if (m) return `#${m[1]!.toLowerCase()}`;
  const ref = named.get(value);
  return ref !== undefined && depth < 8 ? resolveColor(ref, named, depth + 1) : null;
}

/** `.icls` hex: RGB without `#`, leading zeros dropped (`"0"` is black, `"ff"` is #0000ff). */
function iclsColor(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (!/^[0-9a-f]{1,8}$/.test(v)) return null;
  return `#${v.length <= 6 ? v.padStart(6, "0") : v.padStart(8, "0")}`;
}

const attr = (tag: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];

/** Parses the colours and attributes of an `.icls` file into tokens. */
export function convertIcls(xml: string): { name: string; dark: boolean | null; tokens: Record<string, string> } {
  const tokens: Record<string, string> = {};
  const set = (names: string[], color: string | null) => {
    if (color) for (const n of names) tokens[n] ??= color;
  };
  const schemeTag = /<scheme\b[^>]*>/.exec(xml)?.[0] ?? "";
  const name = attr(schemeTag, "name") ?? "Imported";
  const parent = attr(schemeTag, "parent_scheme") ?? "";
  const dark = parent ? /darcula|dark/i.test(parent) : null;

  const colors = /<colors>([\s\S]*?)<\/colors>/.exec(xml)?.[1] ?? "";
  for (const m of colors.matchAll(/<option\b[^>]*\/>/g)) {
    const key = attr(m[0], "name");
    const value = attr(m[0], "value");
    if (key && value !== undefined && ICLS_COLORS[key]) set(ICLS_COLORS[key], iclsColor(value));
  }

  const body = /<attributes>([\s\S]*?)<\/attributes>/.exec(xml)?.[1] ?? "";
  const attributes = new Map<string, Map<string, string>>();
  const empty = new Set<string>();
  for (const m of body.matchAll(
    /<option name="([^"]+)"[^>]*>\s*(?:<value\s*\/>|<value>([\s\S]*?)<\/value>)\s*<\/option>/g,
  )) {
    if (m[2] === undefined) empty.add(m[1]!);
    const parts = new Map<string, string>();
    for (const o of (m[2] ?? "").matchAll(/<option\b[^>]*\/>/g)) {
      const k = attr(o[0], "name");
      const v = attr(o[0], "value");
      if (k && v !== undefined) parts.set(k, v);
    }
    attributes.set(m[1]!, parts);
  }
  const textForeground = iclsColor(attributes.get("TEXT")?.get("FOREGROUND") ?? "");
  for (const [key, parts] of attributes) {
    const map = ICLS_ATTRIBUTES[key];
    if (!map) continue;
    // `<value />` defines the key without colours, so the parent scheme's don't apply: it shows as plain text.
    if (empty.has(key)) {
      for (const [part, token] of map) if (part === "FOREGROUND") set([token], textForeground);
      continue;
    }
    for (const [part, token] of map) set([token], iclsColor(parts.get(part) ?? ""));
    // FONT_TYPE: 1 bold, 2 italic, 3 bold italic.
    if (key === "DEFAULT_LINE_COMMENT" && parts.has("FONT_TYPE")) {
      tokens["--syn-comment-style"] = Number(parts.get("FONT_TYPE")) & 2 ? "italic" : "normal";
    }
  }
  if (tokens["--wave-error"]) tokens["--editor-error-decoration"] = `underline wavy ${tokens["--wave-error"]}`;
  if (tokens["--bg-editor"]) tokens["--bg-editor-gutter"] ??= tokens["--bg-editor"];
  return { name, dark, tokens };
}

export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "imported"
  );
}

/** Converts an IntelliJ `.theme.json` (comments removed) and optionally its `.icls` into OpenIDEA theme files. */
export function convertIntellijTheme(themeJson: string, icls?: string, id?: string): ConvertedTheme {
  const parsed = JSON.parse(themeJson) as Json;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Not an IntelliJ theme");
  const src = parsed;
  const name = typeof src.name === "string" ? src.name : "Imported Theme";
  const named = new Map<string, string>();
  if (src.colors && typeof src.colors === "object" && !Array.isArray(src.colors)) {
    for (const [k, v] of Object.entries(src.colors)) if (typeof v === "string") named.set(k, v);
  }
  const ui =
    src.ui && typeof src.ui === "object" && !Array.isArray(src.ui) ? flatten(src.ui) : new Map<string, string>();
  const lookup = (key: string): string | null => {
    const v = ui.get(key) ?? ui.get(`*.${key.slice(key.lastIndexOf(".") + 1)}`);
    return v === undefined ? null : resolveColor(v, named);
  };

  const tokens: Record<string, string> = {};
  for (const [token, keys] of Object.entries(UI_KEYS)) {
    for (const key of keys) {
      const color = lookup(key);
      if (color) {
        tokens[token] = color;
        break;
      }
    }
  }
  const scheme = icls ? convertIcls(icls) : null;
  const dark = typeof src.dark === "boolean" ? src.dark : (scheme?.dark ?? true);
  // The editor surface sits on an island in OpenIDEA: keep it on the editor background.
  if (scheme?.tokens["--bg-editor"] && !tokens["--bg-island"]) tokens["--bg-island"] = scheme.tokens["--bg-editor"];
  return {
    theme: { id: id ?? slug(name), name, kind: dark ? "dark" : "light", tokens },
    scheme: scheme ? { name: scheme.name, tokens: scheme.tokens } : null,
  };
}

/** A TOML basic string: quotes, backslashes and control characters escaped, lone surrogates replaced. */
function tomlString(s: string): string {
  let body = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '"' || ch === "\\") body += `\\${ch}`;
    else if (code < 0x20 || code === 0x7f) body += `\\u${code.toString(16).padStart(4, "0")}`;
    // `for…of` pairs surrogates, so one in this range is alone.
    else if (code >= 0xd800 && code <= 0xdfff) body += "�";
    else body += ch;
  }
  return `"${body}"`;
}

export interface ThemePackageInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  authors: string[];
}

/** `plugin.toml` for converted themes, each at `themes/<id>.theme.json` (+ `.scheme.json`). */
export function pluginManifest(info: ThemePackageInfo, themes: readonly ConvertedTheme[], comment?: string): string {
  return [
    ...(comment ? [`# ${comment.replace(/[\r\n]+/g, " ")}`] : []),
    `id = ${tomlString(info.id)}`,
    `name = ${tomlString(info.name)}`,
    `version = ${tomlString(info.version)}`,
    `description = ${tomlString(info.description)}`,
    `authors = [${info.authors.map(tomlString).join(", ")}]`,
    `engines.openidea = "^1.0"`,
    ...themes.flatMap((c) => [
      "",
      "[[contributes.themes]]",
      `path = ${tomlString(`themes/${c.theme.id}.theme.json`)}`,
      ...(c.scheme ? [`editor-scheme = ${tomlString(`themes/${c.theme.id}.scheme.json`)}`] : []),
    ]),
    "",
  ].join("\n");
}

/** An IntelliJ theme plugin as the host read it (`IntellijThemeSource`). */
export interface IntellijThemeSource {
  name: string;
  pluginId: string | null;
  version: string | null;
  vendor: string | null;
  themes: { id: string; theme: string; editorScheme: string | null }[];
}

export interface ThemePackage {
  id: string;
  name: string;
  files: { path: string; text: string }[];
}

/** `2.3` → `2.3.0`; IntelliJ plugin versions are not always semver. */
function semver(version: string | null): string {
  const m = /^\s*v?(\d{1,9})(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?/.exec(version ?? "");
  return m ? `${Number(m[1])}.${Number(m[2] ?? 0)}.${Number(m[3] ?? 0)}` : "1.0.0";
}

/** An OpenIDEA theme plugin (`intellij.<plugin>`) with every theme of an IntelliJ theme plugin. */
export function intellijThemePackage(source: IntellijThemeSource): ThemePackage {
  const ids = new Set<string>();
  const themes = source.themes.map((t) => {
    const c = convertIntellijTheme(t.theme, t.editorScheme ?? undefined);
    let id = c.theme.id;
    for (let n = 2; ids.has(id); n++) id = `${c.theme.id.slice(0, 44)}-${n}`;
    ids.add(id);
    c.theme.id = id;
    return c;
  });
  if (themes.length === 0) throw new Error("The plugin has no themes");
  // Package metadata, not UI text: the plugin list shows it as written.
  const description = `${source.name}, imported from an IntelliJ theme plugin.`;
  const info: ThemePackageInfo = {
    id: `intellij.${slug(source.pluginId ?? source.name)}`,
    name: source.name,
    version: semver(source.version),
    description,
    authors: source.vendor ? [source.vendor] : [],
  };
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  return {
    id: info.id,
    name: info.name,
    files: [
      { path: "plugin.toml", text: pluginManifest(info, themes) },
      ...themes.flatMap((c) => [
        { path: `themes/${c.theme.id}.theme.json`, text: json(c.theme) },
        ...(c.scheme ? [{ path: `themes/${c.theme.id}.scheme.json`, text: json(c.scheme) }] : []),
      ]),
    ],
  };
}
