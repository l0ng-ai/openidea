/**
 * File Colors (Settings › Appearance & Behavior › File Colors): files of a scope get a
 * background colour in the project view and on their editor tabs. The first scope in the
 * list that holds a file decides its colour.
 */
import { inScope, validateScopes, type NamedScope, type ScopeContext } from "./scopes";

export const FILE_COLOR_NAMES = ["blue", "green", "orange", "rose", "violet", "yellow", "gray"] as const;

export interface FileColorEntry {
  scope: string;
  /** A palette name or `#rrggbb`. */
  color: string;
}

export interface FileColorSettings {
  enabled: boolean;
  editorTabs: boolean;
  projectView: boolean;
  colors: FileColorEntry[];
}

export const DEFAULT_FILE_COLORS: FileColorSettings = {
  enabled: true,
  editorTabs: true,
  projectView: true,
  colors: [
    { scope: "Non-Project Files", color: "yellow" },
    { scope: "Tests", color: "green" },
  ],
};

const HEX = /^#[0-9a-f]{6}$/i;

export function validateFileColors(raw: unknown): FileColorSettings {
  const v = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_FILE_COLORS;
  const bool = (x: unknown, def: boolean) => (typeof x === "boolean" ? x : def);
  const colors = Array.isArray(v.colors)
    ? v.colors.flatMap((c: unknown) => {
        const e = c && typeof c === "object" ? (c as Record<string, unknown>) : {};
        return typeof e.scope === "string" && e.scope && typeof e.color === "string"
          ? [{ scope: e.scope, color: e.color }]
          : [];
      })
    : d.colors;
  return {
    enabled: bool(v.enabled, d.enabled),
    editorTabs: bool(v.editorTabs, d.editorTabs),
    projectView: bool(v.projectView, d.projectView),
    colors,
  };
}

/** The CSS colour of a stored colour value. */
export function fileColorCss(color: string): string | undefined {
  const name = color.toLowerCase();
  if ((FILE_COLOR_NAMES as readonly string[]).includes(name)) return `var(--file-color-${name})`;
  return HEX.test(color) ? color : undefined;
}

/** Where a file colour shows. */
export type FileColorPlace = "editorTabs" | "projectView";

/** The colour of the absolute `path` from these settings, or undefined. */
export function fileColorOf(
  path: string,
  settings: FileColorSettings,
  ctx: ScopeContext,
  dir = false,
): string | undefined {
  if (!settings.enabled) return undefined;
  for (const entry of settings.colors) {
    if (inScope(entry.scope, path, ctx, dir)) return fileColorCss(entry.color);
  }
  return undefined;
}

let cachedRaw: unknown = Symbol("unset");
let cached = DEFAULT_FILE_COLORS;
/** The File Colors settings in the raw settings `fileColors` (cached per object). */
export function fileColorSettings(raw: unknown): FileColorSettings {
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = validateFileColors(raw);
  }
  return cached;
}

/**
 * A pattern for exactly `rel` (a folder: everything in it), or null when the path has
 * characters a pattern can't hold.
 */
export function pathPattern(rel: string, dir: boolean): string | null {
  if (!rel || /[\s()|&!*[\]]/.test(rel)) return null;
  return dir ? `file:${rel}//*` : `file:${rel}`;
}

/** The colour given to `rel` itself through its own scope (Set File Color), if any. */
export function ownFileColor(rel: string, dir: boolean, settings: unknown): string | null {
  const pattern = pathPattern(rel, dir);
  const s = settings as { scopes?: unknown; fileColors?: unknown } | null;
  const scope = validateScopes(s?.scopes).find((x) => x.name === rel && x.pattern === pattern);
  return (scope && validateFileColors(s?.fileColors).colors.find((c) => c.scope === scope.name)?.color) ?? null;
}

/**
 * The project's scopes and File Colors with `rel` given `color` (first in the list, so it
 * wins over broader scopes), or with that colour and its scope removed (`null`).
 */
export function withOwnFileColor(
  settings: unknown,
  rel: string,
  dir: boolean,
  color: string | null,
): { scopes: NamedScope[]; fileColors: FileColorSettings } | null {
  const pattern = pathPattern(rel, dir);
  if (!pattern) return null;
  const s = settings as { scopes?: unknown; fileColors?: unknown } | null;
  const scopes = validateScopes(s?.scopes).filter((x) => x.name !== rel);
  const fileColors = validateFileColors(s?.fileColors);
  const colors = fileColors.colors.filter((c) => c.scope !== rel);
  return color
    ? {
        scopes: [...scopes, { name: rel, pattern }],
        fileColors: { ...fileColors, colors: [{ scope: rel, color }, ...colors] },
      }
    : { scopes, fileColors: { ...fileColors, colors } };
}
