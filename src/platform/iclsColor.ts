/**
 * An `.icls` colour value as IntelliJ reads it (`ValueElementReader.toColor`): six or eight hex digits
 * (`RRGGBB`, `RRGGBBAA`), with or without a leading `#` or `0x`, else a hex number with its leading zeros
 * dropped (`"0"` is black, `"ff"` is `#0000ff`). Returns lower-case `#rrggbb` / `#rrggbbaa`.
 */
export function iclsColor(value: string | null | undefined): string | undefined {
  const v = value?.trim().toLowerCase();
  if (!v) return undefined;
  const full = /^(?:#|0x)?([0-9a-f]{6}|[0-9a-f]{8})$/.exec(v);
  if (full) return `#${full[1]}`;
  return /^[0-9a-f]{1,5}$/.test(v) ? `#${v.padStart(6, "0")}` : undefined;
}
