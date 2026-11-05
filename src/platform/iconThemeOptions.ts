import type { FileIconThemeOptions } from "@/bindings";

export const ICON_THEME_LIMITS = {
  saturation: { min: 0, max: 20 },
  opacity: { min: 10, max: 100 },
  iconSize: { min: 12, max: 32 },
  rowHeight: { min: 16, max: 48 },
} as const;

type Limited = keyof typeof ICON_THEME_LIMITS;

const THEME_KEY = /^[^/\s]+\/[^/\s]+$/;
const RGB = /^#[0-9a-fA-F]{6}$/;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const isObj = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);

function only<T>(raw: unknown, keep: (v: unknown) => v is T): Record<string, T> {
  return Object.fromEntries(Object.entries(obj(raw)).filter((e): e is [string, T] => keep(e[1])));
}

const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isString = (v: unknown): v is string => typeof v === "string";
const color = (v: unknown) => (typeof v === "string" && RGB.test(v) ? v : null);

function limited(v: unknown, key: Limited): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const { min, max } = ICON_THEME_LIMITS[key];
  return Math.round(Math.min(max, Math.max(min, v)));
}

export function validateIconThemeOptions(raw: unknown): FileIconThemeOptions {
  const o = obj(raw);
  return {
    groups: only(o.groups, isBool),
    choices: only(o.choices, isString),
    hideFiles: o.hideFiles === true,
    hideFolders: o.hideFolders === true,
    hollowFolders: o.hollowFolders === true,
    hideUiIcons: o.hideUiIcons === true,
    hidePsiIcons: o.hidePsiIcons === true,
    monochrome: color(o.monochrome),
    saturation: limited(o.saturation, "saturation"),
    opacity: limited(o.opacity, "opacity"),
    iconSize: limited(o.iconSize, "iconSize"),
    rowHeight: limited(o.rowHeight, "rowHeight"),
    accent: color(o.accent),
  };
}

export function validateIconThemeOptionsMap(raw: unknown): Record<string, FileIconThemeOptions> {
  return Object.fromEntries(
    Object.entries(obj(raw))
      .filter(([key, v]) => THEME_KEY.test(key) && isObj(v))
      .map(([key, v]) => [key, validateIconThemeOptions(v)]),
  );
}
