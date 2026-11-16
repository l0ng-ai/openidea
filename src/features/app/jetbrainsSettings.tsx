/**
 * Import Settings… with a JetBrains `settings.zip`: maps the archive's colour
 * schemes, keymaps, fonts, tabs and indents, and the editor / general options
 * OpenIDEA has to settings writes, after a confirmation listing them. Only keys
 * present in the archive are written (JetBrains leaves defaults out). The rest
 * is listed as not imported.
 */
import { Fragment } from "react";
import type { CustomKeymap, JetBrainsSettings, LanguageCodeStyle } from "@/bindings";
import { customSchemes } from "@/platform/colorScheme";
import { createFontProbeCanvas, fontsLoaded, monoFontFamily } from "@/platform/fonts";
import { tx } from "@/platform/i18n";
import { importScheme, parseIcls } from "@/platform/icls";
import { addIdeaKeymap, parseIdeaKeymap } from "@/platform/ideaKeymap";
import { call, commands } from "@/platform/ipc";
import { guessOs } from "@/platform/platformInfo";
import { useProject } from "@/platform/project";
import { notifications } from "@/workbench/contributions";
import { ask } from "@/workbench/messages";
import styles from "./app.module.css";
import {
  CODE_INSIGHT_FLAGS,
  CODE_INSIGHT_NUMBERS,
  CODE_STYLE_LANGUAGES,
  EDITOR_FLAGS,
  EDITOR_NUMBERS,
  REFORMAT_ON_PASTE,
  SMART_BACKSPACE,
} from "./jetbrainsOptions";

export interface JetBrainsImportPlan {
  /** Settings writes, in order: `settingsSet("global", key, JSON.stringify(value))`. */
  writes: [key: string, value: unknown][];
  /** What the confirmation lists (translated): the setting and its imported value. */
  rows: { label: string; value: string }[];
  /** Categories present in the archive that are not imported (translated). */
  skipped: string[];
  /** Colour scheme and keymap files that could not be read. */
  invalid: string[];
  /** IDEA action ids the imported keymaps bind that have no counterpart here. */
  unknownActions: string[];
}

/** The settings the import builds on (`settingsGetGlobal`). */
interface CurrentSettings {
  editor: {
    fontFamily: string;
    fontSize: number | null;
    customSchemes: unknown;
    colorOverrides: Record<string, unknown>;
    codeStyle?: { languages?: Record<string, LanguageCodeStyle> };
  };
  customKeymaps?: Record<string, CustomKeymap>;
}

const USER_PREFIX = "_@user_";

/**
 * `<option name value>` of `<component name>`; empty when the file or component is
 * absent. With `tag`, the `name` of that child element instead, under key "".
 */
function options(xml: string | undefined, component: string, tag?: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!xml) return out;
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) return out;
  for (const c of Array.from(doc.documentElement.children))
    if (c.tagName === "component" && c.getAttribute("name") === component)
      for (const o of Array.from(c.children)) {
        const name = o.getAttribute("name");
        const value = o.getAttribute("value");
        if (tag && o.tagName === tag && name !== null) out.set("", name);
        else if (!tag && o.tagName === "option" && name && value !== null) out.set(name, value);
      }
  return out;
}

const bool = (v: string | undefined) => (v === undefined ? undefined : v === "true");
const num = (v: string | undefined) => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

const onOff = (v: boolean) => (v ? tx("On") : tx("Off"));

/** IDEA's `LINE_SPACING` when the export leaves it out. */
const DEFAULT_LINE_SPACING = 1.2;

/** The font's own line height in px, as IDEA's editor takes it from Java's FontMetrics. */
export type FontHeight = (family: string, size: number) => Promise<number | undefined> | number | undefined;

/** WebKit reports whole-pixel metrics; measured this large, they keep the font's fractions. */
const PROBE_SIZE = 1000;

