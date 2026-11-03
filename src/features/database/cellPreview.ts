export const CELL_PREVIEW_LIMIT = 1000;

/** Bound text layout without changing the underlying value or splitting a surrogate pair. */
export function cellPreview(value: string): string {
  if (value.length <= CELL_PREVIEW_LIMIT) return value;
  let end = CELL_PREVIEW_LIMIT;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return value.slice(0, end) + "\u2026";
}
