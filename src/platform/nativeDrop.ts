import { usePlatform } from "./platformInfo";
import { useProject } from "./project";
import { clampZoom } from "./zoom";

interface Point {
  x: number;
  y: number;
}

/** Wry Cocoa/GTK supply logical points; Win32 supplies physical client pixels.
 * WebView2's DPR includes zoom; WKWebView's does not. All consumers need CSS pixels.
 */
export function nativeDropPoint(
  point: Point,
  os = usePlatform.getState().os,
  dpr = window.devicePixelRatio || 1,
  zoom = clampZoom(useProject.getState().settings?.appearance?.zoom) / 100,
): Point {
  const divisor = os === "windows" ? dpr : zoom;
  return { x: point.x / divisor, y: point.y / divisor };
}
