/**
 * Settings shape as the UI consumes it: every field present and in range.
 * Values come from user-edited TOML (via the backend) or from older versions,
 * so `validateSettings` never throws — anything unknown or malformed falls
 * back to the default (mirrors `ide-core::settings` defaults).
 */
import { DEFAULT_IGNORED_NAMES } from "@/platform/ignoredNames";
import { validateFileTypeOverrides, validateFileTypes, type FileTypeAssociations } from "@/platform/fileTypes";
import type { LanguageServerSettings, Settings } from "@/platform/ipc";
import {
  DEFAULT_LANGUAGES,
  DEFAULT_PROJECT_STRUCTURE,
  validateLanguages,
  validateProjectStructure,
  type LanguagesValid,
  type ProjectStructureValid,
} from "@/platform/languageSettings";
import { EDITOR_EXTRA_DEFAULTS, validateEditorExtras, type EditorExtras } from "@/platform/editorSettings";
import { DEFAULT_WORKFLOW, validateWorkflow, type WorkflowSettings } from "@/platform/workflowSettings";
import { DEFAULT_INSPECTIONS, validateInspections, type InspectionSettingsValid } from "@/platform/inspections";
import { DEFAULT_PROXY, validateProxy, type ProxySettingsValid } from "@/platform/proxySettings";
import {
  DEFAULT_APPEARANCE_EXTRAS,
  DEFAULT_GENERAL_EXTRAS,
  DEFAULT_NOTIFICATIONS,
  validateAppearanceExtras,
  validateGeneralExtras,
  validateNotifications,
  type AppearanceExtras,
  type GeneralExtras,
  type NotificationsValid,
} from "./behaviorSchema";
import { BUILTIN_THEME_IDS, type BuiltinThemeId } from "@/platform/themes";

export type ThemeId = BuiltinThemeId | "system";
export type LocaleId = "en" | "zh";

/** A user keymap (Keymap › Duplicate…): its own overrides on top of a bundled preset. */
export interface CustomKeymapSettings {
  name: string;
  parent: string;
  overrides: Record<string, string[]>;
}

export interface ValidSettings extends WorkflowSettings {
  general: { reopenLastProject: boolean; confirmExit: boolean } & GeneralExtras;
  appearance: { theme: ThemeId; accent: string; uiFontSize: number; locale: LocaleId } & AppearanceExtras;
  editor: {
    fontFamily: string;
    fontSize: number;
    lineHeight: number;
    tabSize: number;
    insertSpaces: boolean;
    softWrap: boolean;
    showWhitespace: boolean;
    inlayHints: boolean;
    stickyScroll: boolean;
    formatOnSave: boolean;
    /** `theme-default` follows the IDE theme. */
    colorScheme: string;
  } & EditorExtras;
  keymap: string;
  files: {
    autoSave: boolean;
    exclude: string[];
    ignoredNames: string[];
    trimTrailingWhitespace: boolean;
    ensureFinalNewline: boolean;
    /** Local History keeps this many working days (days with changes). */
    localHistoryDays: number;
    /** Local History size bound per project, MB. */
    localHistoryMaxMb: number;
    /** File Types: the user's patterns per language id. */
    fileTypes: FileTypeAssociations;
    /** Override File Type: file → language id (project scope). */
    fileTypeOverrides: Record<string, string>;
  };
  keymapOverrides: Record<string, string[]>;
  customKeymaps: Record<string, CustomKeymapSettings>;
  notifications: NotificationsValid;
  /** System Settings › HTTP Proxy (global). */
  proxy: ProxySettingsValid;
  languages: LanguagesValid;
  projectStructure: ProjectStructureValid;
  inspections: InspectionSettingsValid;
  /** Editor › Natural Languages › Spelling. */
  spelling: SpellingValid;
  /** Executables chosen for language servers / debug adapters, by command. */
  tools: Record<string, { path: string }>;
  /** Settings › Language Servers, by server name (as the backend sends them). */
  languageServers: Record<string, LanguageServerEntry>;
}

/** One `languageServers.<name>` entry; every field optional, like in settings.toml. */
export type LanguageServerEntry = Partial<LanguageServerSettings>;

export interface SpellingValid {
  ideWords: string[];
  projectWords: string[];
  customDictionaries: string[];
}

const stringList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];