async function measuredFontHeight(family: string, size: number): Promise<number | undefined> {
  // The editor's own stack: WKWebView draws an installed font only through its loaded alias.
  const stack = monoFontFamily(family);
  await fontsLoaded(stack, size);
  const canvas = createFontProbeCanvas();
  try {
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.font = `${PROBE_SIZE}px ${stack}`;
    const m = ctx.measureText("M");
    // Java rounds the ascent and the descent up separately (anything past .05 of a pixel).
    const px = (v: number) => Math.floor((v / PROBE_SIZE) * size + 0.95);
    const h = px(m.fontBoundingBoxAscent) + px(m.fontBoundingBoxDescent);
    return Number.isFinite(h) && h > 0 ? h : undefined;
  } finally {
    canvas.remove();
  }
}

/** `<option name value>` children of `parent`. */
function optionValues(parent: Element | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const o of Array.from(parent?.children ?? [])) {
    const name = o.getAttribute("name");
    const value = o.getAttribute("value");
    if (o.tagName === "option" && name && value !== null) out.set(name, value);
  }
  return out;
}

const childOf = (parent: Element, tag: string, name?: string) =>
  Array.from(parent.children).find((c) => c.tagName === tag && (name === undefined || c.getAttribute("name") === name));

/** The code style scheme called `name` among `codestyles/*.xml`. */
function codeScheme(files: Record<string, string>, name: string): Element | undefined {
  for (const [file, text] of Object.entries(files)) {
    if (!file.startsWith("codestyles/")) continue;
    const doc = new DOMParser().parseFromString(text, "application/xml");
    const root = doc.documentElement;
    if (!doc.querySelector("parsererror") && root.tagName === "code_scheme" && root.getAttribute("name") === name)
      return root;
  }
  return undefined;
}

