/**
 * Appearance & Behavior settings beyond the basics in `schema.ts`: extra
 * Appearance / System Settings fields and the Notifications page. Mirrors the
 * `ide-core::settings` defaults; validation never throws.
 */

import { isThemeChoiceId, type ThemeChoiceId } from "@/platform/themes";
import type { FileIconThemeOptions } from "@/bindings";
import { ZOOM_LIMITS } from "@/platform/zoom";
import { validateIconThemeOptionsMap } from "@/platform/iconThemeOptions";

export type Antialiasing = "subpixel" | "greyscale" | "none";
export type OpenProjectIn = "ask" | "new" | "same";
export type NotificationDisplay = "balloon" | "sticky" | "none";
export type NavigationBarPosition = "top" | "statusBar" | "hidden";
export type BackgroundImageFill = "scale" | "plain" | "tile";
export const BACKGROUND_IMAGE_ANCHORS = [
  "top-left",
  "top",
  "top-right",
  "left",
  "center",
  "right",
  "bottom-left",
  "bottom",
  "bottom-right",
] as const;
export type BackgroundImageAnchor = (typeof BACKGROUND_IMAGE_ANCHORS)[number];

/** Appearance › Background Image; an empty `path` shows no image. */
export interface BackgroundImageValid {
  path: string;
  /** Percent, 0–100. */
  opacity: number;
  fill: BackgroundImageFill;
  anchor: BackgroundImageAnchor;
}
export type PresentationAssistantSize = "small" | "medium" | "large";
export const PRESENTATION_ASSISTANT_POSITIONS = [
  "top-left",
  "top",
  "top-right",
  "bottom-left",
  "bottom",
  "bottom-right",
] as const;
export type PresentationAssistantPosition = (typeof PRESENTATION_ASSISTANT_POSITIONS)[number];
export const PRESENTATION_ASSISTANT_DURATION = { min: 1, max: 60 } as const;

/** Appearance › Presentation Assistant: the name and shortcut of each action the user runs. */
export interface PresentationAssistantValid {
  enabled: boolean;
  size: PresentationAssistantSize;
  durationSeconds: number;
  position: PresentationAssistantPosition;
  /** Also show the other platform's shortcut (macOS ⇄ Windows/Linux). */
  alternateKeymap: boolean;
}
/** Themes selectable as "preferred" when syncing with the OS. */
export type ConcreteTheme = ThemeChoiceId;

export interface AppearanceExtras {
  syncWithOs: boolean;
  preferredLightTheme: ConcreteTheme;
  preferredDarkTheme: ConcreteTheme;
  /** A plugin's file icon theme (`<pluginId>/<themeId>`); empty for the built-in icons. */
  fileIconTheme: string;
  fileIconThemeOptions: Record<string, FileIconThemeOptions>;
  zoom: number;
  useCustomFont: boolean;
  uiFontFamily: string;
  uiFontFallback: string;
  contrastScrollbars: boolean;
  redGreenVision: boolean;
  differentToolWindowBackground: boolean;
  compactMode: boolean;
  /** IDEA "Use smaller indents in trees": tool window trees indent less per level. */
  smallTreeIndents: boolean;
  /** IDEA "Smooth scrolling" (Linux: WebKitGTK animates each mouse wheel step). */
  smoothScrolling: boolean;
  fullPathInTitle: boolean;
  projectColorsInToolbar: boolean;
  dndWithAltOnly: boolean;
  menuIcons: boolean;
  mainMenuStyle: "hamburger" | "merged" | "toolbar";
  /** A lone Alt press focuses or opens the main menu (IDEA `ide.windows.main.menu.focus.on.alt`). */
  mainMenuAlt: boolean;
  /** Settings open in a native window of their own; off opens the in-page dialog (#3797). */
  settingsInSeparateWindow: boolean;
  ideAntialiasing: Antialiasing;
  editorAntialiasing: Antialiasing;
  showToolWindowBars: boolean;
  showToolWindowNames: boolean;
  showToolWindowBadges: boolean;
  widescreenToolWindows: boolean;
  rememberToolWindowSizes: boolean;
  /** View › Appearance › Toolbar; hidden leaves IDEA's compact window header. */
  showMainToolbar: boolean;
  showStatusBar: boolean;
  /** View › Appearance › Navigation Bar: the file path breadcrumbs, shown above
   * the editor, in the status bar, or not at all. */
  navigationBar: NavigationBarPosition;
  backgroundImage: BackgroundImageValid;
  presentationAssistant: PresentationAssistantValid;
}

export interface DateFormatValid {
  overrideSystem: boolean;
  pattern: string;
  use24Hour: boolean;
  pretty: boolean;
}

export type UpdateSourceSetting = "auto" | "github" | "cnb";

