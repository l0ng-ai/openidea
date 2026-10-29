/**
 * Runtime side of Settings › Appearance and System Settings options that no
 * other feature owns: root attributes read by tokens / global CSS (compact
 * mode, contrast scrollbars, red-green palette, antialiasing, menu icons…),
 * the UI font, IDE zoom (+ ⌃⌥= / ⌃⌥- / ⌃⌥0 actions), "Drag-and-drop with Alt
 * pressed only" and "Save files if the IDE is idle".
 */
import { executeAction, type Action } from "@/platform/actions";
import { uiFontFamily } from "@/platform/fonts";
import { call, commands, isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { setDragRequiresAlt } from "@/ui";
import { ZOOM_LIMITS } from "./model/behaviorSchema";
import { DEFAULT_SETTINGS, validateSettings, type ValidSettings } from "./model/schema";

const FONT_VARS = [
  ["--fs-ui", 0],
  ["--fs-small", -1],
  ["--fs-tiny", -2],
] as const;

function flag(root: HTMLElement, name: string, on: boolean, value = "") {
  if (on) root.dataset[name] = value;
  else delete root.dataset[name];
}

/** Root attributes and CSS variables for the Appearance options. */
export function applyAppearanceOptions(s: ValidSettings, root: HTMLElement = document.documentElement): void {
  const a = s.appearance;
  // "Use custom font": family + size; otherwise the theme's.
  const size = a.useCustomFont ? a.uiFontSize : DEFAULT_SETTINGS.appearance.uiFontSize;
  for (const [name, delta] of FONT_VARS) {
    if (size === DEFAULT_SETTINGS.appearance.uiFontSize) root.style.removeProperty(name);
    else root.style.setProperty(name, `${size + delta}px`);
  }
  if (a.useCustomFont) root.style.setProperty("--font-ui", uiFontFamily(a.uiFontFamily));
  else root.style.removeProperty("--font-ui");

  flag(root, "compact", a.compactMode);
  flag(root, "contrastScrollbars", a.contrastScrollbars);
  flag(root, "redGreen", a.redGreenVision);
  flag(root, "toolWindowBg", a.differentToolWindowBackground, "different");
  flag(root, "projectColors", !a.projectColorsInToolbar, "off");
  flag(root, "menuIcons", !a.menuIcons, "off");
  root.dataset.aaIde = a.ideAntialiasing;
  root.dataset.aaEditor = a.editorAntialiasing;
  applyZoom(a.zoom, root);
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
    {
      // View › Appearance › Compact Mode (Settings › Appearance › "Compact mode").
      id: "view.toggleCompactMode",
      title: "Compact Mode",
      category: "View",
      keywords: ["appearance", "density", "smaller"],
      toggled: () => validateSettings(useProject.getState().settings).appearance.compactMode,
      run: async () => {
        if (!isTauri()) return;
        const next = !validateSettings(useProject.getState().settings).appearance.compactMode;
        useProject.setState({
          settings: await call(commands.settingsSet("global", "appearance.compactMode", JSON.stringify(next))),
        });
      },
    },
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
