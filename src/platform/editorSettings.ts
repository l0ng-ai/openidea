/**
 * Frontend shape of the Editor settings added for IDEA's Editor group
 * (mirrors `ide-core::editor_settings`). Validation is structural: every
 * value is coerced to the type of its default, so a malformed TOML entry
 * falls back to the default instead of reaching the editor.
 */
import { useProject } from "./project";

export interface TextAttributesOverride {
  foreground?: string;
  background?: string;
  bold?: boolean;
  italic?: boolean;
  effect?: "underline" | "wave" | "strikeout" | "none";
  effectColor?: string;
}

export interface LanguageCodeStyle {
  useTab?: boolean;
  tabSize?: number;
  indent?: number;
  hardWrapAt?: number;
  /** Code Generation › Comment Code (unset: the language's default, see `lineCommentDefaults`). */
  lineCommentAtFirstColumn?: boolean;
  lineCommentAddSpace?: boolean;
}

/**
 * IDEA's per-language Comment Code defaults: line comments at the first column
 * without a space, except where the language's code
 * style says otherwise (Python's indented `# `; Go and Rust's indented `// `).
 */
const LINE_COMMENT_DEFAULTS: Record<string, { atFirstColumn: boolean; addSpace: boolean }> = {
  python: { atFirstColumn: false, addSpace: true },
  go: { atFirstColumn: false, addSpace: true },
  rust: { atFirstColumn: false, addSpace: true },
};

export function lineCommentDefaults(language: string | undefined): { atFirstColumn: boolean; addSpace: boolean } {
  return (language && LINE_COMMENT_DEFAULTS[language]) || { atFirstColumn: true, addSpace: false };
}

/** Effective Comment Code style of a language: Code Style override, else the language default. */
export function lineCommentStyleFor(
  prefs: EditorExtras,
  language: string | undefined,
): { atFirstColumn: boolean; addSpace: boolean } {
  const base = lineCommentDefaults(language);
  const own = language ? prefs.codeStyle.languages[language] : undefined;
  return {
    atFirstColumn:
      typeof own?.lineCommentAtFirstColumn === "boolean" ? own.lineCommentAtFirstColumn : base.atFirstColumn,
    addSpace: typeof own?.lineCommentAddSpace === "boolean" ? own.lineCommentAddSpace : base.addSpace,
  };
}

