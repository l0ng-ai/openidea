/**
 * Runtime side of Settings › Appearance and System Settings options that no
 * other feature owns: root attributes read by tokens / global CSS (compact
 * mode, contrast scrollbars, red-green palette, antialiasing, menu icons…),
 * the UI font, IDE zoom (+ ⌃⌥= / ⌃⌥- / ⌃⌥0 actions), "Drag-and-drop with Alt
 * pressed only", "Save files if the IDE is idle" and the background image.
 */
import { executeAction, type Action } from "@/platform/actions";
import { editorPrefs } from "@/platform/editorSettings";
import { uiFontFamily } from "@/platform/fonts";
import { call, commands, isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { setDragRequiresAlt } from "@/ui";
import { ZOOM_LIMITS } from "@/platform/zoom";
import { DEFAULT_SETTINGS, validateSettings, type ValidSettings } from "./model/schema";
import type { BackgroundImageValid } from "./model/behaviorSchema";

const FONT_VARS = [
  ["--fs-ui", 0],
  ["--fs-small", -1],
  ["--fs-tiny", -2],
] as const;

function flag(root: HTMLElement, name: string, on: boolean, value = "") {
  if (on) root.dataset[name] = value;
  else delete root.dataset[name];
}

/** The per-level indent `ui/Tree` reads when "Use smaller indents in trees" is on (IDEA parity). */
export const SMALL_TREE_INDENT = "12px";

/** Root attributes and CSS variables for the Appearance options. */
export function applyAppearanceOptions(s: ValidSettings, root: HTMLElement = document.documentElement): void {
  const a = s.appearance;
  // "Use custom font": family + size; otherwise the theme's.
  const size = a.useCustomFont ? a.uiFontSize : DEFAULT_SETTINGS.appearance.uiFontSize;
  for (const [name, delta] of FONT_VARS) {
    if (size === DEFAULT_SETTINGS.appearance.uiFontSize) root.style.removeProperty(name);
    else root.style.setProperty(name, `${size + delta}px`);
  }
  if (a.useCustomFont) root.style.setProperty("--font-ui", uiFontFamily(a.uiFontFamily, a.uiFontFallback));
  else root.style.removeProperty("--font-ui");

  flag(root, "compact", a.compactMode);
  flag(root, "contrastScrollbars", a.contrastScrollbars);
  flag(root, "redGreen", a.redGreenVision);
  flag(root, "toolWindowBg", a.differentToolWindowBackground, "different");
  flag(root, "projectColors", !a.projectColorsInToolbar, "off");
  flag(root, "menuIcons", !a.menuIcons, "off");
  // "Use smaller indents in trees": `ui/Tree` reads the variable as its per-level indent.
  if (a.smallTreeIndents) root.style.setProperty("--tree-indent", SMALL_TREE_INDENT);
  else root.style.removeProperty("--tree-indent");
  root.dataset.aaIde = a.ideAntialiasing;
  root.dataset.aaEditor = a.editorAntialiasing;
  applyZoom(a.zoom, root);
  applyBackgroundImage(a.backgroundImage, root);
}

// ---------------------------------------------------------------------------
// Background image (IDEA: Appearance › Background Image): drawn over the workbench
// by `Workbench.module.css` from these variables, under dialogs and popups.

const FILLS = {
  scale: { size: "cover", repeat: "no-repeat" },
  plain: { size: "auto", repeat: "no-repeat" },
  tile: { size: "auto", repeat: "repeat" },
} as const;

const BG_VARS = ["--background-image", "--background-image-opacity", "--background-image-size"] as const;
const BG_LAYOUT_VARS = ["--background-image-repeat", "--background-image-position"] as const;

let bgPath = "";
let bgLoad = 0;

export function applyBackgroundImage(bg: BackgroundImageValid, root: HTMLElement = document.documentElement): void {
  if (!bg.path || bg.opacity === 0) {
    bgPath = "";
    bgLoad++;
    for (const name of [...BG_VARS, ...BG_LAYOUT_VARS]) root.style.removeProperty(name);
    return;
  }
  const fill = FILLS[bg.fill];
  root.style.setProperty("--background-image-opacity", String(bg.opacity / 100));
  root.style.setProperty("--background-image-size", fill.size);
  root.style.setProperty("--background-image-repeat", fill.repeat);
  root.style.setProperty("--background-image-position", bg.anchor.replace("-", " "));
  if (bg.path === bgPath) return;
  bgPath = bg.path;
  const load = ++bgLoad;
  root.style.removeProperty("--background-image");
  call(commands.fsReadImage(bg.path))
    .then((url) => {
      if (load === bgLoad) root.style.setProperty("--background-image", `url("${url}")`);
    })
    .catch((e) => {
      if (load === bgLoad) console.warn("cannot load the background image", e);
    });
}

/** Editor › Font › "Enable ligatures" also covers mono text outside the editor (Find results, Usages…). */
export function applyLigatures(raw: unknown, root: HTMLElement = document.documentElement): void {
  flag(root, "ligatures", editorPrefs(raw).ligatures);
}

let lastZoom = 100;

function applyZoom(percent: number, root: HTMLElement) {
  if (percent === lastZoom && (isTauri() || !root.style.zoom)) return;
  lastZoom = percent;
  if (isTauri()) {
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) => getCurrentWebview().setZoom(percent / 100))
      .catch((e) => console.warn("cannot set zoom", e));
  } else if (percent === 100) root.style.removeProperty("zoom");
  else root.style.setProperty("zoom", String(percent / 100));
}