function validateSpelling(raw: unknown): SpellingValid {
  const r = obj(raw);
  return {
    ideWords: stringList(r.ideWords),
    projectWords: stringList(r.projectWords),
    customDictionaries: stringList(r.customDictionaries),
  };
}

export { ACCENT_PRESETS } from "@/workbench/theme";

export const DEFAULT_SETTINGS: ValidSettings = {
  general: { reopenLastProject: true, confirmExit: false, ...DEFAULT_GENERAL_EXTRAS },
  appearance: { theme: "light", accent: "#3871e1", uiFontSize: 13, locale: "en", ...DEFAULT_APPEARANCE_EXTRAS },
  editor: {
    fontFamily: "JetBrains Mono",
    fontSize: 13,
    lineHeight: 22,
    tabSize: 4,
    insertSpaces: true,
    softWrap: true,
    showWhitespace: false,
    inlayHints: true,
    stickyScroll: true,
    formatOnSave: false,
    colorScheme: "theme-default",
    ...EDITOR_EXTRA_DEFAULTS,
  },
  keymap: "intellij-macos",
  files: {
    autoSave: true,
    exclude: ["**/.git", "**/node_modules", "**/target"],
    ignoredNames: [...DEFAULT_IGNORED_NAMES],
    trimTrailingWhitespace: true,
    ensureFinalNewline: true,
    localHistoryDays: 5,
    localHistoryMaxMb: 512,
    fileTypes: {},
    fileTypeOverrides: {},
  },
  keymapOverrides: {},
  customKeymaps: {},
  notifications: DEFAULT_NOTIFICATIONS,
  proxy: DEFAULT_PROXY,
  languages: DEFAULT_LANGUAGES,
  projectStructure: DEFAULT_PROJECT_STRUCTURE,
  inspections: DEFAULT_INSPECTIONS,
  spelling: { ideWords: [], projectWords: [], customDictionaries: [] },
  tools: {},
  languageServers: {},
  ...DEFAULT_WORKFLOW,
};

export const LIMITS = {
  uiFontSize: { min: 10, max: 18 },
  fontSize: { min: 6, max: 72 },
  lineHeight: { min: 8, max: 120 },
  tabSize: { min: 1, max: 16 },
  localHistoryDays: { min: 1, max: 365 },
  localHistoryMaxMb: { min: 16, max: 16384 },
} as const;

const THEMES: readonly ThemeId[] = [...BUILTIN_THEME_IDS, "system"];
const LOCALES: readonly LocaleId[] = ["en", "zh"];
export const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const str = (v: unknown, d: string) => (typeof v === "string" && v.trim() ? v : d);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], d: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : d;
const num = (v: unknown, d: number, { min, max }: { min: number; max: number }, int = false) => {
  if (typeof v !== "number" || !Number.isFinite(v)) return d;
  const n = Math.min(max, Math.max(min, v));
  return int ? Math.round(n) : n;
};

function bindingMap(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [id, keys] of Object.entries(obj(raw))) {
    if (Array.isArray(keys)) out[id] = keys.filter((k): k is string => typeof k === "string" && !!k.trim());
  }
  return out;
}