export const EDITOR_EXTRA_DEFAULTS = {
  colorOverrides: {} as Record<string, Record<string, TextAttributesOverride>>,
  /** Color Scheme › Language Defaults › Semantic highlighting (rainbow locals / parameters). */
  semanticHighlighting: false,
  /** Color Scheme › Language Defaults › Rainbow brackets. */
  rainbowBrackets: false,
  ligatures: false,
  fallbackFont: "",
  /** Typography Settings › Main / Bold font weight (CSS weights, IDEA's Regular / Bold). */
  fontWeight: 400,
  boldFontWeight: 700,
  general: {
    wheelZoom: false,
    dragAndDrop: true,
    caretScroll: "minimize",
    softWrapFiles: "*.md; *.txt; *.rst; *.adoc",
    softWrapIndent: true,
    scrollPastEnd: false,
    stripTrailingScope: "modified",
    keepTrailingOnCaretLine: true,
    removeTrailingBlankLines: false,
    richTextCopy: true,
  },
  appearance: {
    caretBlinking: true,
    caretBlinkPeriod: 500,
    smoothCaretBlinking: false,
    blockCaret: false,
    smoothCaretMovement: false,
    caretMovementStyle: "snappy",
    lineNumbers: true,
    methodSeparators: false,
    whitespaceLeading: true,
    whitespaceInner: true,
    whitespaceTrailing: true,
    indentGuides: true,
    hardWrapGuides: true,
    intentionBulb: true,
    distractionFreeWidth: 80,
  },
  breadcrumbs: { show: true, placement: "bottom", disabledLanguages: [] as string[] },
  completion: {
    matchCase: true,
    caseSensitivity: "first",
    autoPopup: true,
    insertOnSpecialKeys: false,
    autoInsertSingle: true,
    sortAlphabetically: false,
    insertParentheses: true,
    showDocumentation: false,
    documentationDelay: 500,
    parameterInfo: true,
    parameterInfoDelay: 1000,
  },
  autoImport: { addUnambiguous: false, optimizeOnTheFly: false },
  folding: { showOutline: true, fileHeader: true, imports: true, docComments: false },
  tabs: {
    placement: "top",
    multipleRows: false,
    oneRowOverflow: "scroll",
    pinnedSeparateRow: false,
    showFileIcon: true,
    showExtension: true,
    showDirectoryForNonUnique: true,
    markModified: false,
    showFullPathOnHover: true,
    showCloseButton: true,
    closeButtonPosition: "right",
    sortAlphabetically: false,
    previewTab: true,
    openAtEnd: false,
    tabLimit: 30,
    closingPolicy: "lru",
    activateOnClose: "left",
  },
  smartKeys: {
    smartHome: true,
    camelHumps: false,
    pairBrackets: true,
    pairQuotes: true,
    surroundSelection: true,
    tabOutOfPair: true,
    reformatOnPaste: "indentEachLine",
    smartIndent: true,
    backspaceUnindent: "autoindent",
  },
  codeEditing: {
    highlightUsages: true,
    highlightBraces: true,
    highlightSelection: true,
    quickDocOnHover: true,
    quickDocDelay: 500,
    nextErrorErrorsOnly: true,
    stickyLinesMax: 5,
  },
  inlay: {
    types: true,
    parameters: true,
    other: true,
    disabledLanguages: [] as string[],
    codeVisionUsages: true,
    codeVisionAuthor: true,
  },
  inlineCompletion: { enabled: true, onlyOnPause: false, pauseMs: 500, disabledLanguages: [] as string[] },
  gutterIconsDisabled: [] as string[],
  showGutterIcons: true,
  codeStyle: {
    lineSeparator: "system",
    hardWrapAt: 120,
    visualGuides: [] as number[],
    detectIndents: true,
    editorconfig: true,
    languages: {} as Record<string, LanguageCodeStyle>,
    /** Formatter › Do not format: globs Reformat Code skips. */
    doNotFormat: [] as string[],
    /** Formatter › Turn formatter on/off with markers in code comments. */
    formatterTagsEnabled: false,
    formatterOffTag: "@formatter:off",
    formatterOnTag: "@formatter:on",
    formatterTagsRegexp: false,
  },
  encodings: { global: "utf-8", project: "utf-8", properties: "iso-8859-1", utf8Bom: "never" },
};

export type EditorExtras = typeof EDITOR_EXTRA_DEFAULTS;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** Coerces `raw` to the shape of `def`; `{}` defaults are free-form maps kept as given. */
export function coerceLike<T>(raw: unknown, def: T): T {
  if (Array.isArray(def)) {
    if (!Array.isArray(raw)) return [...def] as T;
    const sample = def[0];
    return raw.filter((x) =>
      sample === undefined ? typeof x === "string" || typeof x === "number" : typeof x === typeof sample,
    ) as T;
  }
  if (isObj(def)) {
    const keys = Object.keys(def);
    if (!keys.length) return (isObj(raw) ? { ...raw } : {}) as T;
    const src = isObj(raw) ? raw : {};
    const out: Obj = {};
    for (const k of keys) out[k] = coerceLike(src[k], (def as Obj)[k]);
    return out as T;
  }
  if (typeof def === "number") return (typeof raw === "number" && Number.isFinite(raw) ? raw : def) as T;
  if (typeof def === "boolean") return (typeof raw === "boolean" ? raw : def) as T;
  if (typeof def === "string") return (typeof raw === "string" ? raw : def) as T;
  return def;
}

