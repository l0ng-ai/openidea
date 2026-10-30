/** Image viewer zoom: IDEA-like steps, fit-to-window and wheel zoom. */

export const MIN_ZOOM = 1 / 32;
export const MAX_ZOOM = 64;
const STEP = 1.25;

export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** Next zoom step; snaps to 100% when crossing it so actual size is always reachable. */
export function stepZoom(zoom: number, dir: 1 | -1): number {
  const next = dir > 0 ? zoom * STEP : zoom / STEP;
  if ((zoom < 1 && next > 1) || (zoom > 1 && next < 1)) return 1;
  return clampZoom(next);
}

/** Largest zoom showing the whole image inside `availW × availH`. */
export function fitZoom(width: number, height: number, availW: number, availH: number): number {
  if (width <= 0 || height <= 0 || availW <= 0 || availH <= 0) return 1;
  return clampZoom(Math.min(availW / width, availH / height));
}

/** Initial zoom: actual size, unless the image does not fit. */
export function initialZoom(width: number, height: number, availW: number, availH: number): number {
  return Math.min(1, fitZoom(width, height, availW, availH));
}

export const zoomLabel = (zoom: number) => `${Math.round(zoom * 100)}%`;

/** Pan/zoom state: image top-left offset (px, relative to the canvas) and scale. */
export interface View {
  z: number;
  x: number;
  y: number;
}

/** Zoom to `z` keeping the image point under canvas position (px, py) fixed. */
export function zoomAt(v: View, z: number, px: number, py: number): View {
  const k = z / v.z;
  return { z, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
}
