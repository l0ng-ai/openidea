import { create } from "zustand";
import { commands, isTauri } from "@/platform/ipc";

interface PlatformInfo {
  /** `macos` | `windows` | `linux` | `web`. */
  os: string;
  version: string | null;
  /** Native traffic lights overlay the title bar (Tauri, macOS, Overlay style). */
  overlayTitleBar: boolean;
  /** Frameless window: the title bar draws the main menu and caption buttons (Tauri, Windows and Linux). */
  framelessTitleBar: boolean;
}

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
    overlayTitleBar: isTauri() && os === "macos",
    framelessTitleBar: isTauri() && (os === "windows" || os === "linux"),
  };
});

export async function loadPlatformInfo() {
  if (!isTauri()) return;
  try {
    const info = await commands.appInfo();
    usePlatform.setState({
      os: info.platform,
      version: info.version,
      overlayTitleBar: info.platform === "macos",
      framelessTitleBar: info.platform === "windows" || info.platform === "linux",
    });
  } catch {
    /* keep the user-agent guess */
  }
}
