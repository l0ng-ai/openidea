import { create } from "zustand";
import { commands, isTauri, type WindowButtonLayout } from "@/platform/ipc";

interface PlatformInfo {
  /** `macos` | `windows` | `linux` | `web`. */
  os: string;
  version: string | null;
  windowsBuildNumber: number | null;
  /** Native traffic lights overlay the title bar (Tauri, macOS, Overlay style). */
  overlayTitleBar: boolean;
  /** Frameless window: the title bar draws the main menu and caption buttons (Tauri, Windows and Linux). */
  framelessTitleBar: boolean;
  /** Linux on a Wayland display: GTK draws the frameless windows' shadow and resize edges. */
  wayland: boolean;
  /** Caption buttons per side of the frameless title bar, left to right (the desktop's layout on Linux). */
  windowButtons: WindowButtonLayout;
}

const DEFAULT_WINDOW_BUTTONS: WindowButtonLayout = { left: [], right: ["minimize", "maximize", "close"] };

/** OS from the user agent (before the backend answers, or in a browser). "darwin" must not read as Windows. */
export function guessOs(): "macos" | "windows" | "linux" | "web" {
  if (typeof navigator === "undefined") return "web";
  const ua = navigator.userAgent;
  if (/Mac|darwin/i.test(ua)) return "macos";
  if (/Windows|Win32|Win64/i.test(ua)) return "windows";
  if (/Linux/i.test(ua)) return "linux";
  return "web";
}

export const usePlatform = create<PlatformInfo>(() => {
  const os = guessOs();
  return {
    os,
    version: null,
    windowsBuildNumber: null,
    overlayTitleBar: isTauri() && os === "macos",
    framelessTitleBar: isTauri() && (os === "windows" || os === "linux"),
    wayland: false,
    windowButtons: DEFAULT_WINDOW_BUTTONS,
  };
});

let dataDir: Promise<string> | undefined;

/** The user data directory (scratches, plugins, Local History), which `OPENIDEA_DATA_DIR` can move. */
export function appDataDir(): Promise<string> {
  dataDir ??= commands.appInfo().then((info) => info.dataDir.replace(/\/+$/, ""));
  return dataDir;
}

export async function loadPlatformInfo() {
  if (!isTauri()) return;
  try {
    const info = await commands.appInfo();
    usePlatform.setState({
      os: info.platform,
      version: info.version,
      windowsBuildNumber: info.windowsBuildNumber,
      overlayTitleBar: info.platform === "macos",
      framelessTitleBar: info.platform === "windows" || info.platform === "linux",
      wayland: info.wayland,
      windowButtons: info.windowButtons ?? DEFAULT_WINDOW_BUTTONS,
    });
  } catch {
    /* keep the user-agent guess */
  }
}
