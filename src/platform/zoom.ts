export const ZOOM_LIMITS = { min: 50, max: 300 } as const;

/** The IDE zoom in percent that a settings value applies as. */
export function clampZoom(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 100;
  return Math.min(ZOOM_LIMITS.max, Math.max(ZOOM_LIMITS.min, Math.round(value)));
}