// ---------------------------------------------------------------------------
// Zoom actions (IDEA: View › Appearance › Zoom IDE)

const ZOOM_STEPS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300];

export function nextZoom(current: number, direction: 1 | -1): number {
  const steps = direction > 0 ? ZOOM_STEPS : [...ZOOM_STEPS].reverse();
  const hit = steps.find((z) => (direction > 0 ? z > current : z < current));
  return Math.min(ZOOM_LIMITS.max, Math.max(ZOOM_LIMITS.min, hit ?? current));
}

async function setZoom(percent: number) {
  if (!isTauri()) {
    const settings = useProject.getState().settings;
    if (settings)
      useProject.setState({ settings: { ...settings, appearance: { ...settings.appearance, zoom: percent } } });
    else applyZoom(percent, document.documentElement);
    return;
  }
  const settings = await call(commands.settingsSet("global", "appearance.zoom", JSON.stringify(percent)));
  useProject.setState({ settings });
}

const currentZoom = () => validateSettings(useProject.getState().settings).appearance.zoom;

export function zoomActions(): Action[] {
  return [
    {
      id: "view.zoomIn",
      title: "Zoom In IDE",
      category: "View",
      keywords: ["zoom", "scale", "bigger", "accessibility"],
      run: () => setZoom(nextZoom(currentZoom(), 1)),
    },
    {
      id: "view.zoomOut",
      title: "Zoom Out IDE",
      category: "View",
      keywords: ["zoom", "scale", "smaller", "accessibility"],
      run: () => setZoom(nextZoom(currentZoom(), -1)),
    },
    {
      id: "view.resetZoom",
      title: "Reset IDE Zoom",
      category: "View",
      keywords: ["zoom", "scale", "100%", "accessibility"],
      run: () => setZoom(100),
    },
  ];
}

// ---------------------------------------------------------------------------
// View › Appearance toggles over boolean appearance settings (IDEA's ToggleActions)

type AppearanceFlag = "compactMode" | "showMainToolbar" | "showToolWindowBars" | "showStatusBar";

const appearanceFlag = (key: AppearanceFlag) => validateSettings(useProject.getState().settings).appearance[key];

const navigationBarPosition = (): NavigationBarPosition =>
  validateSettings(useProject.getState().settings).appearance.navigationBar;

function appearanceToggle(id: string, title: string, key: AppearanceFlag, keywords: string[]): Action {
  return {
    id,
    title,
    category: "View",
    keywords: ["appearance", ...keywords],
    toggled: () => appearanceFlag(key),
    run: async () => {
      if (!isTauri()) return;
      const next = !appearanceFlag(key);
      useProject.setState({
        settings: await call(commands.settingsSet("global", `appearance.${key}`, JSON.stringify(next))),
      });
    },
  };
}

export function appearanceToggleActions(): Action[] {
  return [
    appearanceToggle("view.toggleCompactMode", "Compact Mode", "compactMode", ["density", "smaller"]),
    appearanceToggle("view.toggleToolbar", "Toolbar", "showMainToolbar", ["main toolbar", "header", "hide"]),
    appearanceToggle("view.toggleToolWindowBars", "Tool Window Bars", "showToolWindowBars", [
      "stripes",
      "tool window buttons",
      "hide",
    ]),
    appearanceToggle("view.toggleStatusBar", "Status Bar", "showStatusBar", ["hide"]),
  ];
}

// ---------------------------------------------------------------------------
// View › Appearance › Navigation Bar: a radio choice (Top / Status Bar / hidden)

type NavigationBarPosition = "top" | "statusBar" | "hidden";

function navigationBarAction(id: string, title: string, position: NavigationBarPosition, keywords: string[]): Action {
  return {
    id,
    title,
    category: "View",
    keywords: ["appearance", "navigation bar", ...keywords],
    toggled: () => navigationBarPosition() === position,
    run: async () => {
      if (!isTauri()) return;
      useProject.setState({
        settings: await call(commands.settingsSet("global", "appearance.navigationBar", JSON.stringify(position))),
      });
    },
  };
}

export function navigationBarActions(): [Action, Action, Action] {
  return [
    navigationBarAction("view.navigationBarTop", "Top", "top", ["above editor", "menu bar"]),
    navigationBarAction("view.navigationBarStatusBar", "Status Bar", "statusBar", ["footer", "bottom"]),
    navigationBarAction("view.navigationBarHidden", "Don't Show", "hidden", ["hide", "breadcrumbs", "file path"]),
  ];
}

// ---------------------------------------------------------------------------
// Drag-and-drop with Alt pressed only (tool window buttons and editor tabs)

export function installAltDragGuard(enabled: () => boolean): () => void {
  setDragRequiresAlt(enabled);
  return () => setDragRequiresAlt(() => false);
}

// ---------------------------------------------------------------------------
// Save files if the IDE is idle for N seconds

const INPUT_EVENTS = ["keydown", "pointerdown", "wheel"] as const;

export function installIdleSave(config: () => { enabled: boolean; seconds: number }): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    const { enabled, seconds } = config();
    if (!enabled || !useProject.getState().project) return;
    // Only after input: an idle IDE with nothing typed has nothing to save.
    timer = setTimeout(() => void executeAction("file.save"), seconds * 1000);
  };
  for (const ev of INPUT_EVENTS) window.addEventListener(ev, arm, { capture: true, passive: true });
  return () => {
    clearTimeout(timer);
    for (const ev of INPUT_EVENTS) window.removeEventListener(ev, arm, { capture: true });
  };
}