export interface GeneralExtras {
  openProjectIn: OpenProjectIn;
  updateSource: UpdateSourceSetting;
  autoCheckUpdates: boolean;
  /** System Settings › Updates: show the What's New page after the app starts a new version. */
  showWhatsNewAfterUpdate: boolean;
  /** Version the app last started with; empty on the first run. */
  lastRunVersion: string;
  defaultProjectDirectory: string;
  saveOnIdle: boolean;
  idleSeconds: number;
  dateFormat: DateFormatValid;
}

export interface NotificationGroupValid {
  display: NotificationDisplay;
  log: boolean;
}

/** When a finished terminal command notifies (#3712, Settings › Notifications › Terminal). */
export type TerminalCompletionMode = "off" | "longRunning" | "all";

export interface NotificationsValid {
  balloons: boolean;
  sound: boolean;
  /** Mirror balloon notifications to the OS when no OpenIDEA window is focused. */
  systemNotifications: boolean;
  /** Terminal command completions: off, long-running ones only (default), or every one. */
  terminalCompletion: TerminalCompletionMode;
  /** Mode `longRunning`: the run time a command must reach, in seconds. */
  terminalThresholdSeconds: number;
  groups: Record<string, NotificationGroupValid>;
}

export const IDLE_LIMITS = { min: 1, max: 3600 } as const;

export const DEFAULT_APPEARANCE_EXTRAS: AppearanceExtras = {
  syncWithOs: false,
  preferredLightTheme: "light",
  preferredDarkTheme: "dark",
  fileIconTheme: "",
  fileIconThemeOptions: {},
  zoom: 100,
  useCustomFont: false,
  uiFontFamily: "Inter",
  uiFontFallback: "",
  contrastScrollbars: false,
  redGreenVision: false,
  differentToolWindowBackground: false,
  compactMode: false,
  smallTreeIndents: false,
  smoothScrolling: true,
  fullPathInTitle: false,
  projectColorsInToolbar: true,
  dndWithAltOnly: false,
  menuIcons: true,
  mainMenuStyle: "hamburger",
  mainMenuAlt: true,
  settingsInSeparateWindow: true,
  ideAntialiasing: "greyscale",
  editorAntialiasing: "greyscale",
  showToolWindowBars: true,
  showToolWindowNames: false,
  showToolWindowBadges: true,
  widescreenToolWindows: false,
  rememberToolWindowSizes: false,
  showMainToolbar: true,
  showStatusBar: true,
  navigationBar: "statusBar",
  backgroundImage: { path: "", opacity: 15, fill: "scale", anchor: "center" },
  presentationAssistant: {
    enabled: false,
    size: "medium",
    durationSeconds: 4,
    position: "bottom",
    alternateKeymap: false,
  },
};

const NAV_BAR_POSITIONS: readonly NavigationBarPosition[] = ["top", "statusBar", "hidden"];

export const DEFAULT_GENERAL_EXTRAS: GeneralExtras = {
  openProjectIn: "ask",
  updateSource: "auto",
  autoCheckUpdates: true,
  showWhatsNewAfterUpdate: true,
  lastRunVersion: "",
  defaultProjectDirectory: "",
  saveOnIdle: false,
  idleSeconds: 15,
  dateFormat: { overrideSystem: false, pattern: "dd.MM.yyyy", use24Hour: true, pretty: true },
};

export const DEFAULT_NOTIFICATIONS: NotificationsValid = {
  balloons: true,
  sound: false,
  systemNotifications: true,
  terminalCompletion: "longRunning",
  terminalThresholdSeconds: 10,
  groups: {},
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], d: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : d;
const int = (v: unknown, d: number, { min, max }: { min: number; max: number }) =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(Math.min(max, Math.max(min, v))) : d;

const AA: readonly Antialiasing[] = ["subpixel", "greyscale", "none"];
const concrete = (v: unknown, d: ConcreteTheme): ConcreteTheme => (isThemeChoiceId(v) ? v : d);
const DISPLAYS: readonly NotificationDisplay[] = ["balloon", "sticky", "none"];
const TERMINAL_COMPLETIONS: readonly TerminalCompletionMode[] = ["off", "longRunning", "all"];