/** IDEA's named font weights (Typography Settings). */
export const FONT_WEIGHTS: ReadonlyArray<readonly [number, string]> = [
  [100, "Thin"],
  [200, "ExtraLight"],
  [300, "Light"],
  [400, "Regular"],
  [500, "Medium"],
  [600, "SemiBold"],
  [700, "Bold"],
  [800, "ExtraBold"],
  [900, "Black"],
];

/** CSS weight from 100 to 900, rounded to the nearest 50. */
export function fontWeightOf(raw: unknown, def: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return def;
  return Math.min(900, Math.max(100, Math.round(raw / 50) * 50));
}

/** `--fw-code` / `--fw-code-bold`: what editor-font text and its bold runs render with. */
export function fontWeightVars(main: unknown, bold: unknown): Record<"--fw-code" | "--fw-code-bold", string> {
  return {
    "--fw-code": String(fontWeightOf(main, EDITOR_EXTRA_DEFAULTS.fontWeight)),
    "--fw-code-bold": String(fontWeightOf(bold, EDITOR_EXTRA_DEFAULTS.boldFontWeight)),
  };
}

export function validateEditorExtras(raw: unknown): EditorExtras {
  const out = coerceLike(raw, EDITOR_EXTRA_DEFAULTS);
  out.fontWeight = fontWeightOf(out.fontWeight, EDITOR_EXTRA_DEFAULTS.fontWeight);
  out.boldFontWeight = fontWeightOf(out.boldFontWeight, EDITOR_EXTRA_DEFAULTS.boldFontWeight);
  return out;
}

let cache: { raw: unknown; powerSave: boolean; value: EditorExtras } | null = null;

/** File › Power Save Mode (`general.powerSaveMode`). */
export function isPowerSaveMode(settings: unknown = useProject.getState().settings): boolean {
  const general = settings && typeof settings === "object" ? (settings as Obj).general : undefined;
  return isObj(general) && general.powerSaveMode === true;
}

/** Power Save Mode turns off the editor's automatic popups and background highlighting. */
export function powerSaveExtras(p: EditorExtras): EditorExtras {
  return {
    ...p,
    completion: { ...p.completion, autoPopup: false, parameterInfo: false, showDocumentation: false },
    codeEditing: { ...p.codeEditing, quickDocOnHover: false, highlightUsages: false },
    inlay: { ...p.inlay, codeVisionUsages: false },
    inlineCompletion: { ...p.inlineCompletion, enabled: false },
  };
}

/** Effective Editor-group settings (validated, memoised per settings object). */
export function editorPrefs(settings: unknown = useProject.getState().settings): EditorExtras {
  const raw = settings && typeof settings === "object" ? (settings as Obj).editor : undefined;
  const powerSave = isPowerSaveMode(settings);
  if (cache && cache.raw === raw && cache.powerSave === powerSave) return cache.value;
  const valid = validateEditorExtras(raw);
  const value = powerSave ? powerSaveExtras(valid) : valid;
  cache = { raw, powerSave, value };
  return value;
}

/** Reactive variant of `editorPrefs`. */
export function useEditorPrefs(): EditorExtras {
  return editorPrefs(useProject((s) => s.settings));
}

/** Encodings offered by File Encodings and the status-bar widget (WHATWG label, display name). */
export const ENCODING_CHOICES: ReadonlyArray<readonly [string, string]> = [
  ["utf-8", "UTF-8"],
  ["utf-16le", "UTF-16LE"],
  ["utf-16be", "UTF-16BE"],
  ["gbk", "GBK"],
  ["gb18030", "GB18030"],
  ["big5", "Big5"],
  ["shift_jis", "Shift_JIS"],
  ["euc-kr", "EUC-KR"],
  ["windows-1252", "windows-1252"],
  ["iso-8859-1", "ISO-8859-1"],
  ["koi8-r", "KOI8-R"],
];