export async function planJetBrainsImport(
  bundle: JetBrainsSettings,
  current: CurrentSettings,
  fontHeight: FontHeight = measuredFontHeight,
): Promise<JetBrainsImportPlan> {
  const { editor } = current;
  const plan: JetBrainsImportPlan = { writes: [], rows: [], skipped: [], invalid: [], unknownActions: [] };
  const add = (key: string, value: string | number | boolean | undefined, label: string, shown?: string) => {
    if (value === undefined) return;
    plan.writes.push([key, value]);
    plan.rows.push({ label, value: shown ?? (typeof value === "boolean" ? onOff(value) : String(value)) });
  };

  let customs = customSchemes(editor.customSchemes);
  let overrides = editor.colorOverrides;
  const imported = new Map<string, string>(); // name in the .icls → scheme id
  for (const [file, text] of Object.entries(bundle.files)) {
    if (!file.startsWith("colors/")) continue;
    let parsed;
    try {
      parsed = parseIcls(text);
    } catch {
      plan.invalid.push(file.slice("colors/".length));
      continue;
    }
    const original = parsed.scheme.name;
    const name = original.startsWith(USER_PREFIX) ? original.slice(USER_PREFIX.length) : original;
    // Overwrites an earlier import of the same scheme instead of adding "Name (2)".
    const next = importScheme(customs, { ...parsed.scheme, name }, true);
    customs = next.customs;
    if (overrides[next.id]) overrides = Object.fromEntries(Object.entries(overrides).filter(([id]) => id !== next.id));
    imported.set(original, next.id);
    plan.rows.push({ label: tx("Color Scheme"), value: customs[next.id]?.name ?? name });
  }
  if (imported.size) {
    plan.writes.push(["editor.customSchemes", customs]);
    if (overrides !== editor.colorOverrides) plan.writes.push(["editor.colorOverrides", overrides]);
    const global = options(bundle.files["options/colors.scheme.xml"], "EditorColorsManagerImpl", "global_color_scheme");
    const id = imported.get(global.get("") ?? "");
    if (id) add("editor.colorScheme", id, tx("Current color scheme"), customs[id]?.name);
  }

  let keymaps = current.customKeymaps ?? {};
  const importedKeymaps = new Map<string, string>(); // name in the keymap file → keymap id
  for (const [file, text] of Object.entries(bundle.files)) {
    if (!file.startsWith("keymaps/")) continue;
    let parsed;
    try {
      parsed = parseIdeaKeymap(text);
    } catch {
      plan.invalid.push(file.slice("keymaps/".length));
      continue;
    }
    // Overwrites an earlier import of the same keymap, as colour schemes do.
    const next = addIdeaKeymap(keymaps, parsed);
    keymaps = next.customs;
    importedKeymaps.set(parsed.name, next.id);
    plan.unknownActions.push(...parsed.unknownActions.filter((id) => !plan.unknownActions.includes(id)));
    plan.rows.push({ label: tx("Keymap"), value: keymaps[next.id]?.name ?? parsed.name });
  }
  if (importedKeymaps.size) {
    plan.writes.push(["customKeymaps", keymaps]);
    // The active keymap is stored per operating system; a bundled one keeps OpenIDEA's choice.
    const os = { macos: "mac", windows: "windows", linux: "linux", web: "" }[guessOs()];
    const active = options(bundle.files[`options/${os}/keymap.xml`], "KeymapManager", "active_keymap").get("");
    const id = importedKeymaps.get(active ?? "");
    if (id) add("keymap", id, tx("Current keymap"), keymaps[id]?.name);
  }

  const font = options(bundle.files["options/editor-font.xml"], "DefaultFont");
  const family = font.get("FONT_FAMILY")?.trim() || undefined;
  add("editor.fontFamily", family, tx("Font"));
  const size = num(font.get("FONT_SIZE"));
  add("editor.fontSize", size, tx("Size"));
  const spacing = num(font.get("LINE_SPACING"));
  // IDEA spaces lines by the font's own height, not its size, so a tall font keeps its
  // spacing; and the default spacing still applies when only the font changed.
  const base = size ?? editor.fontSize;
  if (base && (family || size || spacing)) {
    const natural = (await fontHeight(family ?? editor.fontFamily, base)) ?? base * DEFAULT_LINE_SPACING;
    add("editor.lineHeight", Math.ceil(natural * (spacing ?? DEFAULT_LINE_SPACING)), tx("Line height"));
  }
  add("editor.ligatures", bool(font.get("USE_LIGATURES")), tx("Enable ligatures"));

  const terminal = options(bundle.files["options/terminal-font.xml"], "TerminalFontOptions");
  const terminalFamily = terminal.get("FONT_FAMILY")?.trim() || undefined;
  const terminalSize = num(terminal.get("FONT_SIZE"));
  // A terminal font of its own: stop following the editor font (the font rows below say so).
  if (terminalFamily || terminalSize) plan.writes.push(["terminal.useEditorFont", false]);
  add("terminal.fontFamily", terminalFamily, tx("Terminal font"));
  add("terminal.fontSize", terminalSize, tx("Terminal font size"));
  add("terminal.lineHeight", num(terminal.get("LINE_SPACING")), tx("Terminal line height"));
  add("terminal.columnWidth", num(terminal.get("COLUMN_SPACING")), tx("Terminal column width"));
  add(
    "terminal.fallbackFontFamily",
    terminal.get("SECONDARY_FONT_FAMILY")?.trim() || undefined,
    tx("Terminal fallback font"),
  );

  const ed = options(bundle.files["options/editor.xml"], "EditorSettings");
  const strip = ed.get("STRIP_TRAILING_SPACES"); // None | Changed | Whole
  if (strip === "Changed" || strip === "Whole") {
    const scope = strip === "Whole" ? "all" : "modified";
    plan.writes.push(["files.trimTrailingWhitespace", true]);
    add(
      "editor.general.stripTrailingScope",
      scope,
      tx("Remove trailing spaces on:"),
      tx(strip === "Whole" ? "All lines" : "Modified lines"),
    );
  } else if (strip === "None") add("files.trimTrailingWhitespace", false, tx("Remove trailing spaces on:"));
  add(
    "files.ensureFinalNewline",
    bool(ed.get("IS_ENSURE_NEWLINE_AT_EOF")),
    tx("Ensure every saved file ends with a line break"),
  );
  add("editor.stickyScroll", bool(ed.get("SHOW_STICKY_LINES")), tx("Show sticky lines while scrolling"));
  add("editor.showWhitespace", bool(ed.get("IS_WHITESPACES_SHOWN")), tx("Show whitespaces"));
  // A comma-separated list of places: MAIN_EDITOR, CONSOLE, PREVIEW.
  const wraps = ed.get("USE_SOFT_WRAPS");
  add(
    "editor.softWrap",
    wraps === undefined ? undefined : wraps.split(",").includes("MAIN_EDITOR"),
    tx("Soft-wrap files"),
  );
  add(
    "console.softWrap",
    wraps === undefined ? undefined : wraps.split(",").includes("CONSOLE"),
    tx("Use soft wraps in console"),
  );
  add("editor.general.softWrapFiles", ed.get("SOFT_WRAP_FILE_MASKS")?.trim() || undefined, tx("File patterns"));
  const numeration = { ABSOLUTE: "Absolute", RELATIVE: "Relative", HYBRID: "Hybrid" }[ed.get("LINE_NUMERATION") ?? ""];
  add("editor.appearance.lineNumberMode", numeration?.toLowerCase(), tx("Show line numbers"), tx(numeration ?? ""));
  const above = bool(ed.get("SHOW_BREADCRUMBS_ABOVE"));
  add(
    "editor.breadcrumbs.placement",
    above === undefined ? undefined : above ? "top" : "bottom",
    tx("Show breadcrumbs:"),
    tx(above ? "Top" : "Bottom"),
  );
  const insight = options(bundle.files["options/editor.xml"], "CodeInsightSettings");
  for (const [source, flags, numbers] of [
    [ed, EDITOR_FLAGS, EDITOR_NUMBERS],
    [insight, CODE_INSIGHT_FLAGS, CODE_INSIGHT_NUMBERS],
  ] as const) {
    for (const [name, [key, label]] of Object.entries(flags)) add(key, bool(source.get(name)), tx(label));
    for (const [name, [key, label]] of Object.entries(numbers)) add(key, num(source.get(name)), tx(label));
  }
  const paste = REFORMAT_ON_PASTE[insight.get("REFORMAT_ON_PASTE") ?? ""];
  add("editor.smartKeys.reformatOnPaste", paste?.[0], tx("Reformat on paste"), tx(paste?.[1] ?? ""));
  const backspace = SMART_BACKSPACE[insight.get("SMART_BACKSPACE") ?? ""];
  add("editor.smartKeys.backspaceUnindent", backspace?.[0], tx("Unindent"), tx(backspace?.[1] ?? ""));

  // Tabs and Indents of the current code style scheme; its other formatting options have no setting here.
  const schemeName =
    options(bundle.files["options/code.style.schemes.xml"], "CodeStyleSchemeSettings").get("CURRENT_SCHEME_NAME") ??
    "Default";
  const scheme = codeScheme(bundle.files, schemeName);
  if (scheme) {
    const root = optionValues(scheme);
    add("editor.codeStyle.hardWrapAt", num(root.get("RIGHT_MARGIN")), tx("Hard wrap at"));
    add(
      "editor.codeStyle.detectIndents",
      bool(root.get("AUTODETECT_INDENTS")),
      tx("Detect and use existing file indents for editing"),
    );
    // "Other File Types": the indent of languages without a code style of their own.
    const other = optionValues(childOf(childOf(scheme, "option", "OTHER_INDENT_OPTIONS") ?? scheme, "value"));
    add("editor.tabSize", num(other.get("TAB_SIZE")), tx("Tab size"));
    const otherTabs = bool(other.get("USE_TAB_CHARACTER"));
    add(
      "editor.insertSpaces",
      otherTabs === undefined ? undefined : !otherTabs,
      tx("Use tab character"),
      otherTabs === undefined ? undefined : onOff(otherTabs),
    );

    const languages = { ...editor.codeStyle?.languages };
    let changed = false;
    for (const block of Array.from(scheme.children)) {
      const ids = CODE_STYLE_LANGUAGES[block.getAttribute("language") ?? ""];
      if (block.tagName !== "codeStyleSettings" || !ids) continue;
      const own = optionValues(block);
      const indent = optionValues(childOf(block, "indentOptions"));
      const style: Partial<LanguageCodeStyle> = {};
      const shown: string[] = [];
      const set = <K extends keyof LanguageCodeStyle>(
        key: K,
        value: LanguageCodeStyle[K] | undefined,
        label: string,
      ) => {
        if (value === undefined) return;
        style[key] = value;
        shown.push(`${tx(label)} ${typeof value === "boolean" ? onOff(value) : value}`);
      };
      set("indent", num(indent.get("INDENT_SIZE")), "Indent");
      set("tabSize", num(indent.get("TAB_SIZE")), "Tab size");
      set("useTab", bool(indent.get("USE_TAB_CHARACTER")), "Use tab character");
      set("hardWrapAt", num(own.get("RIGHT_MARGIN")), "Hard wrap at");
      set("lineCommentAtFirstColumn", bool(own.get("LINE_COMMENT_AT_FIRST_COLUMN")), "Line comment at first column");
      set("lineCommentAddSpace", bool(own.get("LINE_COMMENT_ADD_SPACE")), "Add a space at line comment start");
      if (!shown.length) continue;
      for (const id of ids) languages[id] = { ...languages[id], ...style } as LanguageCodeStyle;
      changed = true;
      plan.rows.push({ label: `${tx("Code Style")} › ${block.getAttribute("language")}`, value: shown.join(", ") });
    }
    if (changed) plan.writes.push(["editor.codeStyle.languages", languages]);
  }

  const general = options(bundle.files["options/ide.general.xml"], "GeneralSettings");
  add("general.confirmExit", bool(general.get("confirmExit")), tx("Confirm before exiting the IDE"));

  const has = (prefix: string) => bundle.entries.some((e) => e.startsWith(prefix));
  if (has("codestyles/")) plan.skipped.push(tx("Code Style options other than Tabs and Indents"));
  if (has("templates/")) plan.skipped.push(tx("Live templates"));
  if (has("inspection/")) plan.skipped.push(tx("Inspections"));
  if (has("installed.txt")) plan.skipped.push(tx("Plugins"));
  return plan;
}