export function validateAppearanceExtras(raw: unknown): AppearanceExtras {
  const a = obj(raw);
  const d = DEFAULT_APPEARANCE_EXTRAS;
  const b = (k: keyof AppearanceExtras) => bool(a[k], d[k] as boolean);
  return {
    // A legacy `theme = "system"` means syncing too.
    syncWithOs: bool(a.syncWithOs, d.syncWithOs) || a.theme === "system",
    preferredLightTheme: concrete(a.preferredLightTheme, d.preferredLightTheme),
    preferredDarkTheme: concrete(a.preferredDarkTheme, d.preferredDarkTheme),
    fileIconTheme:
      typeof a.fileIconTheme === "string" && /^[^/\s]+\/[^/\s]+$/.test(a.fileIconTheme) ? a.fileIconTheme : "",
    fileIconThemeOptions: validateIconThemeOptionsMap(a.fileIconThemeOptions),
    zoom: int(a.zoom, d.zoom, ZOOM_LIMITS),
    useCustomFont: b("useCustomFont"),
    uiFontFamily: typeof a.uiFontFamily === "string" && a.uiFontFamily.trim() ? a.uiFontFamily.trim() : d.uiFontFamily,
    uiFontFallback: typeof a.uiFontFallback === "string" ? a.uiFontFallback.trim() : d.uiFontFallback,
    contrastScrollbars: b("contrastScrollbars"),
    redGreenVision: b("redGreenVision"),
    differentToolWindowBackground: b("differentToolWindowBackground"),
    compactMode: b("compactMode"),
    smallTreeIndents: b("smallTreeIndents"),
    smoothScrolling: b("smoothScrolling"),
    fullPathInTitle: b("fullPathInTitle"),
    projectColorsInToolbar: b("projectColorsInToolbar"),
    dndWithAltOnly: b("dndWithAltOnly"),
    menuIcons: b("menuIcons"),
    mainMenuStyle: oneOf(a.mainMenuStyle, ["hamburger", "merged", "toolbar"], d.mainMenuStyle),
    mainMenuAlt: b("mainMenuAlt"),
    settingsInSeparateWindow: b("settingsInSeparateWindow"),
    ideAntialiasing: oneOf(a.ideAntialiasing, AA, d.ideAntialiasing),
    editorAntialiasing: oneOf(a.editorAntialiasing, AA, d.editorAntialiasing),
    showToolWindowBars: b("showToolWindowBars"),
    showToolWindowNames: b("showToolWindowNames"),
    showToolWindowBadges: b("showToolWindowBadges"),
    widescreenToolWindows: b("widescreenToolWindows"),
    rememberToolWindowSizes: b("rememberToolWindowSizes"),
    showMainToolbar: b("showMainToolbar"),
    showStatusBar: b("showStatusBar"),
    // Legacy settings stored this as `showNavigationBar: bool` (`true` = shown,
    // which was the status bar); `navigationBar` is the three-state key.
    navigationBar: (() => {
      const legacy = a.showNavigationBar;
      if (!("navigationBar" in a) && typeof legacy === "boolean") return legacy ? "statusBar" : "hidden";
      return oneOf(a.navigationBar, NAV_BAR_POSITIONS, d.navigationBar);
    })(),
    backgroundImage: validateBackgroundImage(a.backgroundImage),
    presentationAssistant: validatePresentationAssistant(a.presentationAssistant),
  };
}

function validatePresentationAssistant(raw: unknown): PresentationAssistantValid {
  const p = obj(raw);
  const d = DEFAULT_APPEARANCE_EXTRAS.presentationAssistant;
  return {
    enabled: bool(p.enabled, d.enabled),
    size: oneOf(p.size, ["small", "medium", "large"], d.size),
    durationSeconds: int(p.durationSeconds, d.durationSeconds, PRESENTATION_ASSISTANT_DURATION),
    position: oneOf(p.position, PRESENTATION_ASSISTANT_POSITIONS, d.position),
    alternateKeymap: bool(p.alternateKeymap, d.alternateKeymap),
  };
}

function validateBackgroundImage(raw: unknown): BackgroundImageValid {
  const b = obj(raw);
  const d = DEFAULT_APPEARANCE_EXTRAS.backgroundImage;
  return {
    path: typeof b.path === "string" ? b.path.trim() : d.path,
    opacity: int(b.opacity, d.opacity, { min: 0, max: 100 }),
    fill: oneOf(b.fill, ["scale", "plain", "tile"], d.fill),
    anchor: oneOf(b.anchor, BACKGROUND_IMAGE_ANCHORS, d.anchor),
  };
}

export function validateGeneralExtras(raw: unknown): GeneralExtras {
  const g = obj(raw);
  const d = DEFAULT_GENERAL_EXTRAS;
  const df = obj(g.dateFormat);
  return {
    openProjectIn: oneOf(g.openProjectIn, ["ask", "new", "same"] as const, d.openProjectIn),
    updateSource: oneOf(g.updateSource, ["auto", "github", "cnb"] as const, d.updateSource),
    autoCheckUpdates: bool(g.autoCheckUpdates, d.autoCheckUpdates),
    showWhatsNewAfterUpdate: bool(g.showWhatsNewAfterUpdate, d.showWhatsNewAfterUpdate),
    lastRunVersion: typeof g.lastRunVersion === "string" ? g.lastRunVersion : d.lastRunVersion,
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
    systemNotifications: bool(n.systemNotifications, DEFAULT_NOTIFICATIONS.systemNotifications),
    terminalCompletion: oneOf(n.terminalCompletion, TERMINAL_COMPLETIONS, DEFAULT_NOTIFICATIONS.terminalCompletion),
    terminalThresholdSeconds: int(n.terminalThresholdSeconds, DEFAULT_NOTIFICATIONS.terminalThresholdSeconds, {
      min: 1,
      max: 86_400,
    }),
    groups,
  };
}