export function validateSettings(raw: Settings | unknown): ValidSettings {
  const d = DEFAULT_SETTINGS;
  const root = obj(raw);
  const g = obj(root.general);
  const a = obj(root.appearance);
  const e = obj(root.editor);
  const f = obj(root.files);
  const overrides = bindingMap(root.keymapOverrides);
  const customKeymaps: Record<string, CustomKeymapSettings> = {};
  for (const [id, raw] of Object.entries(obj(root.customKeymaps))) {
    const k = obj(raw);
    if (!id.trim()) continue;
    customKeymaps[id] = { name: str(k.name, id), parent: str(k.parent, d.keymap), overrides: bindingMap(k.overrides) };
  }
  return {
    general: {
      ...validateGeneralExtras(g),
      reopenLastProject: bool(g.reopenLastProject, d.general.reopenLastProject),
      confirmExit: bool(g.confirmExit, d.general.confirmExit),
    },
    appearance: {
      ...validateAppearanceExtras(a),
      theme: oneOf(a.theme, THEMES, d.appearance.theme),
      accent: typeof a.accent === "string" && HEX_COLOR.test(a.accent) ? a.accent.toLowerCase() : d.appearance.accent,
      uiFontSize: num(a.uiFontSize, d.appearance.uiFontSize, LIMITS.uiFontSize, true),
      locale: oneOf(a.locale, LOCALES, d.appearance.locale),
    },
    editor: {
      fontFamily: str(e.fontFamily, d.editor.fontFamily),
      fontSize: num(e.fontSize, d.editor.fontSize, LIMITS.fontSize),
      lineHeight: num(e.lineHeight, d.editor.lineHeight, LIMITS.lineHeight),
      tabSize: num(e.tabSize, d.editor.tabSize, LIMITS.tabSize, true),
      insertSpaces: bool(e.insertSpaces, d.editor.insertSpaces),
      softWrap: bool(e.softWrap, d.editor.softWrap),
      showWhitespace: bool(e.showWhitespace, d.editor.showWhitespace),
      inlayHints: bool(e.inlayHints, d.editor.inlayHints),
      stickyScroll: bool(e.stickyScroll, d.editor.stickyScroll),
      formatOnSave: bool(e.formatOnSave, d.editor.formatOnSave),
      colorScheme: str(e.colorScheme, d.editor.colorScheme),
      ...validateEditorExtras(e),
    },
    keymap: str(root.keymap, d.keymap),
    files: {
      autoSave: bool(f.autoSave, d.files.autoSave),
      exclude: Array.isArray(f.exclude)
        ? f.exclude.filter((x): x is string => typeof x === "string" && !!x.trim())
        : [...d.files.exclude],
      ignoredNames: Array.isArray(f.ignoredNames)
        ? f.ignoredNames.filter((x): x is string => typeof x === "string" && !!x.trim())
        : [...d.files.ignoredNames],
      trimTrailingWhitespace: bool(f.trimTrailingWhitespace, d.files.trimTrailingWhitespace),
      ensureFinalNewline: bool(f.ensureFinalNewline, d.files.ensureFinalNewline),
      localHistoryDays: num(f.localHistoryDays, d.files.localHistoryDays, LIMITS.localHistoryDays, true),
      localHistoryMaxMb: num(f.localHistoryMaxMb, d.files.localHistoryMaxMb, LIMITS.localHistoryMaxMb, true),
      fileTypes: validateFileTypes(f.fileTypes),
      fileTypeOverrides: validateFileTypeOverrides(f.fileTypeOverrides),
    },
    keymapOverrides: overrides,
    customKeymaps,
    notifications: validateNotifications(root.notifications),
    proxy: validateProxy(root.proxy),
    languages: validateLanguages(root.languages),
    projectStructure: validateProjectStructure(root.projectStructure),
    inspections: validateInspections(root.inspections),
    spelling: validateSpelling(root.spelling),
    tools: Object.fromEntries(
      Object.entries(obj(root.tools)).flatMap(([cmd, t]) => {
        const path = obj(t).path;
        return typeof path === "string" ? [[cmd, { path }]] : [];
      }),
    ),
    languageServers: Object.fromEntries(
      Object.entries(obj(root.languageServers)).map(([name, ls]) => [name, obj(ls) as LanguageServerEntry]),
    ),
    ...validateWorkflow(root),
  };
}

/** Reads a dotted key (`editor.fontSize`); `undefined` when absent. */
export function getAt(source: unknown, key: string): unknown {
  let cur: unknown = source;
  for (const seg of key.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Obj)[seg];
  }
  return cur;
}

/** Returns a copy of `source` with the dotted `key` set (immutable path copy). */
export function setAt<T>(source: T, key: string, value: unknown): T {
  const [head, ...rest] = key.split(".");
  const base = obj(source);
  return { ...base, [head!]: rest.length ? setAt(base[head!], rest.join("."), value) : value } as T;
}

/** Like `setAt`, but `null` / `undefined` removes the key (as a settings write of `null` does). */
export function putAt<T>(source: T, key: string, value: unknown): T {
  const [head, ...rest] = key.split(".");
  const base = { ...obj(source) };
  if (rest.length) base[head!] = putAt(base[head!], rest.join("."), value);
  else if (value == null) delete base[head!];
  else base[head!] = value;
  return base as T;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || !a || !b || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as Obj);
  const kb = Object.keys(b as Obj);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Obj)[k], (b as Obj)[k]));
}
