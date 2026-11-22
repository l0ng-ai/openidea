/** Red, green, blue 0–255 and alpha 0–1. */
export type Rgba = [number, number, number, number];

export const hex2 = (v: number) =>
  Math.round(Math.min(255, Math.max(0, v)))
    .toString(16)
    .padStart(2, "0");

/** `#rrggbb` of `rgba`, as `<input type=color>` takes it. */
export function toHex6([r, g, b]: Rgba): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

export function toHex8(rgba: Rgba): string {
  return `${toHex6(rgba)}${hex2(rgba[3] * 255)}`;
}

/** Six-digit hex is opaque; eight-digit hex carries its own alpha. */
export function fromHex(hex: string): Rgba | null {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(hex);
  return m
    ? [
        Number.parseInt(m[1]!, 16),
        Number.parseInt(m[2]!, 16),
        Number.parseInt(m[3]!, 16),
        m[4] ? Number.parseInt(m[4], 16) / 255 : 1,
      ]
    : null;
}

export function fromOpaqueHex(hex: string): Rgba | null {
  const digits = hex.replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(digits)) return fromHex(digits.replace(/./g, (digit) => digit + digit));
  return digits.length === 6 && /^[0-9a-f]+$/i.test(digits) ? fromHex(digits) : null;
}
