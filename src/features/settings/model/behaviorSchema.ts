/**
 * Appearance & Behavior settings beyond the basics in `schema.ts`: extra
 * Appearance / System Settings fields and the Notifications page. Mirrors the
 * `ide-core::settings` defaults; validation never throws.
 */

import { BUILTIN_THEME_IDS, type BuiltinThemeId } from "@/platform/themes";
import { ZOOM_LIMITS } from "@/platform/zoom";

export type Antialiasing = "subpixel" | "greyscale" | "none";
export type OpenProjectIn = "ask" | "new" | "same" | "attach";
export type NotificationDisplay = "balloon" | "sticky" | "none";
/** Themes selectable as "preferred" when syncing with the OS. */
export type ConcreteTheme = BuiltinThemeId;

export interface AppearanceExtras {
  syncWithOs: boolean;
  preferredLightTheme: ConcreteTheme;
  preferredDarkTheme: ConcreteTheme;
  zoom: number;
  useCustomFont: boolean;
  uiFontFamily: string;
  contrastScrollbars: boolean;
  redGreenVision: boolean;
  differentToolWindowBackground: boolean;
  compactMode: boolean;
  fullPathInTitle: boolean;
  projectColorsInToolbar: boolean;
  dndWithAltOnly: boolean;
  menuIcons: boolean;
  mainMenuStyle: "hamburger" | "merged";
  ideAntialiasing: Antialiasing;
  editorAntialiasing: Antialiasing;
  showToolWindowBars: boolean;
  showToolWindowNames: boolean;
  showToolWindowBadges: boolean;
  widescreenToolWindows: boolean;
}

export interface DateFormatValid {
  overrideSystem: boolean;
  pattern: string;
  use24Hour: boolean;
  pretty: boolean;
}

export interface GeneralExtras {
  openProjectIn: OpenProjectIn;
  defaultProjectDirectory: string;
  saveOnIdle: boolean;
  idleSeconds: number;
  dateFormat: DateFormatValid;
}

export interface NotificationGroupValid {
  display: NotificationDisplay;
  log: boolean;
}

export interface NotificationsValid {
  balloons: boolean;
  sound: boolean;
  groups: Record<string, NotificationGroupValid>;
}

export const IDLE_LIMITS = { min: 1, max: 3600 } as const;

export const DEFAULT_APPEARANCE_EXTRAS: AppearanceExtras = {
  syncWithOs: false,
  preferredLightTheme: "light",
  preferredDarkTheme: "dark",
  zoom: 100,
  useCustomFont: false,
  uiFontFamily: "Inter",
  contrastScrollbars: false,
  redGreenVision: false,
  differentToolWindowBackground: false,
  compactMode: false,
  fullPathInTitle: false,
  projectColorsInToolbar: true,
  dndWithAltOnly: false,
  menuIcons: true,
  mainMenuStyle: "hamburger",
  ideAntialiasing: "greyscale",
  editorAntialiasing: "greyscale",
  showToolWindowBars: true,
  showToolWindowNames: false,
  showToolWindowBadges: true,
  widescreenToolWindows: false,
};

export const DEFAULT_GENERAL_EXTRAS: GeneralExtras = {
  openProjectIn: "ask",
  defaultProjectDirectory: "",
  saveOnIdle: false,
  idleSeconds: 15,
  dateFormat: { overrideSystem: false, pattern: "dd.MM.yyyy", use24Hour: true, pretty: true },
};

export const DEFAULT_NOTIFICATIONS: NotificationsValid = { balloons: true, sound: false, groups: {} };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], d: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : d;
const int = (v: unknown, d: number, { min, max }: { min: number; max: number }) =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(Math.min(max, Math.max(min, v))) : d;

const AA: readonly Antialiasing[] = ["subpixel", "greyscale", "none"];
const CONCRETE = BUILTIN_THEME_IDS;
const DISPLAYS: readonly NotificationDisplay[] = ["balloon", "sticky", "none"];

export function validateAppearanceExtras(raw: unknown): AppearanceExtras {
  const a = obj(raw);
  const d = DEFAULT_APPEARANCE_EXTRAS;
  const b = (k: keyof AppearanceExtras) => bool(a[k], d[k] as boolean);
  return {
    // A legacy `theme = "system"` means syncing too.
    syncWithOs: bool(a.syncWithOs, d.syncWithOs) || a.theme === "system",
    preferredLightTheme: oneOf(a.preferredLightTheme, CONCRETE, d.preferredLightTheme),
    preferredDarkTheme: oneOf(a.preferredDarkTheme, CONCRETE, d.preferredDarkTheme),
    zoom: int(a.zoom, d.zoom, ZOOM_LIMITS),
    useCustomFont: b("useCustomFont"),
    uiFontFamily: typeof a.uiFontFamily === "string" && a.uiFontFamily.trim() ? a.uiFontFamily.trim() : d.uiFontFamily,
    contrastScrollbars: b("contrastScrollbars"),
    redGreenVision: b("redGreenVision"),
    differentToolWindowBackground: b("differentToolWindowBackground"),
    compactMode: b("compactMode"),
    fullPathInTitle: b("fullPathInTitle"),
    projectColorsInToolbar: b("projectColorsInToolbar"),
    dndWithAltOnly: b("dndWithAltOnly"),
    menuIcons: b("menuIcons"),
    mainMenuStyle: oneOf(a.mainMenuStyle, ["hamburger", "merged"], d.mainMenuStyle),
    ideAntialiasing: oneOf(a.ideAntialiasing, AA, d.ideAntialiasing),
    editorAntialiasing: oneOf(a.editorAntialiasing, AA, d.editorAntialiasing),
    showToolWindowBars: b("showToolWindowBars"),
    showToolWindowNames: b("showToolWindowNames"),
    showToolWindowBadges: b("showToolWindowBadges"),
    widescreenToolWindows: b("widescreenToolWindows"),
  };
}

export function validateGeneralExtras(raw: unknown): GeneralExtras {
  const g = obj(raw);
  const d = DEFAULT_GENERAL_EXTRAS;
  const df = obj(g.dateFormat);
  return {
    openProjectIn: oneOf(g.openProjectIn, ["ask", "new", "same", "attach"] as const, d.openProjectIn),
    defaultProjectDirectory: typeof g.defaultProjectDirectory === "string" ? g.defaultProjectDirectory : "",
    saveOnIdle: bool(g.saveOnIdle, d.saveOnIdle),
    idleSeconds: int(g.idleSeconds, d.idleSeconds, IDLE_LIMITS),
    dateFormat: {
      overrideSystem: bool(df.overrideSystem, d.dateFormat.overrideSystem),
      pattern: typeof df.pattern === "string" && df.pattern.trim() ? df.pattern : d.dateFormat.pattern,
      use24Hour: bool(df.use24Hour, d.dateFormat.use24Hour),
      pretty: bool(df.pretty, d.dateFormat.pretty),
    },
  };
}

export function validateNotifications(raw: unknown): NotificationsValid {
  const n = obj(raw);
  const groups: Record<string, NotificationGroupValid> = {};
  for (const [id, v] of Object.entries(obj(n.groups))) {
    const g = obj(v);
    groups[id] = { display: oneOf(g.display, DISPLAYS, "balloon"), log: bool(g.log, true) };
  }
  return {
    balloons: bool(n.balloons, DEFAULT_NOTIFICATIONS.balloons),
    sound: bool(n.sound, DEFAULT_NOTIFICATIONS.sound),
    groups,
  };
}