function Summary({ plan }: { plan: JetBrainsImportPlan }) {
  const left = [...plan.skipped, ...plan.invalid];
  const unknown = plan.unknownActions;
  return (
    <div className={styles.importSummary}>
      <div>{tx("These settings will be imported:")}</div>
      <dl className={styles.importList}>
        {plan.rows.map((row, i) => (
          <Fragment key={i}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </Fragment>
        ))}
      </dl>
      {left.length > 0 && (
        <div>
          {tx("Not imported:")} {left.join(", ")}
        </div>
      )}
      {unknown.length > 0 && <div>{tx`Not available in OpenIDEA (${unknown.length}): ${unknown.join(", ")}.`}</div>}
    </div>
  );
}

/** Reads `path`, asks, then writes the mapped settings to the global layer. */
export async function importJetBrainsSettings(path: string) {
  const bundle = await call(commands.settingsReadJetbrains(path));
  const plan = await planJetBrainsImport(bundle, await commands.settingsGetGlobal());
  if (!plan.writes.length) {
    notifications().notify({
      level: "warning",
      title: "No settings OpenIDEA can import were found",
      key: "app.settingsImport",
    });
    return;
  }
  const { button } = await ask({
    title: tx("Import JetBrains Settings"),
    body: <Summary plan={plan} />,
    buttons: [{ id: "import", label: tx("Import"), primary: true }],
    width: 520,
  });
  if (button !== "import") return;
  let settings = useProject.getState().settings;
  for (const [key, value] of plan.writes)
    settings = await call(commands.settingsSet("global", key, JSON.stringify(value)));
  useProject.setState({ settings });
  notifications().notify({ level: "info", title: "Settings imported", body: path, key: "app.settingsImport" });
}
